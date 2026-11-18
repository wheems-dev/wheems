# Drivers and plugins

Every extension point is a driver, as in Laravel: a small, documented contract with built-in
drivers behind it. Adding Discord, Gemini CLI or Notion means writing one driver, not changing
the core.

| Driver type  | What it does                                                        | Version one ships                                                                           | Later or by plugin                         |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Runtime      | Starts, sends to, reads and waits on agent sessions                 | Herdr core                                                                                  | Plain sessions without Herdr               |
| Engine       | Runs an agent in a given CLI                                        | Claude Code, Codex, opencode                                                                | Gemini CLI, others                         |
| Channel      | Sends and receives messages, buttons and threads                    | Slack, Telegram, email                                                                      | Teams, Discord                             |
| Integration  | Connects an outside service: MCP, CLI, skills, connect flow, events | Email, a reviews service, search analytics, GitHub                                          | Google, Linear, Stripe, Notion, X          |
| Account      | Pays for models; API-key accounts also serve model steps            | Claude, ChatGPT, OpenRouter, Anthropic's API                                                | Other provider API keys                    |
| Trigger      | Starts a routine or a workflow                                      | Time, channel message, file landing, integration event (polled, or a webhook where offered) | Others by plugin                           |
| Step         | Does one thing in a workflow                                        | Agent task, model step, classify, call an integration, ask for approval, post               | Shell and HTTP steps                       |
| Isolation    | Separates workspaces                                                | Separate settings                                                                           | Container, separate user, separate machine |
| Secret store | Holds credentials; agents never see their values                    | macOS Keychain, Linux secret service, an encrypted file for headless servers                | 1Password                                  |
| Embeddings   | Turns text into vectors for searching by meaning                    | A model run locally                                                                         | OpenAI, Voyage and other hosted services   |
| Vector store | Keeps vectors and finds the nearest                                 | SQLite                                                                                      | Postgres with pgvector, Pinecone           |
| Database     | Holds blueprint data                                                | SQLite, Postgres                                                                            | MySQL                                      |
| Voice        | Holds a phone call with an agent                                    | None                                                                                        | Phone and voice providers                  |
| Desktop      | Gives an agent a GUI machine to use (computer use)                  | None                                                                                        | X11 on Linux, first after version one      |
| Card issuer  | Mints single-use cards for one merchant and amount                  | None (you pay, or billing APIs)                                                             | Issuers with an API                        |

Email is a channel like any other, with a driver per mail provider (such as AgentMail, Resend,
or IMAP and SMTP), so an agent can have its own address. A phone call is live and an agent
takes minutes to answer, so voice needs its own contract: a fast voice model holds the call and
hands work to the agent.

Milestone 0 defines the **runtime**, **engine** and **channel** contracts and ships the Herdr
runtime driver. Milestone 2 adds **embeddings** and **vector store** (built). The rest arrive with
the milestones that need them: API-key accounts in 5; triggers, steps and the first business
integrations in 7; the database in 8; integrations in general and the secret store in 9; desktop
after version one ([roadmap](roadmap.md)).

**Not a new engine.** Computer use is a tool given to an existing engine through the broker, and
a lightweight model step is a call on an account, not an agent: an engine is only for a different
agent program.

## The contracts

The contracts are TypeScript interfaces in [`src/contracts/`](../src/contracts/). Every driver
has a `kind` and a `name`, reports `check()` health checks for `wheems doctor`, and throws
`DriverError` with one of a fixed set of kinds (`not_found`, `unsupported`, `unavailable`,
`version`, `blocked`, `invalid`, `failed`) so callers can react the same way whatever the
driver.

### Runtime ([`runtime.ts`](../src/contracts/runtime.ts))

A session is one long-lived terminal program, usually an agent CLI.

| Method                                                | What it does                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `start({ name, command, cwd, env, labels, machine })` | Starts a program in a new session and returns at once.                                                        |
| `send(session, text, { wait, ifStatus })`             | Types text and presses Enter. `blocked` when a person is needed first.                                        |
| `read(session, { lines })`                            | The screen, plus history above it when asked.                                                                 |
| `wait(session, { timeoutSeconds, output })`           | Until it stops working or exits, or prints `output`. A timeout is a check-in (`ended: false`), not a failure. |
| `get(session)` / `list({ labels })`                   | One session by id or name (`null` when there is none), or live sessions.                                      |
| `stop(session)` / `remove(session)`                   | Ends its program; removes a finished session.                                                                 |
| `agentSkill()` (optional)                             | A skill for agents running in it, from its own manual, with the rule every session always loads; or `null`.   |

### Engine ([`engine.ts`](../src/contracts/engine.ts))

An engine driver turns one agent definition into a **launch plan**: the command that starts it
with a model, the environment, and the files to write (its instructions, and later its
permissions and MCP config). It never touches the disk or starts a process itself; the framework
writes the files and starts the command through the runtime driver. It declares its
`capabilities` (`instructionsFile`, `skills`, `skillsFolder`, `mcp`, `hooks`, `permissions`,
`resume`), so doctor can say what won't work.

Every engine gets `AGENTS.md` with the agent's whole instructions, from `instructionsFiles` in
`src/drivers/engine/instructions.ts`. An engine whose `instructionsFile` is another file, as
Claude Code's `CLAUDE.md` is, gets that file too, holding `@AGENTS.md`; the contract tests check
it. The framework writes Wheems's skills into `skillsFolder` (such as `.claude/skills` or
`.agents/skills`) at every launch, each as `<name>/SKILL.md`. See
[instructions.md](instructions.md).

Each launch is for one conversation: the context carries its `session` (a stable UUID, whether
to `resume` it, the first `task`, and the engine's own id once known), and the agent carries its
`permissions` level. Engines that choose their own session ids (Codex, opencode) offer
`findSession`, which finds the session they started from its folder, start time and first
message; the service keeps that id with the conversation and resumes by it. An engine that
can't take a message on its command line in some case (opencode, when resuming) returns it as
the plan's `typeAfterStart`, and the service types it in once the program has started.

Engines declare whether they report their `status` (working, done, blocked) to the runtime.
Claude Code and Codex do, so the service follows each turn by status; opencode doesn't under
Herdr core, so the service follows its turns by its answers instead. An engine
can also offer `answers(session, after)`, the agent's answer to each turn after a given one, read from
the engine's own structured record (for Claude Code, its session transcript), never the screen.
With it, the service posts each answer for the agent.

### Channel ([`channel.ts`](../src/contracts/channel.ts))

A channel driver holds one connection, such as one Slack app. `start(handler)` delivers inbound
messages and button presses; `send()` posts, optionally in a thread and with buttons; `stop()`
disconnects; `react()` marks a message, such as 👀 while an agent works on it. Inbound messages
say whether they are `direct` messages. Drivers declare whether they support `threads`,
`buttons`, `reactions` and `identities` (posting under a per-workspace name and icon); a driver
without buttons or reactions refuses them with `unsupported` rather than dropping them silently,
and one without identities ignores them. To keep a conversation together, reply in
`replyThread(event)`. A message may name people to `mentions`, such as the person an approval
waits for, and the driver mentions them in its own way. The optional `update(message, change)`
changes a post in place, its text and buttons, as an approval's post does once it's answered; a
driver without it gets a reply under the post instead. A button's `id` comes back on its press,
and is all Wheems needs: approvals carry only their id and the choice. On a channel without
buttons, the person answers an approval in words, as `approve a1b2c3`.

The Slack driver sends buttons as an `actions` block and mentions as a section under the post's
Markdown, takes presses from Socket Mode's `interactive` envelopes (`block_actions`), and changes
posts with `chat.update`. Its manifest has always turned interactivity on; a Slack app set up by
hand needs **Interactivity** switched on in its settings, or presses never arrive.

Milestone 1 ships the Slack driver (Socket Mode, so no public address) and the engine drivers for
Claude Code, Codex and opencode. Each engine also brings its setup steps (`EngineSetup`): how to
install it, sign in, and check that it trusts a folder.

### Embeddings ([`embeddings.ts`](../src/contracts/embeddings.ts))

`embed(texts, purpose)` returns one vector per text, all the same length. `purpose` is
`document` or `query`, for models that embed the two differently: the Ollama driver marks them
for nomic-embed-text, which needs it. The driver names its `model`, and the search index is
rebuilt when it changes, since vectors from different models can't be compared. A driver may set
`minimumSimilarity`, the score below which a match by meaning alone isn't shown, because every
model scores unrelated text differently. It throws `unavailable` when the service behind it
can't be reached, and search falls back to keywords.

Milestone 2 ships **Ollama** (`nomic-embed-text` by default, at `http://127.0.0.1:11434`). With
no embeddings driver set up, search is keyword-only. An embeddings driver can bring its setup
steps (`EmbeddingsSetup`): the models it has, how to download one, and how to install it.

### Vector store ([`vector-store.ts`](../src/contracts/vector-store.ts))

A store holds named collections. `open(name)` creates or opens one, and `drop(name)` removes it.
A collection takes `upsert` (vectors by id, replacing any with the same id), `remove`, `count`,
`clear`, and `nearest(vector, k)`, which returns the `k` most similar by cosine, most similar
first. Every vector in a collection has the same length; one of another length is refused with
`invalid`.

Milestone 2 ships **SQLite**, which keeps each collection in a file and compares every vector in
code: a few milliseconds for thousands of pages, with nothing to install.

## Contract tests

Each driver type ships a test suite that any driver of that type must pass, published as
`wheems/testing`. A plugin written by an agent, by you or by a stranger is checked against the
same contract before it's switched on. The suites use Bun's test runner, [`bun test`](https://bun.com/docs/cli/test).

```ts
// my-runtime.test.ts
import { runtimeContract } from 'wheems/testing';
import { MyRuntime } from './my-runtime.js';

runtimeContract('my-runtime', { create: () => new MyRuntime() });
```

```ts
import {
  channelContract,
  embeddingsContract,
  engineContract,
  vectorStoreContract,
} from 'wheems/testing';

engineContract('gemini', {
  create: () => new GeminiEngine(),
  model: 'gemini-3-pro',
  accountDriver: 'google',
});

embeddingsContract('voyage', { create: () => new VoyageEmbeddings(testKey) });
vectorStoreContract('pgvector', { create: () => new PgVectorStore(testDatabaseUrl) });

channelContract('discord', {
  create: () => new DiscordChannel(testCredentials),
  channel: testChannelId,
  simulateMessage: (driver, message) => postAsTestUser(message),
  simulateButton: (driver, press) => pressAsTestUser(press),
});
```

`wheems/testing` also exports in-memory reference drivers: `MemoryRuntime` (simulated programs),
`MemoryChannel` (messages kept in memory), `StubEngine`, `HashEmbeddings` (words hashed into a
small vector, with synonyms to stand in for meaning) and `MemoryVectorStore`. The suites run against them in this
repository's own tests, and later milestones use them to test the service without Herdr or
Slack.

## Plugins

A plugin is a package of drivers and content: any mix of drivers, skills, agent templates and
workflow templates. It's distributed through npm. `wheems plugin add <package>` installs it, and
Wheems discovers what's inside automatically. Each plugin has a manifest declaring what it adds
and what it needs: credentials, network access and which commands it runs. That makes it
reviewable before it's switched on.

**Wheems knows itself.** Every chief of staff gets a built-in skill describing the framework: its
concepts, its CLI, the driver contracts and how a plugin is laid out. Scaffolding commands work
like Laravel's `artisan make:`:

```bash
wheems make:plugin linear
wheems make:driver channel discord
wheems make:skill weekly-report
wheems make:workflow invoice-chase
```

So "Can you make a plugin for Linear?" works the way "create me a workflow" does: the chief of
staff scaffolds it, fills in the driver against the contract and writes its skills; runs the
driver's contract tests and doctor; a reviewer agent checks the code, using a different provider
where possible; and you approve in `approvals`. Only then is it switched on, and only for that
workspace. An agent can propose a plugin itself, but can't install one without that approval,
because a plugin is code that runs with credentials.
