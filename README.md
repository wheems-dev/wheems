<p align="center">
  <img src="https://wheems.dev/brand/wheems-icon-512.png" alt="Wheems" width="112">
</p>

<h1 align="center">Wheems</h1>

> [!WARNING]
> **Early preview (0.x).** Wheems isn't ready for real use yet. Everything may change between
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
- [The web app](#the-web-app)
- [Doctor and configuration validate](#doctor-and-configuration-validate)
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
   └── answers ◄──┘◄── wheems chat, knowledgebase, skill ◄──┘
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
| Check everything | Runs `wheems doctor` (`wheems doctor --fix` offers fixes).                                                                                                                                     |

When you choose **Done** with the service running, your first chief of staff (the one in direct
messages) says hello in chat. It says it's set up and how to talk to it, and that inviting it to any channel adds another chief. That happens once per install; if the greeting can't be sent, setup says why.

### Connecting Slack

One Slack app serves every workspace, so you do this once.

1. Setup copies the app's manifest to your clipboard and offers to open
   <https://api.slack.com/apps?new_app=1>. Choose **From a manifest**, pick your Slack workspace
   and paste. The app uses Socket Mode, so it needs no public address. (`wheems channel manifest slack`
   prints the manifest.)
2. Choose **Install to workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
3. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write`
   scope (`xapp-…`).
4. Paste both tokens when setup asks. They're masked as you type, checked with Slack, and saved
   to `~/.config/wheems/secrets.json`, readable only by you. They never pass through an agent.
5. Give your Slack member ID (your profile, **⋯**, **Copy member ID**). Only people on this list
   can talk to your agents. Messages from anyone else are ignored.

### Inviting the app to a channel

You use the terminal once, for `wheems setup`; everything after that happens in chat. To add
another chief of staff, invite the app to a Slack channel (type `@Wheems` there, or `/invite`,
and accept). Wheems says it isn't set up there yet and asks for a name. Reply in its thread with
one, such as `Marketing`, and Wheems creates the workspace with its chief, on the same engine
and account as your first, and the chief answers in that channel at once. There's nothing to
restart.

- Only people in `allowed_users` get the offer. It's made once per channel, and again after the
  service restarts if no one answered.
- A name counts in the offer's thread, or alone in the channel if it's just a short name (up to
  four words). Ordinary chatter isn't taken for one.
- A workspace you made with `wheems init <id> --channel <name>`, or whose channel the app
  couldn't see, starts answering as soon as you invite the app there, and its chief says so.
- The offer comes the moment the app is invited, through Slack's `member_joined_channel` event,
  which the manifest subscribes to. An app made before this version needs that event added under
  **Event Subscriptions → Subscribe to bot events** (no new scope). Without it, the offer comes
  with your first message in the channel.

Slack lists public channels the app isn't in, so a channel name that's spelt right can still
hear nothing until you invite the app. The service warns at start-up, `wheems doctor` checks
it, and `wheems status` shows it while the service runs.

### Trusting the install folder

Claude Code and Codex ask once whether to trust a folder, and nobody can answer that from chat.
You approve the install folder once, and every session Wheems starts beneath it, chiefs' and the
sessions they start, runs without a trust question. A trusted folder covers every folder in it,
so this covers every workspace and session, including ones added later.

When setup creates a workspace, it asks once: _Let Wheems mark ~/wheems as trusted for Claude
Code and Codex?_ On a yes, Wheems writes the same entry the engine writes when you say yes to
its question, and changes nothing else in the file:

| Engine      | Where                                             | What                                                   |
| ----------- | ------------------------------------------------- | ------------------------------------------------------ |
| Claude Code | `~/.claude.json` (in `$CLAUDE_CONFIG_DIR` if set) | `projects["<folder>"].hasTrustDialogAccepted = true`   |
| Codex       | `~/.codex/config.toml` (or `$CODEX_HOME`)         | `[projects."<folder>"]` with `trust_level = "trusted"` |

It's careful with both files, which hold much more than trust:

- it refuses to write a file it can't fully parse, and checks the result differs by that one
  entry only;
- it writes a new copy beside the file and renames it into place, keeping its permissions;
- if the engine changed the file meanwhile, it starts again from the new contents, and after a
  few tries gives up and says so;
- for Claude Code, it holds the lock Claude Code itself takes to save the file
  (`~/.claude.json.lock`), so Claude Code can't save in between;
- Codex has no such lock, so Wheems changes `config.toml` only while no Codex is running (the
  app or a CLI session), checked before it reads and again just before it writes. While one
  runs, it leaves the file alone and says so: close Codex and try again, or answer Codex's own
  question (`cd ~/wheems && codex`).

The Claude Code flag is Claude Code's internal state, not a documented setting (though Claude
Code's own messages tell you to set it), so a new version could move it. That's why `wheems doctor` checks the trust every time, rather than
assume it lasts. `wheems doctor --fix` and `wheems engine trust <engine>` offer the same for an
install made before this. To do it by hand instead, run `cd ~/wheems && claude` (or `codex`) and
answer yes.

If a message arrives for an engine that doesn't trust the folder, the service says so in the
thread at once, with the step to take, rather than start a session that would wait at the Mac.
A chief's `wheems session create`, and a `session send` that would resume a stopped session,
are refused the same way, with a reason the chief passes on, rather than start a session that
waits at a question nobody sees.

### Without the menu

Each part has a command of its own, for scripts. `wheems workspace create` creates the install
too when there isn't one, so a fresh machine can start there. `wheems channel connect slack` and
`wheems engine install` run setup's own steps, because you type tokens and sign in yourself:

```bash
wheems workspace create default                                   # a workspace on Claude Code
wheems workspace create acme --channel acme-chat --engine codex   # chat in a channel, on Codex
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

`wheems workspace create <id>` creates `workspaces/<id>/` (`wheems workspace list`, `show`,
`rename`, `archive`, `restore` and `remove` look after them; see the command reference):

```text
workspaces/default/
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
writing notes, searching the knowledge base, proposing skills and, for a chief, its role, its team
and starting sessions. Don't edit the instructions
file: it's rewritten at every launch and ignored by git.

`permissions` says how much an agent may do without asking:

| Level           | Meaning                                                     | Claude Code                      | Codex                                        | opencode |
| --------------- | ----------------------------------------------------------- | -------------------------------- | -------------------------------------------- | -------- |
| `ask` (default) | The engine's normal prompts                                 | (none)                           | (none)                                       | (none)   |
| `auto`          | The engine decides routine actions, and asks for risky ones | `--permission-mode auto`         | `--approve-for-me`                           | `--auto` |
| `skip`          | Never asks                                                  | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--auto` |

A prompt means someone has to answer it at the Mac, so a chief of staff you talk to from your
phone usually runs on `auto`.

### The chief of staff and its team

You only ever talk to the chief of staff. **The chief manages and delegates, and never does the
work itself**: it reads and answers, and its team makes and changes things. "Look at this email
and tell me what you think" is the chief's; replying to it, a fix of any size, or research beyond
a quick lookup goes to the team. Every chief gets this as a built-in **Your role** section,
which comes before anything in its own agent file that says otherwise.

**The team** is the workspace's other agent files. Each is an agent in the same format as the
chief, on any engine and model, and its `description` says when to use it:

```markdown
---
description: Builds and fixes the website. Use for any code.
engine: codex
model: gpt-6.1-sol
account: chatgpt-subscription
permissions: auto
---

# Developer

You build and fix the website, in small, tested steps.
```

The chief is told its team in a generated **Your team** section, with each agent's name, engine,
model and description, as the service last loaded them (restart the service after adding one). It
hands work to an agent with `wheems session create <name> …`, and to a general member of the team,
on the chief's own engine, for work no agent fits. When the same kind of work keeps coming up, it
suggests an agent for it. The chief creating agents itself, and a Team page in the web app, are
planned; see [docs/team.md](docs/team.md).

A chief made before 0.1.9 has an agent file that says "Do what you're asked, end to end". The
built-in role overrides it, but it's worth editing the file to describe the chief's goal instead,
as a new one does under **What we're working towards**.

## Talking to agents

Message the Slack app (or the workspace's channel). Each message you send starts a
**conversation**, and replies in its thread carry it on.

- Each conversation is its own engine session in Herdr, named after the workspace with a short
  id for the thread, such as `default-3f9a2c1b`. Watch it or take over with
  `hc attach <session>`.
- A 👀 reaction means your message has reached the agent. It goes when the agent answers.
- The agent's last message of each turn is posted to the thread as its answer. The answer is
  read from the engine's own record of the conversation, never from the screen.
- For long work, the agent sends a short progress note first with `wheems chat reply "…"`.
- Messages sent while the agent is working are passed on when it finishes its turn.
- Each workspace keeps at most four sessions running. The least recently used idle one is
  stopped to make room, and its conversation resumes where it left off when you next reply.
- **A chief that can't answer says so in the thread**, with what's wrong and the one step that
  fixes it, rather than staying silent:
  - its engine doesn't trust the install folder;
  - its engine isn't signed in (Wheems asks the engine before starting a session);
  - it's waiting for an answer at the Mac, such as a permission prompt (`hc attach …`);
  - it hasn't started on the message, or hit an error;
  - its session failed to start (`wheems doctor --fix`).

  Each problem is said once per workspace, not on every message, until the chief answers
  again. The notices go through the channel driver, so they work on any channel.

## Sessions

Besides a session per chat thread, a chief can start **ad-hoc sessions**: other agent sessions
that work on one thing and stay open until they're ended, so the chief can come back to them.
You only ever talk to your chief. Ad-hoc sessions have no channel or thread of their own: they
work behind the chief, and it tells you what you need to know.
Ask your chief "open a session to research packaging suppliers and keep it going", and it runs:

```bash
wheems session create --title "Packaging suppliers" \
  --purpose "Find five UK packaging suppliers, with prices and minimum orders." \
  --done-when "suppliers.md lists five UK suppliers, each with a price, a minimum order and a link."
```

- **Every job a chief hands on has a finish line.** `--done-when` says what must be true when
  it's finished, in things that can be checked: a test that passes, a page that loads, a file
  that exists. A chief must give one; anyone else may. The session sees it in its instructions,
  and is told to hand back evidence (what it ran and what that showed, links, files, commits),
  not "should work".
- **Each answer comes with the finish line,** to check it against, and a count ("Answer 2 from
  this session"), whether it's handed back or waited for with `--wait`. The chief sends a job back
  at most twice. From the third answer, Wheems tells it to
  stop and bring the job to you, with what was tried and what's missing. That's an instruction
  for now, not a block, since a chief may also send a session follow-up work.

- The session starts working on its purpose at once, in Herdr, and stays open until it's ended.
  It runs another of the workspace's agents when one is named
  (`wheems session create researcher …`). Without one, it runs a general member of the team on the
  chief's engine, model and account, since the chief's own file is written for managing.
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

A chat thread can start over with `wheems session restart <id>`, where `<id>` is its session's
(`wheems session list --kind thread`). By default its chief **hands over**: Wheems asks it, in a
turn whose answer is never posted, to write a handover with `wheems session handover`: what you
asked, what's done, what's in progress, decisions, open questions and promises. Its session
stops, and the thread's next message starts a new session from the handover; Wheems posts a line
in the thread saying so. When the chief can't write one (it isn't running, or doesn't finish in
time), Wheems writes one from the thread's ask and its latest messages, and says so. With
`--fresh`, the next session starts with only the thread's ask; with `--carry-on`, its session
just stops, and the next message resumes it as it was, on the settings then; that's refused when
the chief's agent file now names a different engine, since the new engine never had the thread. A
thread answering a
message is left alone, and so is one whose session Herdr can't say is running. Only you restart
threads, from a terminal or the web app; an agent can't. See [docs/session-handover.md](docs/session-handover.md).

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
Inside an ad-hoc session, `wheems chat reply` is refused, since there's no chat to reply in: it
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

Agents write notes with `wheems knowledgebase note`, which reads Markdown on standard input:

```bash
wheems knowledgebase note - <<'EOF'
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
wheems knowledgebase search "what did we decide about the boat name"
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

- `wheems knowledgebase reindex` builds a fresh index and swaps it in when it's done, so search
  keeps working meanwhile. When the service is running, it does the rebuild.
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

`wheems status` (and `wheems start`, once it's up) shows the version, how long it has been up, the
chat connections, each workspace's channel, with what stops one from chatting, such as a channel
the app hasn't been invited to, and the web app's address, which you can click to open it:

```text
✓ Running: Wheems 0.0.4, pid 4242, up 2h 14m
✓ Connected to slack
✓ default: direct messages on slack
! marketing: the app can't see #marketing-chat on slack. Invite the app to the channel, and the chief of staff answers there at once; or check the name in workspace.yaml.
✓ Web app: http://127.0.0.1:4317/#token=…
Log: ~/wheems/.wheems/logs/service.log
```

It runs as the launchd agent `dev.wheems.service`
(`~/Library/LaunchAgents/dev.wheems.service.plist`), with the Node.js and the copy of Wheems you
started it with; `wheems restart` picks up a newer one. Its log is
`~/wheems/.wheems/logs/service.log`. It refuses to start when the config has errors, and the log
says why: `wheems start` prints the end of the log when it doesn't answer. Run `wheems doctor`
to see the errors. The commands are also under `wheems service` (`wheems service start` and so
on).

The service answers once it has connected to every chat app. When this Mac can't reach one, such
as when the internet connection drops, it keeps trying in the background and starts answering
when it gets through. `wheems start` waits 30 seconds, then
says which chat app it can't reach rather than printing the log:

```text
It hasn't answered yet: it answers once it has connected to every chat app, and it can't yet.

  ✗ slack: Slack: Couldn't reach Slack (fetch failed)
      Check this Mac's internet connection. Wheems keeps trying on its own.

It keeps trying in the background. See when it connects with: wheems status
```

Running `wheems start` again restarts it and starts the wait over, so there's no need: check
`wheems status` instead.

Agents reach the service through the `wheems` command, which Wheems puts first on each session's
`PATH`, pinned to the same Node.js and the same copy of Wheems. The command talks to the service
over a Unix socket in `.wheems/` that only you can open.

### The session store

The service keeps a record of every session it runs in `.wheems/state.sqlite`, using Node's
built-in SQLite: each workspace's chief, written from config every time the service starts, and
each chat thread with the session it talks to, where the answers have got to and its notes.
Herdr says whether a session is running; the store says what it's for, including **what you
asked**: a thread's first message, which every session started for it inherits and is reminded
of, so work handed down stays tied to it (`wheems session show` prints it as "Asked"). It also
keeps what's said in each chat thread, for the web app to show, and each thread's handovers.
Version 5 of its schema adds handovers: opening a store with Wheems 0.1.8 brings it up to 5, after
which an older Wheems won't open it. Every session Wheems
starts is labelled `wheems=<session id>` in Herdr, and when the service starts it matches the
store against Herdr: a session whose Herdr session has gone is marked stopped, and resumes when
it's next needed.

Only the service writes to the store. Its schema version is kept in the file and brought up to
date when the service starts. The first time a Wheems with the store starts, it imports
`.wheems/conversations.json` and renames it `conversations.json.imported`. If it can't read the
file, it leaves it where it is and won't start, and the log and `wheems doctor` say why: fix the
file, or remove it to start its threads afresh, then run `wheems restart`.

## The web app

A page in your browser for seeing what Wheems is doing: pick a workspace at the top of the
sidebar, then its **Overview** (its chief of staff with the sessions working for it as a tree,
the knowledge base and skills), its **Sessions** (each one's state, what you originally asked,
its purpose and latest messages, including its chat thread's), its **Review** (skills its agents proposed) and its
**Settings**. For the whole install there are **Connections** (chat channels, integrations and
engine accounts, and which workspaces use each), **About you** (`about-you.md` and the changes
suggested for it) and **Setup and health** (doctor's checks). It follows your computer's light or
dark setting, or the switch at the bottom of the sidebar.

```bash
wheems web open           # open it in your browser
wheems web run            # serve it on its own in this terminal, until Ctrl+C
```

The service serves it whenever it runs, so `wheems start` starts it too, on `127.0.0.1` port 4317
(`$WHEEMS_WEB_PORT` or `--port` to change it). From it you can approve or decline what your agents
propose, send a message to a session or end it (ending and declining ask first), and edit a
workspace's settings, then restart the service to use them. A chat
thread's session hears you in its thread, so for those the page says to reply there, and offers
**Hand over** and **Start fresh** instead. Changing the chief's engine, model, account or
permissions asks what happens to each conversation already open, as `wheems session restart`
does, before the restart. When the
service stops, the page says it can't reach Wheems. For anything else, use the commands it
names. Only this computer can reach it, and only with the link `wheems web open`
gives, which carries a token kept in `.wheems/web-token`. What comes next is in
[docs/web-app.md](docs/web-app.md).

## Doctor and configuration validate

`wheems doctor` checks everything, in sections:

| Section    | Checks                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| System     | Node.js version and platform                                                                                                 |
| Herdr core | `hc` is installed, new enough and answering. It also starts a tiny test session and removes it again (`--quick` skips that). |
| Config     | Every config file, and the links between them                                                                                |
| Agents     | Each engine is installed and signed in, and trusts each workspace folder and the folder sessions start in                    |
| Channels   | Each Slack connection can be reached and its tokens work; an offline Mac fails in seconds, saying Slack couldn't be reached  |
| Knowledge  | The embeddings driver and model, the vector store, and each workspace's search index                                         |
| Review     | What waits for `wheems review`                                                                                               |
| Service    | Whether the service is installed and answering, and the session store (see below)                                            |

It exits with 1 when anything fails. `--json` prints the report as JSON.

`wheems doctor --fix` offers to fix what it safely can. For each problem it says what's wrong and
what the fix will do, and asks first (no unless you say yes); then it checks again. It never
fixes anything silently, and never changes the chat app's settings or tokens. It can:

- mark the install folder trusted for an engine, as setup does (see
  [Trusting the install folder](#trusting-the-install-folder));
- start or restart the service, which also imports `conversations.json` and brings the session
  store up to date;
- rebuild a search index that can't be read or was built for another model;
- write a channel name the app can see into `workspace.yaml`, when the one there is a near miss
  (a typo).

Anything else keeps its hint: inviting the app to a channel, for one, is yours to do in Slack.

The session store check warns about a Herdr session with a Wheems label (`wheems=<session id>`)
that the store has no record of. Wheems never adopts or removes one; stop it with `hc kill` if
nothing needs it. It also warns when `.wheems/conversations.json` from an older Wheems is still
waiting to be imported, and fails when it can't be read.

`wheems configuration validate` checks config files or a whole install folder, with line numbers:

```bash
wheems configuration validate                       # the install folder
wheems configuration validate examples/install      # another one
wheems configuration validate workspaces/acme/workspace.yaml
```

For a folder it also checks the links between files. Names must point at things that exist, and
each level may only pick from the level above: a workspace from the install's accounts, an agent
from its workspace's skills. Pinned skill versions must exist in the library.

## Command reference

Commands are grouped by area, like Laravel's `php artisan`: `wheems <area> <action> [name]
[--options]`. `wheems list` prints them all by area, `wheems <area> --help` one area's, and
[docs/cli.md](docs/cli.md) has the rules for adding more. Commands that use the install take
`--home <dir>` (default: `$WHEEMS_HOME`, then `~/wheems`); every `list` and `show` takes `--json`.

**Start here, and every day**

| Command                                     | What it does                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `wheems`                                    | The welcome screen: the cloud, and how the install is doing (workspaces, the service, search, review) |
| `wheems setup`                              | The setup menu: engines, Slack, workspaces, knowledge, the service, doctor                            |
| `wheems doctor [--quick] [--json] [--fix]`  | Checks the machine, Herdr core and the install; `--fix` offers safe fixes, asking before each         |
| `wheems list`                               | Every command, grouped by area                                                                        |
| `wheems review [--list]`                    | Goes through skill proposals and changes to `about-you.md`                                            |
| `wheems status`, `start`, `stop`, `restart` | Shortcuts for `wheems service …`                                                                      |
| `wheems logs [-n] [-f]`                     | Shortcut for `wheems service logs`                                                                    |

**workspace** (`ws` for short)

| Command                                                                  | What it does                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `wheems workspace list [--archived]`                                     | The workspaces, where each chats and what its chief runs on; with `--archived`, the archived ones                                             |
| `wheems workspace show <id>`                                             | A workspace's folder, chat, agents and knowledge base                                                                                         |
| `wheems workspace create <id> [--name] [--channel] [--engine] [--model]` | Creates a workspace with its chief of staff (and the install, if there is none). `--engine` is `claude-code` (default), `codex` or `opencode` |
| `wheems workspace rename <id> <name>`                                    | Changes its display name (and its chief's, if that followed the old one); the id and folder stay                                              |
| `wheems workspace archive <id> [--yes]`                                  | Stops serving it (its sessions stop) and moves it to `archive/<id>/`, keeping everything                                                      |
| `wheems workspace restore <id>`                                          | Brings an archived workspace back                                                                                                             |
| `wheems workspace remove <id> [--yes]`                                   | Deletes it for good: its folder and knowledge base, its sessions, messages and search index, and its records. You type its id to confirm      |

**session, knowledgebase, skill**

| Command                                                             | What it does                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `wheems session create [agent] --title --purpose [--done-when]`     | Starts an ad-hoc session, owned by you, and prints its id. A chief must give `--done-when`           |
| `wheems session list [--mine] [--agent] [--state] [--kind] [--all]` | Sessions in a workspace, most recently active first; open ones unless `--all`                        |
| `wheems session send <id> "…" [--wait] [--timeout <s>]`             | Sends a message into a session, resuming it if stopped; prints its answer with `--wait`              |
| `wheems session search "…"`, `show <id>`, `end <id>`                | Finds sessions, shows one with its latest answer and messages, or ends one after asking for its note |
| `wheems session restart <id> [--fresh] [--carry-on]`                | Starts a chat thread's session over: from a handover its chief writes, afresh, or just resumed       |
| `wheems knowledgebase search <query...> [--workspace] [--limit]`    | Searches a workspace's knowledge base (`$WHEEMS_WORKSPACE`, or the only one; 5 results)              |
| `wheems knowledgebase reindex [--workspace]`                        | Rebuilds search indexes, every workspace's by default                                                |
| `wheems skill list`, `show <name> [version]`                        | Lists the library and waiting proposals, or prints a skill's `SKILL.md`                              |

**channel, engine, service, configuration**

| Command                                                     | What it does                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `wheems channel list`                                       | The chat connections, whether each is connected, and which workspace chats where     |
| `wheems channel connect <driver>`                           | Connects a chat app, such as `slack`: its own steps, then its tokens saved privately |
| `wheems channel manifest <driver>`                          | Prints a chat app's manifest to create the app from (Slack has one)                  |
| `wheems engine list`                                        | Each engine: installed, signed in, and whether it trusts the install folder          |
| `wheems engine install <engine>`                            | Installs an engine, asking first, then offers to sign it in                          |
| `wheems engine login <engine>`                              | Runs the engine's own sign-in on this terminal                                       |
| `wheems engine trust <engine>`                              | Asks to mark the install folder trusted for the engine, as setup does                |
| `wheems service start`, `stop`, `restart`, `status`, `logs` | The background service (the top-level shortcuts do the same)                         |
| `wheems service run`, `uninstall`                           | Runs the service in this terminal, or removes it from launchd                        |
| `wheems configuration validate [paths...]`                  | Validates config files or install folders                                            |
| `wheems web open [--port]`                                  | Opens the web app in your browser (the service serves it)                            |
| `wheems web run [--port]`                                   | Serves the web app on its own in this terminal, until Ctrl+C                         |

**For agents** (these work only inside a session Wheems started)

| Command                                                          | What it does                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `wheems chat reply "…"` or `wheems chat reply -`                 | Posts a progress note to the conversation's thread            |
| `wheems knowledgebase note "…"` or `wheems knowledgebase note -` | Saves a note to the workspace's inbox                         |
| `wheems knowledgebase search "…"`                                | Searches the agent's own workspace                            |
| `wheems skill propose <name> [-]`                                | Proposes a skill, read from standard input, for you to review |
| `wheems session handover -`                                      | Saves a handover for its thread's next session, when asked    |
| `wheems session …`                                               | The session commands above, in the agent's own workspace      |

In a workspace's folder (`~/wheems/workspaces/acme/…`), commands that take `--workspace` default
to that workspace, the way Artisan finds the project it's run in. Inside an agent's session they
always use its own.

Older names still work for a release and say what they're called now: `wheems init` (now
`workspace create`), `wheems validate` (now `configuration validate`), `wheems slack manifest`
(now `channel manifest slack`), `wheems service install` (now `service start`), `wheems reply`
(now `chat reply`), `wheems note` (now `knowledgebase note`) and `wheems session new` (now
`session create`). The `kb` and `config` areas are now `knowledgebase` and `configuration`; the
short names stay working, hidden, so agents' prompts and skills that use `kb` don't break.

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
name: Default
accounts: [claude-subscription] # install accounts this workspace may use
chief_of_staff: chief-of-staff # the file in agents/; this is the default
channels:
  chat: { connection: slack, direct: true } # or { connection: slack, channel: acme-chat }
identity: { name: Chief of staff, icon: ':house:' } # how its posts appear
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

| Variable              | Meaning                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `WHEEMS_HOME`         | The install folder (default `~/wheems`)                                                     |
| `WHEEMS_SECRETS`      | The secrets file (default `~/.config/wheems/secrets.json`, or under `$XDG_CONFIG_HOME`)     |
| `WHEEMS_WORKSPACE`    | The workspace `wheems knowledgebase search` searches. Wheems sets it in every agent session |
| `WHEEMS_CONVERSATION` | The chat thread a thread session's commands belong to. Wheems sets it in those sessions     |
| `WHEEMS_SESSION`      | The session an agent's commands come from. Wheems sets it in every agent session            |
| `WHEEMS_WEB_PORT`     | The port on `127.0.0.1` the web app uses (default 4317)                                     |
| `WHEEMS_NO_ANIMATION` | Set to anything to stop the cloud winking on the welcome screen and in `wheems setup`       |

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

| Milestone | What it brings                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 to 2    | Done: the skeleton, talking to a chief of staff from Slack, and the knowledge loop (their tests in daily use are still to come)                                                                                                                                                                                                        |
| 3         | Sessions, approvals and updates: a record of every session, so a chief can start sessions, find them and talk to them; a chief that delegates to its team rather than doing the work; approvals that sub-agents ask their chief for, with buttons on your phone for what's yours to decide; updates; and a first version of the broker |
| 4         | Projects: any body of work as a project, with its own knowledge base and an optional lead on the chief's team, and the chief routing questions and work to them                                                                                                                                                                        |
| 5         | Tasks and a team: the hand-off between agents, evaluated in code, by a judge and by you; routines; pairs; more accounts                                                                                                                                                                                                                |
| 6         | A second workspace, kept apart                                                                                                                                                                                                                                                                                                         |
| 7         | Workflows and evals: DAGs, triggers from email and other services, classify then act, shadow mode, and creating workflows by asking                                                                                                                                                                                                    |
| 8         | Data and blueprints: small data apps such as a CRM, built from a blueprint                                                                                                                                                                                                                                                             |
| 9         | Integrations, guardrails and the vault: `integration connect` and `grant`, the Keychain, GitHub rules, and purchases you approve                                                                                                                                                                                                       |
| 10        | Always on, more channels, more machines: a server, laptops collecting work, `wheems machine run`, Telegram and email                                                                                                                                                                                                                   |
| 11        | Plugins and release: `create` commands for every area, npm plugins, and the open-source release on npm                                                                                                                                                                                                                                 |

Alongside them comes **the web app**: a local page from the service, organised by workspace. Its
pages are built, and you can review proposals and talk to sessions from it; editing settings and
connecting things from it come next. See [docs/web-app.md](docs/web-app.md).

Until milestone 10 the service runs on your Mac under launchd, so agents answer only while it's
awake. [docs/architecture.md](docs/architecture.md) designs the planned parts and marks what's
built, with a worked example: growing a website into a lead generator.
[docs/cli.md](docs/cli.md) has how the commands are organised. [docs/ideas/](docs/ideas/) keeps the original ideas, the two design proposals and the
[decisions](docs/ideas/decisions.md) taken from them.

## Developing Wheems

```bash
npm install
npm run check              # lint, typecheck, test and build, as CI does
npm test                   # tests only
npm run schemas            # regenerate schemas/*.schema.json after changing src/config/schemas.ts
npm run wheems -- doctor   # run the CLI from source
npm run dev:web            # the web app with live reload, using the Wheems running on port 4317
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
| `src/web/`          | The web app's server: its JSON API, what it reads, and its actions               |
| `web/`              | The web app itself: React, built with Vite into `dist/web/app`                   |
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
- [The `wheems` command](docs/cli.md): how the commands are organised by area, and the rules for adding one
- [Config formats](docs/config.md): every config file, including the parts not used yet
- [Drivers and plugins](docs/drivers.md): the contracts and their contract tests
- [The Herdr runtime driver](docs/herdr.md)
- [Roadmap](docs/roadmap.md): the milestones and open questions
- [The web app](docs/web-app.md): the planned local page, organised by workspace
- [The chief of staff and its team](docs/team.md): you only talk to the chief, which delegates and manages the work (proposal)
- [Approvals and updates](docs/approvals.md): asking and waiting for a decision, through the chief (proposal)
- [Session handover](docs/session-handover.md): handing a chat thread over to a new session
- [Milestone 2 plan](docs/plans/milestone-2.md) and its [research](docs/research/knowledge-loop.md)
- [Architecture ideas](docs/ideas/architecture.md), the [two design proposals](docs/ideas/proposal-claude.md) ([and the other](docs/ideas/proposal-codex.md)) and [the decisions taken](docs/ideas/decisions.md)

## Licence

[Apache 2.0](LICENSE)
