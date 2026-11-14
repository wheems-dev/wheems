# Changelog

Wheems follows [semantic versioning](https://semver.org). While it's 0.0.x, any release may
change anything, including commands and config formats, without a migration path.

## Unreleased

**Added**

- `wheems start`, `stop`, `restart`, `status` and `logs` look after the background service. `stop`
  keeps it stopped, even after you log in again, until `wheems start`. `status` shows the version,
  how long it has been up, and where each workspace chats, with what stops one from chatting (a
  channel the app can't see or isn't in). `logs -f` keeps following the log. They're also under
  `wheems service`, which keeps `install`, `uninstall` and `run`.
- Leaving `wheems setup` with a chat channel and no service running asks whether to start it,
  rather than leaving messages to go unanswered.

**Changed**

- Claude Code and Codex are asked to trust the install folder once, instead of each workspace's
  folder. A trusted folder covers the folders in it, so this covers every workspace, including
  ones added later. Setup and `wheems init` skip the question when the engine already trusts it,
  and doctor's advice says the same.
- When a message arrives for an engine that doesn't trust the folder, the service says so in the
  thread at once, with the command to run, instead of starting a session that waits at the Mac
  and saying so 90 seconds later.
- `wheems restart` installs the service again, so it picks up a new copy of Wheems or Node.js
  as well as new config, and waits until it answers.

**Fixed**

- Under launchd, the service took about ten seconds to start, because launchd throttles the CPU
  and disk of a job that doesn't say what kind it is. It now runs as an interactive job and starts
  in about a second. `wheems start` waits up to 30 seconds and, if it still doesn't answer, prints
  the end of its log.
- With nvm, the message for a Node.js too old for Wheems says how to make Node 22 the default.

## 0.0.3

A new look for the cloud in the terminal, and clearer help when a Slack token is wrong. Still an
early preview: not ready for real use. The first release published from GitHub.

**Changed**

- The cloud on the welcome screen and in `wheems setup` is now the mascot's outline, with its eye
  and smile, instead of a solid shape whose face got lost. It's drawn in the terminal's text colour
  (white on a dark terminal, near-black on a light one) rather than blue. It's left out when the
  output isn't a terminal (piped or saved to a file) and when the terminal is narrower than 53
  columns, so only the name, tagline and status are shown.
- The cloud winks once when it appears, in an interactive terminal. Set `WHEEMS_NO_ANIMATION` to
  stop it; it never winks in CI, in a dumb terminal, or when the output isn't a terminal.

**Fixed**

- When a pasted Slack token isn't right, setup says why instead of only "The bot token starts with
  xoxb-": the app-level token pasted for the bot token (or the other way round), a user or refresh
  token, two pastes run together, something in front of the token, or a space in it, each with
  where in Slack to find the right one. It names tokens only by their standard prefix.

## 0.0.2

Fixes from the first preview, a welcome screen, and checks that catch common set-up problems.
Still an early preview: not ready for real use.

**Added**

- `wheems` on its own shows a welcome screen: the cloud from the brand kit, in blue, beside the
  name and "Your crew, ready for work.", then how the install is doing (workspaces and agents,
  the service, search, and anything waiting for review). `wheems setup` opens with the cloud too.
- `wheems init` creates the install when there isn't one, so setup can be scripted from a fresh
  machine (connecting Slack still needs `wheems setup`).
- `wheems doctor` checks that Claude Code is signed in (`claude auth status`), and that the app is
  a member of each workspace's chat channel: Slack lists public channels the app isn't in, and
  sends no messages from them. The service warns about such a channel when it starts.

**Fixed**

- Search needs SQLite full-text search (FTS5), which Node only bundles from 22.16 in the 22
  line and from 24; no Node 23 release has it. `engines` is now `^22.16.0 || >=24`, the CLI and
  `wheems service install` refuse other versions with a plain message, `wheems doctor` checks
  that this Node's SQLite has full-text search, and search says so instead of failing with
  "no such module: fts5".
- `npm run build` now marks `dist/cli/main.js` executable, so a `wheems` linked with `npm link`
  runs instead of failing with "Permission denied".
- Slack messages with a file attached were silently ignored. Now a file with no words gets a reply
  asking for the text, and with words the agent gets them and a note that files can't be passed
  on yet.
- After a quick reply from an agent, Wheems could add a false "The agent finished without
  replying here": it recorded when a message was sent only after typing it in.
- After connecting Slack, setup says to restart the service (which reads tokens only when it
  starts) and how to let someone else talk to the agents.
- On Linux, `wheems doctor` warns that the service needs macOS for now instead of passing.
- Docs: where to install Herdr core ([herdr.dev/core](https://herdr.dev/core/)), npm as the way
  to install, inviting the app to a channel, session names, which commands take `--home`, a
  broken table in config.md, and milestone numbers in code comments.

**Known issues**

- Only one Slack connection, named `slack`, can be set up from `wheems setup` and `wheems init`;
  a second Slack app has to be added by hand.
- The Slack app's manifest asks for interactivity, which nothing uses until approvals with
  buttons (milestone 3).
- The launchd label is fixed, so only one install per Mac user can run as a service.
- `wheems kb search --json` reports inbox notes as `kind: note`; the path tells them apart.

## 0.0.1

The first preview: milestones 0 to 2 of the [roadmap](docs/roadmap.md). Not ready for real use.

**Set up and check**

- `wheems setup`: a menu to install and sign in the engines (Claude Code, Codex, opencode),
  connect Slack, create workspaces, turn on search by meaning, and install the service.
- `wheems init`, `wheems doctor` and `wheems validate`, with JSON Schemas for every config file.

**Talking to agents**

- A chief of staff per workspace, reached from Slack, with one conversation and one engine
  session per thread, resumed when you reply.
- The service under launchd: `wheems service install | status | logs | restart | uninstall`.
- Agents reply with `wheems reply`, running in Herdr core where you can watch or take over.

**The knowledge loop**

- Notes with `wheems note`, asked for when a conversation goes quiet, and filed into a knowledge
  base of pages by a built-in filer whose work is checked in code before it's committed.
- `about-you.md` and a brief per workspace, loaded by every agent.
- Search by keyword and, with Ollama, by meaning: `wheems kb search` and `wheems kb reindex`.
- A nightly tidy that reports contradictions and stale pages and refreshes the brief.
- Skills proposed by agents (`wheems skill propose`), with a near-duplicate check, reviewed with
  `wheems review` into a versioned library.

**For driver authors**

- Contracts for runtime, engine, channel, embeddings and vector store drivers, with contract test
  suites and in-memory drivers in `wheems/testing`.
