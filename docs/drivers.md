# Drivers and plugins

Every extension point is a driver, as in Laravel: a small, documented contract with built-in
drivers behind it. Adding Discord, Gemini CLI or Notion means writing one driver, not changing
the core.

| Driver type  | What it does                                                | Version one ships                    | Later or by plugin                         |
| ------------ | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| Runtime      | Starts, sends to, reads and waits on agent sessions         | Herdr core                           | Plain sessions without Herdr               |
| Engine       | Runs an agent in a given CLI                                | Claude Code, Codex, opencode         | Gemini CLI, others                         |
| Channel      | Sends and receives messages, buttons and threads            | Slack, Telegram                      | Teams, Discord, email                      |
| Integration  | Connects an outside service: MCP, CLI, skills, connect flow | GitHub                               | Google, Linear, Stripe, Notion, X          |
| Account      | Pays for models                                             | Claude, ChatGPT, OpenRouter          | Direct provider API keys                   |
| Trigger      | Starts a workflow                                           | Time, channel message, file landing  | Webhook, email received                    |
| Step         | Does one thing in a workflow                                | Run an agent, ask for approval, post | Wait for an event, call an integration     |
| Isolation    | Separates workspaces                                        | Separate settings                    | Container, separate user, separate machine |
| Secret store | Holds credentials                                           | An encrypted file                    | macOS Keychain, 1Password                  |

Milestone 0 defines the **runtime**, **engine** and **channel** contracts and ships the Herdr
runtime driver. The other contracts arrive with the milestones that need them.

## The contracts

The contracts are TypeScript interfaces in [`src/contracts/`](../src/contracts/). Every driver
has a `kind` and a `name`, reports `check()` health checks for `opinr doctor`, and throws
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

### Engine ([`engine.ts`](../src/contracts/engine.ts))

An engine driver turns one agent definition into a **launch plan**: the command that starts it
with a model, the environment, and the files to write (its instructions file, and later its
skills, permissions and MCP config). It never touches the disk or starts a process itself; the
framework writes the files and starts the command through the runtime driver. It declares its
`capabilities` (`instructionsFile`, `skills`, `mcp`, `hooks`, `permissions`, `resume`), so doctor
can say what won't work.

Each launch is for one conversation: the context carries its `session` (a stable UUID, whether
to `resume` it, and the first `task`), and the agent carries its `permissions` level. An engine
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
`replyThread(event)`.

Milestone 1 ships the Slack driver (Socket Mode, so no public address) and the Claude Code engine
driver.

## Contract tests

Each driver type ships a test suite that any driver of that type must pass, published as
`@opinr/hq/testing`. A plugin written by an agent, by you or by a stranger is checked against the
same contract before it's switched on. The suites use [Vitest](https://vitest.dev).

```ts
// my-runtime.test.ts
import { runtimeContract } from '@opinr/hq/testing';
import { MyRuntime } from './my-runtime.js';

runtimeContract('my-runtime', { create: () => new MyRuntime() });
```

```ts
import { engineContract, channelContract } from '@opinr/hq/testing';

engineContract('gemini', {
  create: () => new GeminiEngine(),
  model: 'gemini-3-pro',
  accountDriver: 'google',
});

channelContract('discord', {
  create: () => new DiscordChannel(testCredentials),
  channel: testChannelId,
  simulateMessage: (driver, message) => postAsTestUser(message),
  simulateButton: (driver, press) => pressAsTestUser(press),
});
```

`@opinr/hq/testing` also exports in-memory reference drivers: `MemoryRuntime` (simulated programs),
`MemoryChannel` (messages kept in memory) and `StubEngine`. The suites run against them in this
repository's own tests, and later milestones use them to test the service without Herdr or
Slack.

## Plugins

A plugin is a package of drivers and content: any mix of drivers, skills, agent templates and
workflow templates. It's distributed through npm. `opinr plugin add <package>` installs it, and
Opinr discovers what's inside automatically. Each plugin has a manifest declaring what it adds
and what it needs: credentials, network access and which commands it runs. That makes it
reviewable before it's switched on.

**Opinr knows itself.** Every chief of staff gets a built-in skill describing the framework: its
concepts, its CLI, the driver contracts and how a plugin is laid out. Scaffolding commands work
like Laravel's `artisan make:`:

```bash
opinr make:plugin linear
opinr make:driver channel discord
opinr make:skill weekly-report
opinr make:workflow invoice-chase
```

So "Can you make a plugin for Linear?" works the way "create me a workflow" does: the chief of
staff scaffolds it, fills in the driver against the contract and writes its skills; runs the
driver's contract tests and doctor; a reviewer agent checks the code, using a different provider
where possible; and you approve in `approvals`. Only then is it switched on, and only for that
workspace. An agent can propose a plugin itself, but can't install one without that approval,
because a plugin is code that runs with credentials.
