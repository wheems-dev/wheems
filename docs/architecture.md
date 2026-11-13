# Architecture

Wheems is a small TypeScript service that's always running, a command agents call, and a
folder of config, with Herdr core underneath.

Messages from Slack or Telegram reach the service, which routes them to the right
workspace's agent through Herdr: one conversation, and one engine session, per chat thread. A
thread's later messages go to the same session, and a session that has ended is resumed. The
service posts each answer, read from the engine's own record of the conversation, and agents
send progress notes, ask for approval or leave notes by running the CLI, which talks to the
service over a private Unix socket.

**Why TypeScript on Node.** Claude Code and Codex already need Node on every agent machine,
so it adds no new runtime. Slack's main Bolt library and the main Claude Agent SDK are both
TypeScript first.

## The parts

- **The service**: always running, under launchd on a Mac and systemd on Linux. It holds the
  channel connections and routes messages. It also runs approvals, thread sessions and
  workflows, and keeps a small SQLite file of what's waiting.
- **The CLI**, `wheems`: what users and agents run, for example `wheems post updates "…"`,
  `wheems ask approvals "Deploy?"` and `wheems note`. It replaces hand-written scripts and
  hard-coded channel IDs.
- **Config**: YAML and Markdown in a git folder. Adding an agent, channel or workflow means
  editing config, not code. See [config.md](config.md).
- **Built-in skills**: Markdown that teaches every agent the CLI.

## Herdr core as a dependency

- Wheems depends on Herdr core (`hc`), not the Herdr desktop app, which is optional.
- Every `hc` call goes through one module, `src/drivers/runtime/herdr/hc.ts`, so a change in
  Herdr means fixing one file. A lint rule stops any other module from starting processes.
- The runtime driver checks `hc --version` and refuses to run below the version it was tested
  with. See [herdr.md](herdr.md).
- It reads Herdr's JSON output, never screen text.
- Herdr stays a separate install that `wheems setup` manages.

## Installing on a new machine

```bash
npm install -g wheems   # the same way Claude Code is installed; the command is wheems
wheems setup            # installs the pinned Herdr core, asks for channel tokens,
                       # writes config, installs the service, runs doctor
wheems init acme        # creates a workspace
wheems doctor           # health check, any time
```

The user types channel tokens in themselves. They're saved to a private file on that machine
and never pass through an agent.

## On disk

```text
~/wheems/
├── install.yaml          machines, connections, accounts, Herdr version
├── about-you.md          about you; every agent in every workspace reads it
├── library/              agent templates, skills, workflow templates (never loaded directly)
└── workspaces/
    └── acme/
        ├── workspace.yaml    chief of staff, channels, rules, accounts
        ├── agents/           one Markdown file per agent
        ├── skills.yaml       chosen skills and pinned versions
        ├── workflows/        one YAML file per workflow
        ├── projects/         one file per project: folder, space, agents, rules
        ├── .claude/          this workspace's own Claude Code config
        └── knowledge/
            ├── brief.md      short, capped; every agent here loads it at launch
            ├── inbox/        notes land here, from wheems note
            ├── notes/        filed notes, kept as the sources
            ├── pages/        the knowledge base, one topic per page
            └── reports/      nightly: contradictions and stale pages
```

Running state, never committed, lives in `.wheems/`: the control socket, logs, conversations, the
filer's working copies and the search indexes (`.wheems/index/`).

Agents never write into `knowledge/` or `about-you.md` themselves. They write notes with
`wheems note`, and the service saves each note to its workspace's inbox with where it came from:
workspace, agent, engine, conversation and time. When a conversation has been quiet for
`knowledge.note_after_idle` minutes after new work, and before the service stops an idle session
to make room, the service asks the agent for its note as a turn of its own. The answer to that
turn is never posted. Each agent's instructions file carries the brief and `about-you.md`, as they
were when its session started.

When a note lands, and for any notes waiting when the service starts, the **filer** files it.
The filer is a built-in agent, one note at a time per workspace, running in Herdr like any other
(named `filer-<workspace>`). It works on a copy of the knowledge base in
`.wheems/filing/<workspace>/`: the note, the brief, every page, and `about-you.md` to read. Wheems
then checks every change in code before it reaches the real knowledge base:

- a page keeps at least three quarters of its text, has a name of lowercase words and dashes,
  and holds nothing that looks like a credential;
- every page changed lists the note among its `sources`, and keeps the sources it had;
- pages are never deleted;
- the brief stays under 4,000 characters;
- anything else the filer wrote is ignored.

Wheems writes the changes that pass, moves the note to `notes/<year>/<month>/`, and commits those
paths, and only those, in the install's git folder as "Wheems". A suggested change to
`about-you.md` waits in `.wheems/review/about-you/` for you to approve it. If a page or the brief changed while the filer
worked, such as an edit by hand, nothing is applied and the note is filed again from the new
version, so an edit is never overwritten. A note the filer can't file stays in the inbox and is
tried again; after three failed tries, it waits until the service restarts.

Nothing that looks like a password, token or key is kept: `wheems note` refuses such a note, a
note that reaches the inbox anyway is moved to `.wheems/quarantine/<workspace>/` and never filed or
committed, and pages and the brief that hold one are not kept.

### Searching the knowledge base

Agents search before answering about past work: `wheems kb search "what did we decide about the
boat name"`, run in their session, searches their own workspace's pages and notes (filed and in
the inbox). Their built-in instructions tell them to.

- **By keyword**, always: SQLite's full-text search, built into Node.js, so it needs nothing
  installed.
- **By meaning** too, when install.yaml names an embeddings driver (`knowledge.embeddings`), such
  as Ollama with `nomic-embed-text`, which runs on the machine for free. `wheems setup`
  (Knowledge) sets it up and offers to download the model.
- The two rankings are combined by reciprocal rank fusion, and each file is represented by its
  best passage. A match by meaning alone is kept only if it is close to the best one and above
  the model's floor, so a question the knowledge base can't answer doesn't come back with its
  least unrelated pages.
- Notes from automated jobs (`origin: automated`) rank at half the score of people's own work,
  and so do pages built only from such notes.

Files are split into passages of whole paragraphs, up to 1,200 characters, starting afresh at a
heading. Each passage is indexed for keywords, and embedded with its file's title in front.
Three kinds of file are left out, and logged once: links, which could point anywhere on the
machine; files over 1 MB; and anything that looks like it holds a credential, which is never
stored in the index or sent to an embeddings service.

The index is running state in `.wheems/index/`, never committed and rebuildable from the files at
any time. Each workspace has its own, built in generations: `<generation>.sqlite` holds the text,
a vector collection named `<workspace>.<generation>` holds the vectors (with the built-in SQLite
store, in `.wheems/index/_vectors/`), and `current.json` says which generation is in use and what
model built it. The service brings it up to date when it starts, after each note is filed, and
every ten minutes for edits by hand; only files whose size, time or content changed are read
again, and only their passages embedded again.

`wheems kb reindex` builds a new generation from the files and swaps it in when it's done, so
search keeps working meanwhile. A search already running keeps the old generation until it finishes,
and one that finds it gone tries again on the new one. Until an index built with another model
is rebuilt, search uses keywords only. If the vector store holds fewer vectors than the index
expects, such as after its files were lost, the next sync embeds everything again. If the service is running, it does the rebuild, so the two never
write at once. The index rebuilds itself the same way when the embeddings driver or model
changes, because vectors from different models can't be compared. If the embeddings driver can't
be reached, such as when Ollama isn't running, new passages are found by keyword until it can
be, a search says it fell back to keywords, and a rebuild keeps the index it has rather than
lose its vectors. `wheems doctor` checks the driver and each workspace's index.

`WHEEMS_HOME` moves the install folder.

## Engines, models and accounts

Every agent names an engine (the CLI it runs in), a model and the account that pays. Herdr
runs any terminal program, so Wheems never builds its own agent CLI.

| Engine      | What it is                                      | Models                                      | Paid through                       |
| ----------- | ----------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| Claude Code | Anthropic's coding CLI                          | Claude                                      | Claude subscription or API key     |
| Codex       | OpenAI's coding CLI                             | OpenAI                                      | ChatGPT subscription or API key    |
| opencode    | Open-source coding CLI not tied to one provider | Any, including Grok, Gemini, DeepSeek, Qwen | OpenRouter or a provider's own key |

OpenRouter is an API, not a CLI: one account and key with pay-as-you-go access to hundreds of
models. Paired with opencode, it covers any model without a separate subscription for each.

**Engine drivers.** One small module per engine turns a single agent definition into what that
engine expects: how to start it with a model, its instructions file (`CLAUDE.md` for Claude
Code, `AGENTS.md` for Codex and opencode), its skills, its permissions and its MCP servers.
Each driver also declares what its engine supports, so doctor can say what won't work.

**Accounts and usage limits**

- Accounts are connected once, at install level. Each workspace chooses which ones it may use.
- Heavy daily agents, such as the chief of staff and the developer, run on flat subscriptions.
- Occasional or specialist agents run through OpenRouter and pay per token.
- Each workspace can have its own OpenRouter key with a credit limit, so one workspace can't
  use up everything.

A model isn't a connection to a service. A Grok agent for X can write posts but can't publish
them. Posting and reading mentions need the X API. That's an integration the agent uses,
whatever its model.

## Integrations

Every outside service is an integration: GitHub, Google, Linear, Stripe, a database. Each is
connected once and given to workspaces and agents with the same three-level pattern as skills.

**One pattern for everything that's shared.** Skills, integrations and accounts all work the
same way: the install holds everything that's connected, a workspace picks what it may use,
and each agent picks from the workspace's set. It also keeps context small: MCP tool lists
bloat an agent's context the same way skill lists do.

An integration can provide an MCP server (local or remote), a CLI such as `gh`, skills that
teach agents to use it well, and a connect flow (OAuth in the browser, or a token the user
types in).

- `wheems connect github` runs the connect flow, and the credential goes into Wheems's secret
  store, never into an agent's config.
- `wheems grant github acme` lets a workspace use it, read-only or full where the integration
  supports it.
- The agent's engine driver writes the MCP config each engine expects.
- `wheems doctor` checks that each granted integration still answers and its credential hasn't
  expired.

**Integrations go through the broker.** By default, agents reach MCP servers through Wheems's
own MCP server, not directly. It hands each agent only the tools it's been granted, checks the
workspace's rules, asks for approval where a rule says so, and logs every call. The agent never
holds the token. Read-only, low-risk integrations can be marked as direct to skip the hop.

## Guardrails that work with any engine

Anything that matters is enforced outside the agent, at a point every engine has to pass
through. An engine's own hooks are a convenience that refuses early, never the guardrail
itself: hooks written for Claude Code are ignored by Codex and opencode.

| Layer                | How it works                                                                                                                              | Covers every engine                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1. No credential     | The agent never holds the key, so it can't act, whatever it tries                                                                         | Yes                                    |
| 2. The broker        | Risky actions are Wheems commands. The broker holds the credentials, checks the rules, asks for approval if needed, then acts and logs it | Yes, through the CLI and an MCP server |
| 3. Server-side rules | GitHub rulesets and required status checks, which no local tool can get round                                                             | Yes                                    |
| 4. Machine level     | Git hooks installed outside the agent's reach, file permissions, a sandbox or separate user per workspace                                 | Yes                                    |
| 5. Engine hooks      | Each driver writes the same rules into its engine's own hooks and permission settings, where it has them                                  | Best effort                            |
| 6. Instructions      | The agent is told the rule                                                                                                                | Guidance only                          |

**The broker is the key piece.** Agents never get deploy keys, mail access or channel tokens.
They ask Wheems, for example `wheems do deploy storefront --to staging`. The broker looks up the
workspace's rules, and either acts, asks in `approvals` and waits, or refuses with a reason.

**Rules are written once, in one format.** Wheems turns each rule into every layer that can
enforce it: a GitHub ruleset, a broker policy, a git hook and, where supported, each engine's
own hooks. Doctor shows what each rule actually rests on, per engine. A rule that rests only on
instructions is shown as a warning, so nobody believes a guardrail exists when it doesn't.

```yaml
# workspaces/acme/workspace.yaml
rules:
  - name: release-hold
    project: storefront
    deny: { push: [main, develop], deploy: [production] }
  - name: review-before-merge
    require: { review: reviewer, before: merge }
  - name: deploys-need-approval
    action: deploy
    approval: approvals
```

Still to work out: sandboxing on macOS (Linux has containers and bubblewrap); whether reviews
always go through a required GitHub check or the broker also gates opening a pull request; and
how strict version one is (a sensible start is layers 1 to 4 for anything irreversible, and
layer 5 wherever an engine supports it).
