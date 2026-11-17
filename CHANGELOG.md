# Changelog

Wheems follows [semantic versioning](https://semver.org). While it's 0.x, any release may
change anything, including commands and config formats, without a migration path.

## Unreleased

**Changed**

- **The chief of staff is `WHEEMS.md`,** in the workspace's folder, and the workspace's goal is
  `GOAL.md` beside it. `agents/` holds the chief's team. When the service starts, a workspace
  from before moves over: `agents/chief-of-staff.md` becomes `WHEEMS.md`, and its "What we're
  working towards" section, if it has one, becomes `GOAL.md`. Every session in the workspace
  reads `GOAL.md`, the chief's and its team's.
- **Every engine reads `AGENTS.md`.** Wheems writes everything a session needs there at every
  start, and a `CLAUDE.md` whose one line, `@AGENTS.md`, has Claude Code read the same file.
  See `docs/instructions.md`.
- **How to use Wheems is now in built-in skills**, loaded only when they're needed:
  `wheems-sessions`, `wheems-knowledge`, `wheems-notes` and `wheems-skill-proposals`. They're
  written at every start into `.claude/skills/` for Claude Code and `.agents/skills/` for Codex
  and opencode, and Wheems clears out its own old ones without touching yours. What must always
  apply stays in `AGENTS.md`: the chief's role, talking to the person, a worker's job, and a short
  map of the skills. A chief's instructions go from about 2,800 tokens to 1,700, and a worker's
  from 2,200 to 1,050.

## 0.1.10

Released 17 November 2026. Work a chief hands on now has a finish line it can check, answers
come with evidence, and a job goes back to a worker at most twice before the person hears of it.
The session store moves to schema version 6. Still an early preview.

**Added**

- **Finish lines for delegated work.** `wheems session create --done-when "…"` gives a session what
  must be true when its job is finished, in things that can be checked. A chief's session must
  have one. The session sees it in its instructions, `session show` prints it, and each answer
  handed back or waited for shows it again, with a count, so the chief checks the answer against it.
- Ad-hoc sessions are told to hand back evidence (what they ran and what it showed, links,
  files, commits) rather than "should work", and to say so rather than retry when they get the
  same result twice.
- The chief sends a job back at most twice, saying what it expected and what it saw; then it
  brings the job to the person. From a session's third answer, the hand-back says so.

**Changed**

- The session store moves to schema version 6, adding each session's finish line. The service
  updates it when it starts; back up `.wheems/state.sqlite` first if you want to be able to go
  back to 0.1.9.

## 0.1.9

Released 17 November 2026. The chief of staff now manages and delegates instead of doing the work
itself, and knows its team; and a chat thread can no longer carry on across a change of engine. No
change to the session store. Still an early preview.

**Changed**

- Every chief gets a built-in **Your role** section: you only talk to the chief, which reads and
  answers, and hands anything that makes or changes something (code of any size, files, research
  beyond a quick lookup, sending or publishing) to its team. It comes before anything in the
  chief's own agent file that says otherwise. See `docs/team.md`.
- Every chief gets a generated **Your team** section listing the workspace's other agents, with
  each one's engine, model and description, so it hands work to the right one with
  `wheems session create <name>`.
- An ad-hoc session started without naming an agent runs as a general member of the team on the
  chief's engine, model and account, not as the chief, whose file is now written for managing.
- A new workspace's chief file describes a chief that runs a team, with a **What we're working
  towards** section for its goal. Existing chief files aren't changed; the built-in role
  overrides "Do what you're asked, end to end", but it's worth editing them.

**Fixed**

- The service refuses to carry a chat thread on when the chief's agent file names a different
  engine from the one it runs, reading the file at that moment, so neither `wheems session restart
--carry-on` nor a web page whose choices were made before another tab changed the engine can
  resume a thread on an engine that never had it. The thread is left as it was, with a note to
  choose Hand over or Start fresh.

## 0.1.8

Released 17 November 2026. A chat thread can hand over to a new session, or start afresh,
when its chief changes or its context has grown long, from the command line or the web app, which
edits the chief's engine, model, account and permissions again. The session store moves to schema
version 5: back it up first, as an older Wheems won't open it afterwards. Still an early preview.

**Added**

- A chat thread can start over: `wheems session restart <id>` hands it over, by default, to a new
  session from a handover its chief writes (`wheems session handover`, in a turn whose answer is
  never posted), or from one Wheems writes from the thread when the chief can't. `--fresh` starts
  it with only the thread's ask; `--carry-on` just stops its session, so the next message resumes
  it on the settings then. Wheems posts a line in the thread when a new session takes over. The
  session store moves to schema version 5, for handovers; an older Wheems won't open it after
  that. See `docs/session-handover.md`.
- The web app's Settings page edits the chief of staff's engine, model, account and permissions
  again. Saving a change to them lists the conversations already open, with a choice for each:
  **Carry on** (the default when the engine stays the same), **Hand over** (the default for a
  thread active in the last week when it changes) or **Start fresh** (for older ones). **Apply and
  restart** sets each up, asking each chief for its handover while the old one still runs, then
  restarts the service in the same step, only once every conversation is set up. Meanwhile a
  message in the workspace asks to be sent again in a moment, and if a conversation opened after
  the page listed them, nothing is done and they're listed again.
- A chat thread's session on the Sessions page has **Hand over** and **Start fresh**, each asking
  first, and lists its handovers.

## 0.1.7

Released 16 November 2026. The web app edits a workspace's settings, asks before ending or
declining anything, and says plainly when Wheems or Slack can't be reached. No change to the
session store. Still an early preview.

**Added**

- The web app's Settings page edits a workspace's settings: its name and description, the name
  its chief posts as, session limits, when a note is asked for and the nightly tidy, and the skill
  budget. A save changes only what changed in `workspace.yaml`, keeping comments, and commits it.
  Nothing is saved if the file changed since the page showed it or a value fails its check, and
  what you typed is kept. **Restart now** then restarts the service so it uses them. The chief's
  engine, model, account and permissions are shown but still changed in its agent file: a chat
  thread's chief keeps running as it started, even after a restart.

**Fixed**

- The web app's Sessions page no longer offers to send to or end a chat thread's session, which
  the service refused with a message meant for agents; it says to reply in the thread. Ending a
  session and declining a proposal or a change about you now ask first, in the page. A session
  you've just ended stays in view with how it went, and no longer says to attach to it in Herdr.
  When the service has stopped, the page and its sidebar say Wheems can't be reached, rather than
  "Failed to fetch".
- When this Mac can't reach Slack, `wheems doctor` and `wheems setup` say so in a few seconds,
  as "Couldn't reach Slack", rather than blaming the tokens, retrying for up to half an hour and
  printing the Slack library's warnings. When Slack is limiting requests, they say that rather
  than waiting it out. Doctor's channel lookups give up as quickly.
- When the service hasn't answered after `wheems start` because it can't reach a chat app yet,
  `start` says which one and that it keeps trying, rather than printing the end of the log.
  `wheems status` points at `wheems doctor` while the service is still connecting.

## 0.1.6

Released 16 November 2026. The web app shows what was said in a chat thread. When the service
first starts, it moves the session store to schema version 4; an older Wheems won't open the
store after that. Still an early preview.

**Fixed**

- The web app's Sessions page shows what was said in a chat thread: your messages, the agent's
  answers and Wheems's notices, which the service now keeps in the session store as they're
  posted. Before, it showed only messages sent through Wheems. Chat from before this is only in
  the chat app. A message that seems to hold a password, token or key is kept only as a line
  saying so.

## 0.1.5

Released 16 November 2026. The web app is now a React app: Overview and Sessions update as you
watch. Still an early preview.

**Changed**

- The web app is now a React app, built with Vite into the npm package, so Overview and
  Sessions update as you watch. The service serves it with a JSON API. The address
  `wheems web open` gives carries its token after the `#`; links from before still work.

## 0.1.4

Released 16 November 2026. The web app's Review, Settings, Connections and About you pages, and
acting from it: approve or decline what your agents propose, and send a message to a session or
end it. Still an early preview.

**Added**

- The web app's Review (skills a workspace's agents proposed), Settings (its `workspace.yaml`,
  agents and pinned skills), Connections (chat channels, integrations and engine accounts, and
  which workspaces use each; credentials are never shown) and About you (`about-you.md` and the
  changes suggested for it).
- Acting from the web app: approve or decline a skill proposal (choosing which agents get it,
  and editing it first if you like) or a change to `about-you.md`, and send a message to a
  session or end it. A form is accepted only from the Wheems page itself.

## 0.1.3

Released 16 November 2026. `wheems start` and `wheems status` show the web app's address, ready
to open, and the service starts the web app before it answers, so the address is there as soon
as it's up. Still an early preview.

**Changed**

- `wheems start` and `wheems status` show the web app's address, ready to open: a link you can
  click in terminals that support them, and the whole address otherwise.

## 0.1.2

Released 16 November 2026. The first pages of the web app, which `wheems start` now starts with
everything else, and sessions that keep what you asked. When the service first starts, it moves
the session store to schema version 3; an older Wheems won't open the store after that. Still an
early preview.

**Added**

- The web app's first pages: `wheems web open` opens a page in your browser with a workspace
  switcher, each workspace's Overview (its chief of staff and the sessions working for it, as a
  tree) and Sessions (state, your original ask, purpose and latest messages), and Setup and
  health (doctor's checks), in light and dark. It only reads for now. The service serves it on
  `127.0.0.1:4317` whenever it runs, so `wheems start` starts it too; `wheems web run` serves it
  on its own. Only this computer can reach it, with a token kept in `.wheems/web-token`.
- Sessions keep what you asked: a chat thread's first message is recorded as its session's ask,
  and every session started for it, at any depth, inherits it. Their instructions quote it, so
  work handed down stays tied to what you asked, and `wheems session show` prints it. A session
  you start yourself has its purpose as its ask. A message that seems to hold a password,
  token or key isn't kept as an ask.

## 0.1.1

Released 16 November 2026. Commands use full words (`wheems workspace`, `wheems knowledgebase`,
`wheems configuration`), with the old short names still working, and setup suggests `default`
for the first workspace. Still an early preview.

**Changed**

- Help, messages and docs call the workspace area `wheems workspace` instead of `wheems ws`.
  `ws` still works, for short.
- Commands use full words. The `kb` area is now `wheems knowledgebase` (`note`, `search`,
  `reindex`), and `config` is now `wheems configuration` (`validate`). The agents' built-in
  instructions, messages and docs use the new names. `kb` and `config` still work, hidden, and
  say what they're called now, so agents' prompts and skills that use `kb` don't break. Config
  files, folders and YAML keys are unchanged.
- Setup suggests `default` for the first workspace, the one that gets the Slack app's direct
  messages, instead of `personal`.

## 0.1.0

Released 15 November 2026. Chiefs of staff can now start sessions of their own and talk to
them, and the commands are grouped by area, like `php artisan`. Setup ends with your chief
saying hello, inviting the app to a channel sets up another chief, and the install folder is
approved once for every session beneath it. Still an early preview.

**Added**

- Commands are grouped by area, like `php artisan`: `wheems <area> <action>` (see docs/cli.md).
  `wheems list` prints them by area.
  - New `wheems ws` (`workspace`): `list`, `show`, `create` (was `wheems init`), `rename`,
    `archive` (stops serving it and moves it to `archive/`), `restore`, and `remove` (deletes the
    workspace, its knowledge base, state and records, after you type its id).
  - New `wheems channel` (`list`, `connect <driver>`, `manifest <driver>`, which was
    `wheems slack manifest`) and `wheems engine` (`list`, `install`, `login`, `trust`), which run
    setup's own steps.
  - `wheems config validate` replaces `wheems validate`.
  - The agents' commands moved too: `wheems chat reply` (was `wheems reply`), `wheems kb note`
    (was `wheems note`) and `wheems session create` (was `session new`). Agents' built-in
    instructions use the new names.
  - In a workspace's folder, `--workspace` defaults to that workspace.
  - The old names still work for a release, and say what they're called now.
- Approve the install folder once, and no session beneath it ever stops at a trust question.
  Setup asks once, "Let Wheems mark ~/wheems as trusted for Claude Code and Codex?", and on a
  yes writes the engines' own trust entries (`~/.claude.json`, `~/.codex/config.toml`) with a
  careful read-modify-write that changes nothing else. `wheems doctor --fix` and
  `wheems engine trust` offer the same for existing installs, and doctor now also checks the
  folder sessions start in, for every engine an agent uses.
- A chief's `wheems session create`, and a `session send` that would resume a stopped session,
  are refused with a plain reason when the engine doesn't trust the session's folder, instead of
  starting a session that waits at a prompt nobody sees.
- Setup ends with your first chief of staff saying hello in chat, once per install: it's set up, how to talk to it, and that inviting it to any channel adds another chief. If it can't, setup says why.
- `wheems doctor --fix` offers to fix what it safely can, saying what it will do and asking before
  each fix: trusting the install folder, starting the service, rebuilding a stale search index,
  and a near-miss channel name in `workspace.yaml`. It never changes the chat app's settings or
  tokens.
- A chief that can't answer says so in the thread, with the one step that fixes it, once per
  problem until it's fixed: an engine that isn't signed in (newly checked before a session
  starts) or doesn't trust the folder, a question waiting at the Mac, an error, or a session that
  failed to start.
- Inviting the app to a channel sets up a chief of staff there. In a channel no workspace uses,
  Wheems offers one to people in `allowed_users`, once per channel, and creates the workspace
  from the name they reply with, answering there at once with no restart. A workspace whose
  channel the app couldn't see starts answering as soon as the app is invited there. Channel
  drivers report being added to a channel through an optional `joins` capability; Slack's
  manifest now subscribes to `member_joined_channel`.
- `wheems start`, `stop`, `restart`, `status` and `logs` look after the background service. `stop`
  keeps it stopped, even after you log in again, until `wheems start`. `status` shows the version,
  how long it has been up, and where each workspace chats, with what stops one from chatting (a
  channel the app can't see or isn't in). `logs -f` keeps following the log. They're also under
  `wheems service`, which keeps `install`, `uninstall` and `run`.
- Leaving `wheems setup` with a chat channel and no service running asks whether to start it,
  rather than leaving messages to go unanswered.
- The session store, `.wheems/state.sqlite`: a record of each workspace's chief and of every
  session the service runs, kept with Node's built-in SQLite. It replaces `conversations.json`,
  which the service imports the first time it starts and renames `conversations.json.imported`
  (it won't start while the file can't be read).
  When the service starts, a session whose Herdr session has gone is marked stopped, and resumes
  when it's next needed. It's the first step towards `wheems session` in milestone 3.
- `wheems session create`, `list`, `search`, `show` and `end`: a chief, a session or you can start
  ad-hoc sessions that work on one thing and stay open until ended, find them by full-text
  search, see one's latest answer, and end one after it's asked for its note. Sessions work
  behind their chief and never post to a channel: you only talk to the chief. Each runs in a
  folder of its own, `.wheems/sessions/<workspace>/adhoc/<id>/`, and sees only its own
  workspace's sessions. A chief's sessions are the
  chief's from any of its threads, and each new thread is told its open ones. New config limits
  them: `sessions.max_open_per_owner` and `sessions.max_depth` in `workspace.yaml`, and
  `max_sessions` on an account in `install.yaml`.
- `wheems session send <id> "…" [--wait]`: send a message into an ad-hoc session, resuming it
  first if it has stopped. Its answer comes back to the sender as a message from Wheems (a
  chief hears it in its own conversation, and answers on its channel), or with `--wait` is
  printed. A session's purpose is answered back to its starter the same way. A chief or you may
  send to any ad-hoc session; an ad-hoc session to the sessions it started and to its owner
  (`send owner`). A wait that would make two sessions wait on each other is refused. Messages
  and answers are kept under `.wheems/messages/`, and `session show` lists the latest.
- Every agent session gets `WHEEMS_SESSION`, its session id; `wheems kb note`, `chat reply` and
  `skill propose` take it as well as `WHEEMS_CONVERSATION`.
- An agent can't be called `adhoc`, the name ad-hoc sessions' folders use.
- `wheems doctor` reports a Herdr session with a Wheems label that the session store has no
  record of, and a `conversations.json` still waiting to be imported.

**Changed**

- Sessions the service starts are labelled `wheems=<session id>` in Herdr, instead of
  `wheems=conversation`. Making room for a new session only stops sessions the store knows.
- The Herdr driver's `list()` reports each session's labels, which `hc ls` leaves out.
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

- A message still waiting for its answer when the service restarted was marked failed without a
  word. Its sender is now told, as answers reach it (a chief in its conversation), and an answer
  that was being handed back is delivered again.
- The session store, `.wheems/state.sqlite`, and its `-wal` and `-shm` files were created
  readable by everyone. They're now owner-only, and the service mends existing ones when it
  starts.
- `wheems restart` could fail with "launchctl bootstrap failed: 5: Input/output error" and leave
  the service stopped, because it loaded the job before launchd had finished unloading it. It now
  waits for the job to unload, and tries the bootstrap again briefly.
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
