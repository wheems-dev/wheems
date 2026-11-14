<p align="center">
  <img src="https://wheems.dev/brand/wheems-icon-512.png" alt="Wheems" width="112">
</p>

<h1 align="center">Wheems</h1>

> [!WARNING]
> **Early preview (0.0.x).** Wheems isn't ready for real use yet. Everything may change between
> releases, including commands, config formats and where files live, with no migration path.
> Try it, but don't rely on it.

An opinionated framework for running teams of AI agents, with Herdr core as the runtime.

**A harness first, workflows when you want them.** Talk to a chief of staff from Slack and it gets
on with the job; nothing needs a workflow. When a job repeats, the chief can turn it into a
routine or a fixed workflow, which starts by asking before it acts and graduates to acting alone
as its results earn it. Determinism is chosen per step: fixed steps and checks where the job is
known, an agent's judgement only where it's needed.

**For business work, not only code:** watching an inbox and acting on each email, replying to
reviews, finding and following up leads, bookkeeping, growing a website.

You install Wheems once, make a workspace for each business or area of life, and talk to each
workspace's chief of staff from Slack. Agents are Claude Code, Codex and opencode, unchanged, each
live in its own Herdr terminal where you can watch it or take over. What they learn goes into a
knowledge base that every later conversation can search. Everything that extends Wheems is a
driver with a contract, as in Laravel.

Wheems was formerly called Opinr.

> **Status: milestone 2, the knowledge loop.** You can chat with a chief of staff from Slack.
> Notes reach a knowledge base that agents search by keyword and by meaning, and agents propose
> skills for you to review. See [what's not built yet](#whats-not-built-yet) and the
> [changelog](CHANGELOG.md).

## Contents

- [How it fits together](#how-it-fits-together)
- [Install](#install)
- [Set up](#set-up)
- [Workspaces and agents](#workspaces-and-agents)
- [Talking to agents](#talking-to-agents)
- [Sessions](#sessions)
- [The knowledge loop](#the-knowledge-loop)
- [Search](#search)
- [Skills and review](#skills-and-review)
- [The service](#the-service)
- [Doctor and validate](#doctor-and-validate)
- [Command reference](#command-reference)
- [Configuration reference](#configuration-reference)
- [Engines](#engines)
- [Drivers](#drivers)
- [Security and privacy](#security-and-privacy)
- [What's not built yet](#whats-not-built-yet)
- [Developing Wheems](#developing-wheems)
- [More documentation](#more-documentation)

## How it fits together

```text
 Slack ──► the Wheems service ──► Herdr core (hc) ──► Claude Code / Codex / opencode
   ▲              │                                         │
   └── answers ◄──┘◄────── wheems reply, note, kb search, skill propose ◄──┘
```

- **The install** is a git folder, `~/wheems`, holding your config: install-wide settings, the
  page about you, the skill library and your workspaces.
- **A workspace** is one business or area of life, in a folder of its own. It has a chief of
  staff (the agent you talk to), its own agents, a chat channel and a knowledge base.
- **The service** runs in the background under launchd. It holds the Slack connection, starts an
  agent session in Herdr for each conversation, posts the agent's answers, files notes into the
  knowledge base, keeps the search index up to date, and runs the nightly tidy.
- **The `wheems` command** is what you run to set up, check and review, and what agents run to
  reply, write notes, search and propose skills. It talks to the service over a private socket.
- **Herdr core** (`hc`) runs every agent in a persistent terminal. You can attach to any session,
  watch it work and type into it.

## Install

You need:

- macOS (the service runs under launchd; Linux, with systemd, comes with the always-on
  milestone)
- Node.js 22.16 or later in the 22 line, or 24 or later (not 23: its SQLite has no full-text
  search, which Wheems needs)
- Herdr core 0.1.20 or later (`hc`): see [herdr.dev/core](https://herdr.dev/core/) to install it
- A Slack workspace where you can add apps

Install the `wheems` command from npm:

```bash
npm install -g wheems
```

Or build it from this repository:

```bash
git clone https://github.com/wheems-dev/wheems.git ~/Projects/wheems
cd ~/Projects/wheems
npm install
npm run build
npm link            # puts the wheems command on your PATH
```

Clone it anywhere except `~/wheems`. That folder is your install: your private config, notes
and knowledge base, kept in a git folder of its own that is never pushed anywhere.

If your default `node` isn't one of those (Homebrew's `node` may be 23), use one that is, such as Homebrew's
(`brew install node@22`), and run `/opt/homebrew/opt/node@22/bin/node dist/cli/main.js` in place
of `wheems`. `wheems doctor` says which Node.js it runs on, and fails when it's unsupported or its SQLite has no
full-text search.

## Set up

```bash
wheems setup
```

Setup creates `~/wheems` if there is none and makes it a git folder. Then it offers a menu. Pick
with the arrow keys and Enter; Esc or Ctrl+C backs out of a step without saving it. Run it again
any time.

| Section          | What it does                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engines          | Shows whether Claude Code, Codex and opencode are installed and signed in. It shows each install command and asks before running it, then runs the engine's own sign-in on your terminal.      |
| Channels         | Connects Slack (below).                                                                                                                                                                        |
| Workspaces       | Creates a workspace with its chief of staff, on the engine and model you choose. The first workspace chats in the Slack app's direct messages; others chat in a channel you invite the app to. |
| Knowledge        | Turns on search by meaning with Ollama, or leaves search on keywords only. It uses the embedding model Ollama already has, or offers to download `nomic-embed-text`.                           |
| Service          | Runs Wheems in the background under launchd, now and at every login.                                                                                                                           |
| Check everything | Runs `wheems doctor`.                                                                                                                                                                          |

### Connecting Slack

One Slack app serves every workspace, so you do this once.

1. Setup copies the app's manifest to your clipboard and offers to open
   <https://api.slack.com/apps?new_app=1>. Choose **From a manifest**, pick your Slack workspace
   and paste. The app uses Socket Mode, so it needs no public address. (`wheems slack manifest`
   prints the manifest.)
2. Choose **Install to workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
3. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write`
   scope (`xapp-…`).
4. Paste both tokens when setup asks. They're masked as you type, checked with Slack, and saved
   to `~/.config/wheems/secrets.json`, readable only by you. They never pass through an agent.
5. Give your Slack member ID (your profile, **⋯**, **Copy member ID**). Only people on this list
   can talk to your agents. Messages from anyone else are ignored.

### Inviting the app to a channel

A workspace that chats in a channel needs the app in that channel: in the channel, type
`/invite` and choose the app. Slack lists public channels the app isn't in, so a channel name
that's spelt right can still hear nothing; the service warns at start-up and `wheems doctor`
checks it, and `wheems status` shows it while the service runs. The service looks channels up
when it starts, so after creating a channel or renaming one, run `wheems restart`.

### Trusting the install folder

Claude Code and Codex ask once whether to trust a folder, and nobody can answer that from Slack.
A trusted folder covers every folder in it, so trust your install folder once and every
workspace is covered, including ones you add later. When setup creates the first workspace for
an engine, it offers to open the engine in the install folder: say yes, trust the folder, then
press Ctrl+C twice to come back. To do it yourself, run `cd ~/wheems && claude` (or `codex`)
and answer yes.

`wheems doctor` checks the trust. If a message arrives for an engine that doesn't trust the
folder, the service says so in the thread at once, with the command to run, rather than start a
session that would wait at the Mac.

### Without the menu

Each part has a command of its own, for scripts. `wheems init` creates the install too when
there isn't one, so a fresh machine can start there; connecting Slack still needs `wheems setup`,
because you type its tokens in yourself:

```bash
wheems init personal                                   # a workspace on Claude Code
wheems init acme --channel acme-chat --engine codex    # chat in a channel, on Codex
wheems start
wheems doctor
```

## Workspaces and agents

A **workspace** is an entity with its own people, knowledge and confidentiality: your personal
life, a business, a client. Make something a separate workspace when it has different people,
should keep its knowledge private, or may be handed to someone else one day. Today each
workspace has its own folder, agents, chat channel, knowledge base and search index. Enforced
isolation, where an agent in one workspace can't read another's files, arrives in milestone 6.
Projects inside a workspace (milestone 4) keep context clean but are never walls.

`wheems init <id>` creates `workspaces/<id>/`:

```text
workspaces/personal/
├── workspace.yaml         its name, accounts, chat channel, knowledge settings
├── agents/
│   └── chief-of-staff.md  the agent you talk to
├── skills.yaml            the skills it uses, pinned to library versions
└── knowledge/
    ├── brief.md           a short summary every agent here loads at launch
    ├── inbox/             notes land here
    ├── notes/             filed notes, kept as the sources
    ├── pages/             the knowledge base, one topic per page
    └── reports/           nightly: contradictions and stale pages
```

An **agent** is a Markdown file: YAML front matter saying which engine, model and account it
runs on, then its instructions.

```markdown
---
description: The one entry point for my personal life.
engine: claude-code
model: claude-opus-5-5
account: claude-subscription
permissions: auto
---

# Chief of staff

You look after my personal admin. Be brief.
```

When Wheems starts an agent, it writes the engine's instructions file in the workspace folder
(`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex and opencode). The file holds the agent's
instructions, then Wheems's built-in instructions, then what the agent should know at launch:
`about-you.md` and the workspace's brief. The built-in instructions cover talking to the person,
writing notes, searching the knowledge base and proposing skills. Don't edit the instructions
file: it's rewritten at every launch and ignored by git.

`permissions` says how much an agent may do without asking:

| Level           | Meaning                                                     | Claude Code                      | Codex                                        | opencode |
| --------------- | ----------------------------------------------------------- | -------------------------------- | -------------------------------------------- | -------- |
| `ask` (default) | The engine's normal prompts                                 | (none)                           | (none)                                       | (none)   |
| `auto`          | The engine decides routine actions, and asks for risky ones | `--permission-mode auto`         | `--approve-for-me`                           | `--auto` |
| `skip`          | Never asks                                                  | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--auto` |

A prompt means someone has to answer it at the Mac, so a chief of staff you talk to from your
phone usually runs on `auto`.

Today the service talks to each workspace's chief of staff. Other agent files are validated and
can be given skills, but nothing starts them yet: teams of agents come in later milestones.

## Talking to agents

Message the Slack app (or the workspace's channel). Each message you send starts a
**conversation**, and replies in its thread carry it on.

- Each conversation is its own engine session in Herdr, named after the workspace with a short
  id for the thread, such as `personal-3f9a2c1b`. Watch it or take over with
  `hc attach <session>`.
- A 👀 reaction means your message has reached the agent. It goes when the agent answers.
- The agent's last message of each turn is posted to the thread as its answer. The answer is
  read from the engine's own record of the conversation, never from the screen.
- For long work, the agent sends a short progress note first with `wheems reply "…"`.
- Messages sent while the agent is working are passed on when it finishes its turn.
- Each workspace keeps at most four sessions running. The least recently used idle one is
  stopped to make room, and its conversation resumes where it left off when you next reply.
- If an agent hasn't started on a message, perhaps because it's waiting for an answer at the
  Mac, Wheems tells you in the thread, with the `hc attach` command to use.

## Sessions

Besides a session per chat thread, a chief can start **ad-hoc sessions**: other agent sessions
that work on one thing and stay open until they're ended, so the chief can come back to them.
You only ever talk to your chief. Ad-hoc sessions have no channel or thread of their own: they
work behind the chief, and it tells you what you need to know.
Ask your chief "open a session to research packaging suppliers and keep it going", and it runs:

```bash
wheems session new --title "Packaging suppliers" --purpose "Find five UK packaging suppliers, with prices and minimum orders."
```

- The session starts working on its purpose at once, in Herdr, and stays open until it's ended.
  It runs the chief's own agent file, or another of the workspace's agents
  (`wheems session new researcher …`).
- A session the chief starts is owned by the chief, whichever thread started it, so it's the
  chief's from any of its threads. Each new thread's session is told the chief's open sessions
  when it starts.
- Each ad-hoc session runs in a folder of its own, `.wheems/sessions/<workspace>/adhoc/<id>/`, where
  its engine's instructions file is written, so it never replaces the chief's. (So no agent can be
  called `adhoc`.)
- `wheems session list` and `wheems session search "…"` find sessions in the workspace, most
  recently active first. Search looks at titles, purposes, summaries and agent names. A session's
  summary is written by Wheems: its purpose at first, then the title of its latest note.
- The chief talks to a session with `wheems session send <id> "…"`, and gets its answer back as
  a message from Wheems in the conversation it sent from, then tells you what you need to know.
  The answer to a session's purpose comes back the same way. With `--wait`, it waits for the
  answer instead (up to ten minutes, or `--timeout <seconds>`). A stopped session is resumed
  first, and each session takes one message at a time.
- `wheems session show <id>` gives its details, its latest answer, its recent messages and the
  `hc attach` line to watch it.
- `wheems session end <id>` asks it for its note, then ends it. Only its owner or you can end
  one. An ended session stays in the store and in search, as a record.
- You can run the same commands yourself, from a terminal; add `--workspace <id>` when there's
  more than one. Sessions you start are yours.

Sessions only ever see their own workspace's sessions. A chief (or you) may send to any ad-hoc
session in the workspace; an ad-hoc session only to the sessions it started and to its owner
(`wheems session send owner "…"`). Limits stop them multiplying or looping:
each owner may have three open (`sessions.max_open_per_owner`), a chief's session may start one
level of sessions and those one more (`sessions.max_depth`), and an account may cap how many
sessions run at once (`max_sessions` in `install.yaml`). A `--wait` send that would make two
sessions wait on each other is refused.

A session's answers are never posted to a channel. Its last message of each turn is its answer:
it goes back to whoever sent the message, and `wheems session show` shows the latest; you can
also watch it with `hc attach`. Messages and answers are kept as files under
`.wheems/messages/<workspace>/`.
Inside an ad-hoc session, `wheems reply` is refused, since there's no chat to reply in: it
answers its owner instead.

Sessions don't depend on Slack: they live in Wheems's core, and only a chief's conversation
reaches you, through whatever channel it uses.

## The knowledge loop

Agents are told never to write the knowledge base themselves. They write **notes**, and a
built-in **filer** turns notes into pages. Everything is a Markdown file in your git folder, so every version of
every page is kept.

### About you and the brief

- **`~/wheems/about-you.md`** is the one page every agent in every workspace reads: what you'd
  tell anyone working for you. Agents never change it. The filer suggests changes, and you
  approve them in [`wheems review`](#skills-and-review). The first 4,000 characters are loaded.
- **`knowledge/brief.md`** is each workspace's short summary: what's in progress, recent
  decisions, what's waiting on you. The filer keeps it under 4,000 characters, and every agent
  in the workspace loads it at launch.

### Notes

Agents write notes with `wheems note`, which reads Markdown on standard input:

```bash
wheems note - <<'EOF'
# Picked the boat name

Halcyon, over Kestrel, because it's calmer.
EOF
```

- Wheems adds the details agents can't be trusted with: workspace, agent, engine, conversation
  and time. It saves the note to the workspace's `knowledge/inbox/`.
- When a conversation has been quiet for 30 minutes after new work, and before an idle session
  is stopped, Wheems asks the agent for a note as a turn of its own. That turn's answer is never
  posted to Slack. Set the time with `knowledge.note_after_idle` in `workspace.yaml` (0 turns
  it off).
- A note is at most 32 KB. A note that looks like it holds a password, token or key is refused.

### Filing

When a note lands, the service runs the **filer**. This is a built-in agent you never talk to. It
runs in Herdr like any other, so you can watch it. It handles one note at a time per workspace.
It works on a copy of the knowledge base in `.wheems/filing/<workspace>/`: it reads the note,
updates or creates pages, and keeps the brief current. Wheems then checks its work in code
before anything reaches the real knowledge base:

- a page has a name of lowercase words and dashes, and keeps at least three quarters of its text;
- every changed page lists the note among its `sources`, and keeps the sources it had;
- pages are never deleted;
- the brief stays under 4,000 characters;
- nothing that looks like a credential is kept;
- anything else the filer wrote is ignored.

Changes that pass are written, the note moves to `notes/<year>/<month>/`, and those paths alone
are committed as "Wheems". If a page or the brief changed while the filer worked, such as an
edit by hand, nothing is applied and the note is filed again from the new version, so your
edits are never overwritten. A suggested change to `about-you.md` waits for review. A note the
filer can't file is tried three times, then waits until the service restarts. A note that looks
like it holds a credential is moved to `.wheems/quarantine/` and never filed or committed.

A page looks like this:

```markdown
---
title: Boat name
sources:
  - 2026-11-11-213709-chief-of-staff-boat-name-halcyon.md
updated: 2026-11-11
---

The boat is called Halcyon, chosen over Kestrel because it's calmer.
```

The filer runs on Claude Sonnet when the chief of staff is on Claude Code, and otherwise on the
chief of staff's engine and model. Change it with `knowledge.filer` in `workspace.yaml`.

### The nightly tidy

Once a night the filer reads the whole knowledge base. The time is `knowledge.tidy_at`, 03:00
local time by default, and `false` turns it off. It writes two reports for you:

- `knowledge/reports/contradictions.md`: places where pages disagree with each other or with the
  brief, with which one looks current;
- `knowledge/reports/stale.md`: pages that look out of date, such as a plan for a date that has
  passed.

It also refreshes the brief. It changes no page: Wheems keeps only the reports and the brief,
checks them, and commits them. A service that was stopped overnight tidies when it starts.
Nights when nothing has changed are skipped, so it costs nothing when there's nothing new. If
anything it read changed while it worked, nothing is applied that night.

## Search

Agents search before answering about past work:

```bash
wheems kb search "what did we decide about the boat name"
```

It searches the agent's own workspace: pages, filed notes and the inbox.

- **By keyword**, always, with SQLite's full-text search, built into Node.js. Common words such
  as "what" and "the" are left out, and any remaining word can match.
- **By meaning** too, once you turn it on. The default is Ollama with `nomic-embed-text`, which
  runs on your Mac for free. Set it up in `wheems setup` → Knowledge, or in `install.yaml`.
- The two rankings are combined by reciprocal rank fusion, and each file is shown by its best
  passage.
- A match by meaning alone must score at least the model's floor (0.5 for nomic-embed-text) and
  be within 0.1 of the best match. So a question the knowledge base can't answer gets "Nothing in
  the knowledge base matches." rather than its least unrelated pages. Keyword matches have no
  floor.
- Notes from automated jobs, and pages built only from them, count half as much as your own
  work.

Files are split into passages of up to 1,200 characters, starting afresh at each heading. Links,
files over 1 MB, and anything that looks like a credential are left out of the index and never
sent to an embeddings service.

The index is running state in `.wheems/index/`, never committed and rebuildable at any time. The
service brings it up to date when it starts, after each note is filed, and every ten minutes for
edits by hand. Only files that changed are read and embedded again.

- `wheems kb reindex` builds a fresh index and swaps it in when it's done, so search keeps working
  meanwhile. When the service is running, it does the rebuild.
- Changing the embedding model rebuilds the index, because vectors from different models can't
  be compared. Until the rebuild finishes, search uses keywords only.
- If Ollama isn't running, search falls back to keywords and says so. New passages are found by
  keyword until Ollama is back, and a rebuild keeps the index it has.

## Skills and review

A **skill** is how to do a task that comes up again: the steps, the checks, and what to watch
for. Skills use the [Agent Skills](https://agentskills.io) `SKILL.md` format.

### The library

The install's library holds every skill at every version, numbered 1, 2, 3:

```text
library/skills/weekly-report/
├── skill.yaml       who wrote each version
├── 1/SKILL.md
└── 2/SKILL.md
```

```markdown
---
name: weekly-report
description: Writes the weekly report. Use when asked for a summary of the week.
---

1. Read the git log for the last seven days and the brief.
2. List what shipped, what's blocked and what's next.
```

The library is never loaded into an agent as a whole. A workspace pins the versions it uses in
`skills.yaml`, and each agent lists the skills it uses, so library changes never silently reach
a live workspace. `skill.yaml` records the versions agents proposed. A version it doesn't list
was written by a person, and no agent can change that skill. To add a skill yourself, create its
numbered folder.

```bash
wheems skill list                  # the library, and proposals waiting for review
wheems skill show weekly-report    # the latest version
wheems skill show weekly-report 1  # an older one
```

### Proposals

When an agent works out how to do something it'll be asked to do again, it proposes a skill. Its
built-in instructions say to improve an existing skill rather than add another, to read a skill
before changing it, to write lessons rather than logs, and to leave out one-off failures.

```bash
wheems skill propose weekly-report - <<'EOF'
---
name: weekly-report
description: Writes the weekly report. Use when asked for a summary of the week.
---

The steps, in plain English.
EOF
```

Wheems checks the proposal before saving it to `.wheems/review/skills/`. It needs front matter
with a name and a description, instructions after it, at most 64 KB, and nothing that looks like
a credential. It never reaches the library without you.

Each proposal is compared with every skill in the library and every other proposal. With an
embeddings model that says what a near-duplicate scores, the comparison is by meaning. For
nomic-embed-text that's 0.8, measured on real skills: near-duplicates score 0.84 to 0.94, and
different tasks 0.75 or less. Otherwise it compares the share of words the two have in common.
The agent is told which skills it may repeat, and so are you when you review.

### `wheems review`

`wheems review` goes through what waits for you:

- skills agents proposed: a new skill in full, a change as a diff against the version it changes;
- changes to `about-you.md` the filer suggested, as a diff.

For each, you approve it, edit it in your editor (`$VISUAL` or `$EDITOR`) and approve that, turn
it down, or leave it for later. Approving a skill:

1. adds it to the library as the next version;
2. pins that version in the proposing workspace's `skills.yaml`;
3. asks which of the workspace's agents get it, with the one that proposed it ticked;
4. commits.

Outside a terminal, `wheems review` only lists what waits. `wheems doctor` also says how much
does.

Approved skills are recorded and pinned, but not yet written into agents' sessions. Every agent
in a workspace shares one folder today, so a skill written there would reach all of them, not
only the agents it was given to. From milestone 5 each agent session gets a folder of its own,
which carries only its pinned skills.

## The service

The service connects Slack to your agents, files notes, keeps the search index current and runs
the nightly tidy.

Nothing answers in chat unless it's running. Setup offers to start it, and asks again when you
leave setup with it stopped.

```bash
wheems start              # start it, now and at every login
wheems status             # is it running, and where does each workspace chat?
wheems logs               # the end of its log (-n for more lines, -f to keep following)
wheems restart            # after changing config, or updating Wheems
wheems stop               # stop it; it stays stopped, even after you log in again, until wheems start
wheems service run        # run it in this terminal, as launchd does
wheems service uninstall  # stop it and remove it from launchd
```

`wheems status` shows the version, how long it has been up, the chat connections, and each
workspace's channel, with what stops one from chatting, such as a channel the app hasn't been
invited to:

```text
✓ Running: Wheems 0.0.4, pid 4242, up 2h 14m
✓ Connected to slack
✓ personal: direct messages on slack
! marketing: the app can't see #marketing-chat on slack. Check the name in workspace.yaml and invite the app to the channel, then run wheems restart.
Log: ~/wheems/.wheems/logs/service.log
```

It runs as the launchd agent `dev.wheems.service`
(`~/Library/LaunchAgents/dev.wheems.service.plist`), with the Node.js and the copy of Wheems you
started it with; `wheems restart` picks up a newer one. Its log is
`~/wheems/.wheems/logs/service.log`. It refuses to start when the config has errors, and the log
says why: `wheems start` prints the end of the log when it doesn't answer. Run `wheems doctor`
to see the errors. The commands are also under `wheems service` (`wheems service start` and so
on), and `wheems service install` is the same as `wheems start`.

Agents reach the service through the `wheems` command, which Wheems puts first on each session's
`PATH`, pinned to the same Node.js and the same copy of Wheems. The command talks to the service
over a Unix socket in `.wheems/` that only you can open.

### The session store

The service keeps a record of every session it runs in `.wheems/state.sqlite`, using Node's
built-in SQLite: each workspace's chief, written from config every time the service starts, and
each chat thread with the session it talks to, where the answers have got to and its notes.
Herdr says whether a session is running; the store says what it's for. Every session Wheems
starts is labelled `wheems=<session id>` in Herdr, and when the service starts it matches the
store against Herdr: a session whose Herdr session has gone is marked stopped, and resumes when
it's next needed.

Only the service writes to the store. Its schema version is kept in the file and brought up to
date when the service starts. The first time a Wheems with the store starts, it imports
`.wheems/conversations.json` and renames it `conversations.json.imported`. If it can't read the
file, it leaves it where it is and won't start, and the log and `wheems doctor` say why: fix the
file, or remove it to start its threads afresh, then run `wheems restart`.

## Doctor and validate

`wheems doctor` checks everything, in sections:

| Section    | Checks                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| System     | Node.js version and platform                                                                                                 |
| Herdr core | `hc` is installed, new enough and answering. It also starts a tiny test session and removes it again (`--quick` skips that). |
| Config     | Every config file, and the links between them                                                                                |
| Agents     | Each engine is installed and signed in, and trusts each workspace folder                                                     |
| Channels   | Each Slack connection's tokens work                                                                                          |
| Knowledge  | The embeddings driver and model, the vector store, and each workspace's search index                                         |
| Review     | What waits for `wheems review`                                                                                               |
| Service    | Whether the service is installed and answering, and the session store (see below)                                            |

It exits with 1 when anything fails. `--json` prints the report as JSON.

The session store check warns about a Herdr session with a Wheems label (`wheems=<session id>`)
that the store has no record of. Wheems never adopts or removes one; stop it with `hc kill` if
nothing needs it. It also warns when `.wheems/conversations.json` from an older Wheems is still
waiting to be imported, and fails when it can't be read.

`wheems validate` checks config files or a whole install folder, with line numbers:

```bash
wheems validate                       # the install folder
wheems validate examples/install      # another one
wheems validate workspaces/acme/workspace.yaml
```

For a folder it also checks the links between files. Names must point at things that exist, and
each level may only pick from the level above: a workspace from the install's accounts, an agent
from its workspace's skills. Pinned skill versions must exist in the library.

## Command reference

Commands that use the install take `--home <dir>` for the install folder (default:
`$WHEEMS_HOME`, then `~/wheems`). `wheems stop`, `service uninstall` and `slack manifest` don't
need it.

**For you**

| Command                                                             | What it does                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `wheems`                                                            | The welcome screen: the cloud, and how the install is doing (workspaces, the service, search, review)     |
| `wheems setup`                                                      | The setup menu: engines, Slack, workspaces, knowledge, the service, doctor                                |
| `wheems init <workspace> [--name] [--channel] [--engine] [--model]` | Creates a workspace with its chief of staff. `--engine` is `claude-code` (default), `codex` or `opencode` |
| `wheems doctor [--quick] [--json]`                                  | Checks the machine, Herdr core and the install                                                            |
| `wheems validate [paths...]`                                        | Validates config files or install folders                                                                 |
| `wheems review [--list]`                                            | Goes through skill proposals and changes to `about-you.md`                                                |
| `wheems kb search <query...> [--workspace] [--limit] [--json]`      | Searches a workspace's knowledge base (`$WHEEMS_WORKSPACE`, or the only one; 5 results)                   |
| `wheems kb reindex [--workspace]`                                   | Rebuilds search indexes, every workspace's by default                                                     |
| `wheems skill list [--json]`                                        | Lists the library and waiting proposals                                                                   |
| `wheems session new [agent] --title --purpose [--workspace]`        | Starts an ad-hoc session, owned by you, and prints its id                                                 |
| `wheems session list [--mine] [--agent] [--state] [--kind] [--all]` | Sessions in a workspace, most recently active first; open ones unless `--all`                             |
| `wheems session send <id> "…" [--wait] [--timeout <s>]`             | Sends a message into a session, resuming it if stopped; prints its answer with `--wait`                   |
| `wheems session search "…"`, `show <id>`, `end <id>`                | Finds sessions, shows one with its latest answer and messages, or ends one after asking for its note      |
| `wheems skill show <name> [version]`                                | Prints a skill's `SKILL.md`                                                                               |
| `wheems start`, `stop`, `restart`                                   | Starts, stops or restarts the background service                                                          |
| `wheems status`                                                     | Whether the service is running, and where each workspace chats                                            |
| `wheems logs [-n] [-f]`                                             | The end of the service's log, or follows it                                                               |
| `wheems service run`, `uninstall`                                   | Runs the service in this terminal, or removes it from launchd                                             |
| `wheems slack manifest`                                             | Prints the Slack app manifest                                                                             |

**For agents** (these work only inside a session Wheems started)

| Command                                | What it does                                                  |
| -------------------------------------- | ------------------------------------------------------------- |
| `wheems reply "…"` or `wheems reply -` | Posts a progress note to the conversation's thread            |
| `wheems note "…"` or `wheems note -`   | Saves a note to the workspace's inbox                         |
| `wheems kb search "…"`                 | Searches the agent's own workspace                            |
| `wheems skill propose <name> [-]`      | Proposes a skill, read from standard input, for you to review |
| `wheems session …`                     | The session commands above, in the agent's own workspace      |

## Configuration reference

Config is YAML and Markdown in a git folder. Every format has a JSON Schema in
[`schemas/`](schemas/), shipped in the package. Point your editor at one for completion and hover
help:

```yaml
# yaml-language-server: $schema=/path/to/wheems/schemas/workspace.schema.json
```

Keys are `snake_case`. Names of workspaces, agents, accounts, connections, channels and skills
are lowercase letters, digits and dashes. Unknown keys are errors, so a typo never passes
silently. A complete example is in [`examples/install/`](examples/install/).

### On disk

```text
~/wheems/                       a git folder
├── install.yaml                accounts, connections, machines, knowledge settings
├── about-you.md                every agent in every workspace reads it
├── library/skills/             every version of every skill
├── workspaces/<id>/            one folder per workspace (see above)
└── .wheems/                    running state, never committed
    ├── state.sqlite            the session store: agents, sessions and chat threads
    ├── wheems.sock             the control socket
    ├── logs/service.log
    ├── bin/wheems              the command agents run
    ├── index/                  search indexes
    ├── filing/, tidy/          the filer's working copies
    ├── review/                 skill proposals and about-you suggestions
    └── quarantine/             notes that looked like they held a credential
~/.config/wheems/secrets.json   tokens, readable only by you
```

### install.yaml

```yaml
herdr:
  version: 0.1.20 # the minimum Herdr core version; Wheems's own minimum applies if higher
  binary: /opt/hc # optional: hc's path when it isn't on PATH

machines:
  this-mac:
    local: true

accounts: # what pays for models
  claude-subscription: { driver: claude, max_sessions: 6 } # optional: most sessions at once

connections: # chat apps and services, connected once and shared by every workspace
  slack:
    driver: slack
    secret: slack # its entry in the secrets file (default: the connection's name)
    allowed_users: [U012ABCDEF] # who may talk to agents; everyone else is ignored

knowledge: # how every workspace's knowledge base is searched
  embeddings: # leave out for keyword search only
    driver: ollama
    model: nomic-embed-text:v1.5 # default: nomic-embed-text
    url: http://127.0.0.1:11434 # Ollama's default
  vector_store: { driver: sqlite } # the default
```

Changing the embeddings driver or model rebuilds every index the next time the service syncs it.

### workspace.yaml

```yaml
name: Personal
accounts: [claude-subscription] # install accounts this workspace may use
chief_of_staff: chief-of-staff # the file in agents/; this is the default
channels:
  chat: { connection: slack, direct: true } # or { connection: slack, channel: acme-chat }
identity: { name: Personal chief of staff, icon: ':house:' } # how its posts appear
skill_budget: 20 # doctor warns past this many skills
sessions: # limits on ad-hoc sessions; each defaults as shown
  max_open_per_owner: 3 # open sessions one owner (a chief, a session or you) may have
  max_depth: 2 # a chief's session starts one level, and those one more
knowledge:
  note_after_idle: 30 # minutes quiet before the agent is asked for a note; 0 is off
  tidy_at: '03:00' # the nightly tidy, local time; false is off
  filer: # each defaults as shown
    engine: claude-code # the chief of staff's engine
    model: claude-sonnet-5-5 # Sonnet on Claude Code, else the chief of staff's model
    account: claude-subscription # the chief of staff's account
```

`direct: true` means the Slack app's direct messages. Only one workspace per connection can have
them; every other workspace chats in a channel the app has been invited to.

### agents/&lt;name&gt;.md

| Key            | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `description`  | What the agent is for                                           |
| `engine`       | `claude-code`, `codex` or `opencode`                            |
| `model`        | The engine's model id, such as `claude-opus-5-5`                |
| `account`      | One of the workspace's `accounts`                               |
| `permissions`  | `ask` (default), `auto` or `skip`                               |
| `skills`       | Skills from the workspace's `skills.yaml`                       |
| `integrations` | Integrations from the workspace's `integrations` (not used yet) |

The file name is the agent's name. The Markdown after the front matter is its instructions.

### skills.yaml

```yaml
skills:
  weekly-report: 2 # the library version this workspace uses
```

### Environment variables

| Variable              | Meaning                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `WHEEMS_HOME`         | The install folder (default `~/wheems`)                                                 |
| `WHEEMS_SECRETS`      | The secrets file (default `~/.config/wheems/secrets.json`, or under `$XDG_CONFIG_HOME`) |
| `WHEEMS_WORKSPACE`    | The workspace `wheems kb search` searches. Wheems sets it in every agent session        |
| `WHEEMS_CONVERSATION` | The chat thread a thread session's commands belong to. Wheems sets it in those sessions |
| `WHEEMS_SESSION`      | The session an agent's commands come from. Wheems sets it in every agent session        |
| `WHEEMS_NO_ANIMATION` | Set to anything to stop the cloud winking on the welcome screen and in `wheems setup`   |

### Config the schemas accept but nothing uses yet

These are validated now, so config written today keeps working, but nothing acts on them yet:
machines beyond the local one in `install.yaml`; `rules`, `integrations`, `isolation`, `machine`
and channels other than `chat` in `workspace.yaml`; and `workflows/*.yaml`. See
[docs/config.md](docs/config.md) for their formats.

## Engines

| Engine      | Instructions file | Default model         | Signs in with                                    | Follows each turn by                        |
| ----------- | ----------------- | --------------------- | ------------------------------------------------ | ------------------------------------------- |
| Claude Code | `CLAUDE.md`       | `claude-opus-5-5`     | A Claude subscription                            | Its status in Herdr, and its transcript     |
| Codex       | `AGENTS.md`       | `gpt-6.1-sol`         | A ChatGPT subscription                           | Its status in Herdr, and its session record |
| opencode    | `AGENTS.md`       | `opencode/big-pickle` | OpenRouter, a provider's key, or its free models | Its answers                                 |

- Every conversation keeps one engine session, and a session that ended is resumed by its id.
  Claude Code takes Wheems's id for it. Codex and opencode choose their own ids, which Wheems
  finds from the session's folder, start time and first message.
- opencode doesn't report its status under Herdr core, so the service watches for its answers
  instead.
- `wheems setup` → Engines installs and signs in each one.

## Drivers

Every extension point is a driver: a small TypeScript contract with built-in drivers behind it,
as in Laravel. Adding Discord or Gemini CLI means writing one driver, not changing the core.

| Driver type  | What it does                                        | Built in                     |
| ------------ | --------------------------------------------------- | ---------------------------- |
| Runtime      | Starts, sends to, reads and waits on agent sessions | Herdr core                   |
| Engine       | Runs an agent in a given CLI                        | Claude Code, Codex, opencode |
| Channel      | Sends and receives messages, threads and reactions  | Slack (Socket Mode)          |
| Embeddings   | Turns text into vectors for searching by meaning    | Ollama                       |
| Vector store | Keeps vectors and finds the nearest                 | SQLite                       |

Every driver reports health checks for `wheems doctor`, and throws `DriverError` with one of a
fixed set of kinds (`not_found`, `unsupported`, `unavailable`, `version`, `blocked`, `invalid`,
`failed`), so callers handle every driver the same way.

Each driver type has a contract test suite that any driver of that type must pass, exported as
`wheems/testing` along with in-memory reference drivers (`MemoryRuntime`, `MemoryChannel`,
`StubEngine`, `HashEmbeddings`, `MemoryVectorStore`):

```ts
import { runtimeContract } from 'wheems/testing';
import { MyRuntime } from './my-runtime.js';

runtimeContract('my-runtime', { create: () => new MyRuntime() });
```

Every `hc` call goes through one module, `src/drivers/runtime/herdr/hc.ts`, which always reads
Herdr's JSON output, never screen text. Wheems refuses to run on an `hc` older than the version
it was tested with. See [docs/drivers.md](docs/drivers.md) for each contract and
[docs/herdr.md](docs/herdr.md) for the Herdr driver.

## Security and privacy

- **Tokens never pass through an agent.** You type them into `wheems setup`. They're kept in
  `~/.config/wheems/secrets.json` (mode 600), outside the config folder and out of git.
- **Only people you list can talk to agents.** Messages from anyone not in `allowed_users` are
  ignored and logged.
- **Credentials stay out of the knowledge base.** Notes, pages, the brief, reports and skills
  that look like they hold a password, token or key are refused or quarantined. They're never
  indexed, embedded or committed.
- **What the filer writes is checked in code, and `about-you.md` and skills change only with
  your approval** when they come through Wheems: notes, filing and `wheems review`. Agents are
  told not to edit the knowledge base or `about-you.md` themselves, but that is an instruction,
  not a lock: an agent runs in its workspace folder and could edit files there directly, and
  such an edit is treated like one by hand. Permission rules that enforce limits arrive in
  milestone 6.
- **What leaves your Mac.** Messages you send go through Slack. Agents run on their model
  providers (Anthropic for Claude Code, OpenAI for Codex, whichever opencode is set up with), so
  those providers see each conversation, and what agents load or read: `about-you.md`, the
  brief, and, for the filer, notes and pages. Search by meaning is local: with Ollama, nothing
  you index is sent anywhere to be embedded.
- **The control socket** is a Unix socket only you can open.

## What's not built yet

Wheems is being built in milestones (see the [roadmap](docs/roadmap.md)):

| Milestone | What it brings                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 to 2    | Done: the skeleton, talking to a chief of staff from Slack, and the knowledge loop (their tests in daily use are still to come)                                                                                         |
| 3         | Sessions, approvals and updates: a record of every session, so a chief can start sessions, find them and talk to them; buttons on your phone, the `approvals` and `updates` channels, and a first version of the broker |
| 4         | Projects and leads: any body of work as a project, with a lead in its own channel and its own knowledge base, and the chief routing questions to them                                                                   |
| 5         | Tasks and a team: the hand-off between agents, evaluated in code, by a judge and by you; routines; pairs; more accounts                                                                                                 |
| 6         | A second workspace, kept apart                                                                                                                                                                                          |
| 7         | Workflows and evals: DAGs, triggers from email and other services, classify then act, shadow mode, and creating workflows by asking                                                                                     |
| 8         | Data and blueprints: small data apps such as a CRM, built from a blueprint                                                                                                                                              |
| 9         | Integrations, guardrails and the vault: `connect` and `grant`, the Keychain, GitHub rules, and purchases you approve                                                                                                    |
| 10        | Always on, more channels, more machines: a server, laptops collecting work, `wheems node`, Telegram and email                                                                                                           |
| 11        | Plugins and release: `make:` commands, npm plugins, and the open-source release on npm                                                                                                                                  |

Until milestone 10 the service runs on your Mac under launchd, so agents answer only while it's
awake. [docs/architecture.md](docs/architecture.md) designs the planned parts and marks what's
built, with a worked example: growing a website into a lead generator.
[docs/ideas/](docs/ideas/) keeps the original ideas, the two design proposals and the
[decisions](docs/ideas/decisions.md) taken from them.

## Developing Wheems

```bash
npm install
npm run check              # lint, typecheck, test and build, as CI does
npm test                   # tests only
npm run schemas            # regenerate schemas/*.schema.json after changing src/config/schemas.ts
npm run wheems -- doctor   # run the CLI from source
```

The tests run the runtime contract suite against the real `hc` when it's installed, in a Herdr
core of their own so your terminals are never touched; `WHEEMS_TEST_HC=0` turns that off. They
also run it against a fake `hc`, which is what CI uses. Set `WHEEMS_TEST_OLLAMA_MODEL` (such as
`nomic-embed-text:v1.5`) to also run the embeddings contract against your Ollama.

| Folder              | What's in it                                                                     |
| ------------------- | -------------------------------------------------------------------------------- |
| `src/cli/`          | The `wheems` command                                                             |
| `src/config/`       | Config schemas, loading with line numbers, and checks across files               |
| `src/contracts/`    | Driver contracts and the registry                                                |
| `src/drivers/`      | Built-in drivers: Herdr, Claude Code, Codex, opencode, Slack, Ollama, SQLite     |
| `src/service/`      | The service: conversations, filing, the task runner, the control socket, launchd |
| `src/state/`        | The session store: its schema, migrations and every query                        |
| `src/knowledge/`    | Notes, filing checks, the nightly tidy and search                                |
| `src/skills/`       | The skill library and proposals                                                  |
| `src/review/`       | Approving and turning down what waits for review                                 |
| `src/agents/`       | Built-in instructions, and the filer                                             |
| `src/doctor/`       | `wheems doctor`                                                                  |
| `src/testing/`      | Contract test suites and in-memory drivers, published as `wheems/testing`        |
| `schemas/`          | JSON Schemas for the config formats                                              |
| `examples/install/` | A complete example install                                                       |
| `docs/`             | Design documents                                                                 |

### Releasing

GitHub publishes each release. To release, merge a pull request to `main` that:

1. changes `version` in `package.json` (and `package-lock.json`);
2. adds a `## <version>` section to `CHANGELOG.md`.

The [release workflow](.github/workflows/release.yml) then runs the full check on Linux and
macOS and publishes to npm. It then tags the commit `v<version>` and creates a GitHub release
with that changelog section as its notes. A push to `main` whose version is already published and
tagged does nothing.

npm trusts the workflow through
[trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored
anywhere. The package's settings on npmjs.com name this repository and `release.yml` as its
trusted publisher.

## More documentation

The documents in [`docs/`](docs/) go deeper, and some describe the design of milestones not built
yet:

- [The product](docs/product.md): what Wheems is, and the opinions it holds
- [Getting started](docs/getting-started.md): the setup walk-through
- [Architecture](docs/architecture.md): what's built and what's planned: projects, tasks and their evaluation, routines, workflows, the vault, with a worked example
- [Config formats](docs/config.md): every config file, including the parts not used yet
- [Drivers and plugins](docs/drivers.md): the contracts and their contract tests
- [The Herdr runtime driver](docs/herdr.md)
- [Roadmap](docs/roadmap.md): the milestones and open questions
- [Milestone 2 plan](docs/plans/milestone-2.md) and its [research](docs/research/knowledge-loop.md)
- [Architecture ideas](docs/ideas/architecture.md), the [two design proposals](docs/ideas/proposal-claude.md) ([and the other](docs/ideas/proposal-codex.md)) and [the decisions taken](docs/ideas/decisions.md)

## Licence

[Apache 2.0](LICENSE)
