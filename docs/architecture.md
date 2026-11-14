# Architecture

Wheems is a small TypeScript service that's always running, a command agents call, and a
folder of config, with Herdr core underneath.

Messages from Slack or Telegram reach the service, which routes them to the right
workspace's agent through Herdr: one conversation, and one engine session, per chat thread. A
thread's later messages go to the same session, and a session that has ended is resumed. The
service posts each answer, read from the engine's own record of the conversation, and agents
send progress notes, ask for approval or leave notes by running the CLI, which talks to the
service over a private Unix socket.

Wheems is for business work generally, not only code: answering email, replying to reviews,
finding and following up leads, keeping a website growing. It's **a harness first, with
workflows when you want them**: talking to a chief always works, and nothing needs a workflow.
See [Harness first](#harness-first-workflows-when-you-want-them).

**Built or planned.** Sections say which. "Built" is in the code today; "planned (milestone N)"
is designed here and arrives with that milestone of the [roadmap](roadmap.md). The decisions
behind the planned parts are in [ideas/decisions.md](ideas/decisions.md).

**Why TypeScript on Node.** Claude Code and Codex already need Node on every agent machine,
so it adds no new runtime. Slack's main Bolt library and the main Claude Agent SDK are both
TypeScript first.

## The parts

- **The service**: always running, under launchd on a Mac and systemd on Linux. It holds the
  channel connections and routes messages, files notes, keeps search indexes and runs the
  nightly tidy (built). It will also run tasks, approvals, routines and workflows, and keep a
  small SQLite store of every session it runs (built) and what's waiting (planned), see
  [Sessions](#sessions).
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

## When something's wrong, say so in chat

Part of using the terminal once, then everything else in chat (built):

- **Setup ends with a hello.** When setup finishes and the service runs, the first chief (the one
  in direct messages, else the first in a channel) greets the person through the channel driver.
  It says it's set up, and that inviting it to any channel adds another chief. This happens
  once per install (`.wheems/greeted.json`), through the service's `greet` control
  request. If it can't be sent, setup says why. To write first in direct messages, a driver
  offers the optional `openDirect(userId)`; Slack's is `conversations.open`, under the `im:write`
  scope it already has.
- **A chief that can't answer says so**, in the thread, with what's wrong and the one step that
  fixes it:
  - the engine doesn't trust the folder, or isn't signed in. The engine's own `signedIn()` is
    asked before a session starts, and a yes is kept for ten minutes;
  - it's waiting at the Mac, or hasn't started on the message;
  - it hit an error, or its session failed to start.

  Each problem is said at most once per workspace, until it's fixed: when the chief answers
  again, or the check that failed passes. Later messages only log it. It's channel-agnostic: a
  notice is a post through the `ChannelDriver`.

- **`wheems doctor --fix`.** Doctor attaches a fix to each check it can fix safely, and `--fix`
  asks before running each one. The fixes: trusting the install folder (it opens the engine
  there), starting or restarting the service, rebuilding a stale search index, and correcting a
  near-miss channel name in `workspace.yaml` from the channels the app can see (the optional
  `listChannels`). It never changes the chat app's settings or tokens.

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
│   └── skills/<name>/<n>/SKILL.md   every version of every skill
└── workspaces/
    └── acme/
        ├── workspace.yaml    chief of staff, channels, rules, accounts
        ├── agents/           one Markdown file per agent
        ├── skills.yaml       chosen skills and pinned versions
        ├── workflows/        one YAML file per workflow
        ├── projects/         planned (4): one folder per project, see Projects
        │   └── support/
        │       ├── project.yaml
        │       ├── agents/   agents only this project uses, such as its lead
        │       └── knowledge/   the same shape as the workspace's
        ├── .claude/          planned (6): this workspace's own Claude Code config
        └── knowledge/
            ├── brief.md      short, capped; every agent here loads it at launch
            ├── activity.md   planned (4): one line per filed project note, newest first
            ├── cards/        planned (4): one generated card per project
            ├── inbox/        notes land here, from wheems note
            ├── notes/        filed notes, kept as the sources
            ├── pages/        the knowledge base, one topic per page
            └── reports/      nightly: contradictions and stale pages
```

Running state, never committed, lives in `.wheems/`: the control socket, logs, the session store
(`.wheems/state.sqlite`, which replaced `conversations.json`; see
[The session store](#the-session-store)), the filer's working copies, the search indexes
(`.wheems/index/`) and what waits for review (`.wheems/review/`).

Agents are told never to write into `knowledge/` or `about-you.md` themselves; that's an
instruction, not a lock, until permission rules arrive (milestone 6). They write notes with
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

### The nightly tidy

Once a night, at `knowledge.tidy_at` in workspace.yaml (03:00 local time by default), the filer
reads the whole knowledge base and writes two reports: `reports/contradictions.md`, where pages
disagree with each other or with the brief, and `reports/stale.md`, pages that look out of date.
It refreshes the brief from the pages as they are. It changes no page: Wheems keeps only the
reports and the brief, checks them as it checks filing (the brief under its cap, nothing that
looks like a credential), and commits them. A service that was stopped at that time tidies when it
starts. A night when no page or the brief changed since the last tidy is skipped, as is a
workspace with no pages, so it costs nothing when there's nothing new. The tidy waits for any
note being filed in the workspace, and a page edited meanwhile means nothing is applied that
night. From milestone 5 it also looks for requests that repeat (see
[Learning what repeats](#learning-what-repeats)).

### Skills and review

A skill is how to do a task that comes up again, in the [Agent Skills](https://agentskills.io)
`SKILL.md` format. The install's library holds every skill at every version
(`library/skills/<name>/<n>/SKILL.md`). A workspace pins the versions it uses in `skills.yaml`,
and each agent lists the skills it uses, so a skill reaches only the agents it was given to.

Agents learn to propose skills from their built-in instructions:

- `wheems skill list` and `wheems skill show <name>` show the library, so an agent improves an
  existing skill rather than adding another, and reads it before changing it.
- `wheems skill propose <name>` takes the whole SKILL.md on standard input. The service checks
  it (front matter with a name and description, instructions, at most 64 KB, nothing that looks
  like a credential) and saves it to `.wheems/review/skills/`, with the workspace, agent and
  conversation it came from. It never reaches the library without you.
- Each proposal is compared with every skill in the library and every other proposal. With an
  embeddings driver that says what a near-duplicate scores (0.8 for `nomic-embed-text`), the
  comparison is by meaning; otherwise, by the share of words they have in common. The agent is
  told which skills it may repeat, and so are you when you review it.
- A skill whose latest version a person wrote can't be changed by an agent: the proposal is
  refused, and the agent is told to tell you what it would change instead.

`wheems review` goes through what waits for you: skill proposals and suggested changes to
`about-you.md`. It shows a new skill in full, and a change as a diff against the version it
changes. For each, you approve it, edit it in your editor (`$VISUAL` or `$EDITOR`) and approve
that, turn it down, or leave it for later. Approving a skill adds it to the library as the next
version, pins that version in the proposing workspace's `skills.yaml`, and asks which of its
agents get it (the agent that proposed it is ticked to begin with); then it commits. Approving
a change to `about-you.md` writes it and commits. Outside a terminal, `wheems review` only lists
what waits, and `wheems doctor` says how much does.

Approved skills are recorded and pinned, but not yet written into agents' sessions, because
today every agent in a workspace runs in the workspace's folder. From milestone 5 each agent
session gets a folder of its own, and the engine driver writes only that agent's pinned skills
there (see [Tasks](#tasks)).

`WHEEMS_HOME` moves the install folder.

## Harness first, workflows when you want them

Talking to a chief always works, and nothing requires a workflow. When a job repeats, it can be
hardened, one step at a time, as far as it needs to be. A repeated job sits at one of three
tiers, chosen per job (planned, milestones 5 and 7):

| Tier                | What it is                                                                | What's guaranteed                                      | How it's evaluated                                                                                                              |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Routine**         | A schedule or an event, one agent and one skill, run as a single task     | When it runs, who runs it, what it may touch           | Its output: acceptance criteria checked in code, a rubric judge, your feedback, and consistency between runs                    |
| **Skill procedure** | A routine whose skill lists steps for the agent to follow                 | Nothing about order or completeness, beyond the broker | Its trace: expected steps against the steps the agent marked and the calls the broker recorded. Detects drift; can't prevent it |
| **Workflow**        | A DAG: steps, order, gates and checks run by Wheems; agents only in steps | Order, approvals, checks between steps, recorded runs  | Per step and end to end, plus evals on a golden set                                                                             |

**Rule of thumb.** A single output for you to read, such as a morning brief, is a routine.
Several touchpoints, side effects outside (sending, publishing, money, customers), approvals in
the middle, or hand-offs between agents make a workflow. A skill procedure is promoted to a
workflow when its trace checks show drift, or as soon as it acts on the outside world.

**Hardening is a path, not a switch.** You ask the chief for something in chat. When the chief
notices the same request coming back, it offers to save it as a routine or a workflow
("creating workflows by asking"). A new routine or workflow that acts on the outside world starts
in **shadow mode**, proposing each action for your approval, and its steps graduate to acting on
their own as their evaluation earns it.

**Both directions use the task.** A workflow step hands work to an agent as a [task](#tasks), and
an agent can start a saved workflow (`wheems workflow run <name> --wait`, a tool through the
broker) and get its result back.

**Determinism is chosen per step.** Fixed steps, gates and checks where the job is known; an
agent's judgement only where it's needed.

### Learning what repeats

The knowledge loop already sees every request and task. The nightly tidy (planned, milestone 5)
also groups similar requests by meaning: the first message of each conversation and the brief of
each task a person started. When one recurs (for example three times in two weeks, or at a
regular time), the chief offers in chat: "Shall I make this a routine?", with a suggested
schedule, the skill it would use (drafted as an ordinary skill proposal, for `wheems review`), and
the tier. You approve or turn it down. The same detector offers to promote a routine to a
workflow when its trace shows drift or it starts acting on the outside world.

## Projects

Planned, milestone 4. A **project** is any body of work inside a workspace: "Customer support",
"Reviews", "Sales leads", "Bookkeeping", or a website with its code. Each has, all optional apart
from its knowledge base:

- a **lead** (a chief officer for the project), reachable in the project's own Slack channel as
  well as through the workspace chief;
- its own **knowledge base**, with the same loop as the workspace's: notes, filing, pages, a
  brief, reports and a search index;
- a **team list**: the workspace agents it may use, plus agents of its own;
- a **channel**, and session folders of its own.

A project shares its workspace's accounts, secrets, integrations, rules and skills, and may
narrow them. **Only workspaces are confidentiality walls.** Projects keep context clean, not
secrets: an agent in one project of a workspace is not stopped from reading another's files.
Doctor, the README and `wheems project new` all say so. The rule: if one chief should be able to
answer about all of it, make projects in one workspace; if it needs secrecy or other people, make
a workspace. There is no chief above workspaces; looking across them stays with the read-only
overseer (later).

```yaml
# workspaces/acme/projects/reviews/project.yaml (proposed format)
name: Reviews
description: Replies to reviews from the reviews service, and what customers tell us in them.
lead: lead # agents/lead.md in this project; leave out and the workspace chief covers it
channel: { connection: slack, channel: acme-reviews }
team: [writer] # workspace agents this project may use, besides its own agents/
skills: [review-replies] # narrows the workspace's skills.yaml
integrations: [reviews] # narrows the workspace's integrations
routing: search # search (the default) or ask
# folder: ~/Projects/acme-site   only for projects with code; tasks get a worktree of it
```

**Notes and knowledge.** The service stamps each note with its project, as it stamps the
workspace today; an agent can't choose where its note goes. The workspace's one filer files
project notes into that project's knowledge base. Each knowledge base has its own search index
(collection `<workspace>.<project>.<generation>`), and a search across several is combined with
the same reciprocal rank fusion. When a project note is filed, its first line goes onto the
project's card and into the workspace's `knowledge/activity.md`, so the workspace chief knows what
happened without anything being posted.

**Cards are generated, never written by an agent.** `knowledge/cards/<project>.md` holds the
project's name, description, lead, channel, status, a "can answer about" list taken from its
brief's headings, and the latest lines of activity. Code writes it at `project new`, after each
project note is filed, and at the nightly tidy, so it can't drift; `wheems validate` reports a
card without a project or a project without a card. The chief's built-in instructions get a
generated Projects section at each launch, from the `project.yaml` files.

| Command (planned)                                                                  | What it does                                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wheems project new <name> [--workspace] [--lead template] [--channel] [--folder]` | Creates the folder, `project.yaml`, a lead from a template, an empty knowledge base and the card; creates or checks the channel; validates; commits |
| `wheems project list`                                                              | Projects, leads, channels, routing and note counts                                                                                                  |
| `wheems project rename <old> <new>`                                                | Moves the folder and rewrites the card, rules and bindings; old sources stay valid                                                                  |
| `wheems project archive <name>`                                                    | Moves it to `projects/_archive/`, marks the card archived and stops its channel. Knowledge is never deleted                                         |

**Routing: search first, ask for jobs.** The workspace chief's `wheems kb search` covers its own
pages, the cards, and every project with `routing: search` (the default), with each result
labelled by project. If the pages answer the question, the chief replies with sources. A project
with `routing: ask` is left out of that search, and the chief must send it a task. Work and live
state ("has the refund gone through?") always go to the project's lead as a [task](#tasks). A
question about several projects sends tasks in parallel, and the chief combines the answers
without hiding disagreements; a timeout gives a partial answer, not an invented one.

**Slack.** One app, as now. Each project with a lead gets a channel, `<workspace>-<project>` by
default, where its lead posts under its own name and icon. `approvals` and `updates` stay one per
workspace, each post tagged with its project. `wheems project new` creates the channel when the
app may, and otherwise tells you to create it and invite the app; doctor checks it.

## Sessions

Milestone 3, built first in it. The session store and `wheems session new`, `list`, `search`,
`send`, `show` and `end` are built. Wheems keeps a record of every agent session it
runs: which workspace, project and agent it belongs to, who started it, what it's for and what
state it's in. That lets the service pick up after a restart, and lets a chief find the right
session to talk to. Two kinds of thing are recorded:

- **Standing agents**: each workspace's chief and, from milestone 4, each project's lead. One row
  per agent, written by code from `workspace.yaml` and `project.yaml` at every service start,
  never by an agent. They're always there, whether a session of theirs is running or not. Their
  sessions are thread sessions: one per chat thread, as now.
- **Ad-hoc sessions**: started on the fly for one piece of work, by a chief or by you. "Open a
  session to research packaging suppliers and keep it going" starts one. Each has an owner, a
  title, a purpose and a one-line summary, and stays open until it's ended, so its owner can come
  back to it.

From milestone 5, [tasks](#tasks) are recorded the same way, as sessions of kind `task`.

**Chiefs are the only agents people talk to.** Only a chief (and, from milestone 4, a project's
lead) has a channel. An ad-hoc session has no channel and no thread of its own, and never posts
anywhere: it works behind its owner, and the chief tells you what you need to know from its
answers, in its own conversation with you. You can still watch any session in Herdr
(`hc attach`) or with `wheems session show`.

**The session layer knows nothing about channels.** Slack is the first of many channels
(Telegram, email, Teams and more), each a driver behind the `ChannelDriver` contract, like
Laravel's mail drivers. Sessions, sends and answers live in the core: no channel's names, ids or
wording appear in the sessions code or the store. Anything a person sees goes through a chief's
conversation and its channel's driver, never a path of its own.

### The first test: several chiefs, each with a few sessions

The test this milestone is built for: two or three chiefs, each with two or three ad-hoc sessions
beneath it, used every day.

- **Each chief is a workspace's chief**, in that workspace's own channel (in Slack, for now). The
  service already runs every workspace in `install.yaml` side by side. Keeping them apart arrives
  in milestone 6, so until then, use workspaces that don't need to be secret from each other.
- **You ask a chief to start a session.** It runs `wheems session new`, which starts the agent in
  Herdr and records the session with the chief as its owner. The session starts on its purpose at
  once.
- **The chief talks to it** with `wheems session send`, finds it again later, from any of its
  threads, with `wheems session search`, and passes on what you need to know.

### Finding a session

`wheems session search "<words>"` searches the caller's workspace: titles, purposes, summaries,
and agent and project names, with SQLite's full-text search (the same built-in search the
knowledge base uses). Each result shows the id, agent, owner, state, when it was last active and
its summary, most recently active first. `wheems session list` filters by owner, agent, project,
kind and state. A chief's instructions get a generated Sessions section at launch listing its own
open sessions, as they were then.

**Who owns a session.** A chief's thread session starts sessions for the chief: their owner is
the chief's agent (`acme/chief-of-staff`), so they're the chief's from every one of its threads,
`max_open_per_owner` counts them across threads, and each new thread's Sessions section lists
them. The thread session that started one is its parent. A session an ad-hoc session starts is
owned by that session; one you start from a terminal is yours (no owner).

**Each ad-hoc session runs in a folder of its own**, `.wheems/sessions/<workspace>/adhoc/<id>/`.
Under `adhoc/`, an id can never collide with the per-agent folders milestone 5 puts at
`.wheems/sessions/<workspace>/<agent>/`, and `adhoc` can't be an agent's name. The engine writes the agent's instructions file into the folder a session runs in, so a session
running another agent, or the chief's own with a different Sessions section, would otherwise
replace the chief's `CLAUDE.md` in the workspace folder. It's inside the install folder, which
the engines already trust, and reaches the knowledge base through `wheems kb` as every agent
does. Chiefs' thread sessions stay in the workspace folder until milestone 5's session folders.

**The summary is written by code, not by the agent**, the same rule as project cards: the purpose
given to `session new` at first, then the first line of the session's latest note (or, from
milestone 5, its latest task result). An agent can't describe itself into someone else's search
results.

### Talking to another session

`wheems session send <id> "<message>"` delivers a message into an ad-hoc session, resuming it
first if it was stopped: Herdr starts it again, and its engine resumes the conversation. The
message arrives as `Wheems: message from <sender>:` and the text.

- **With `--wait`** the caller gets the answer back from the command, up to `--timeout` (ten
  minutes by default, at most an hour). If it doesn't come in time, the command says so and the
  answer comes back later as without `--wait`.
- **Without**, the command returns at once, and the answer goes back to the sender when it comes,
  as `Wheems: answer from session <id> ("<title>"):` and the answer: typed into an ad-hoc sender,
  or handed to a chief's conversation (the conversation manager's `tell`), which answers in its
  own thread, on whatever channel that is. A message from Wheems is delivered, queued and
  followed like the person's, but there's nothing to mark as seen. The person's answers are only
  kept, for `wheems session show`. If the session doesn't answer within an hour, or it can't
  be resumed, the sender is told why instead. An answer handed back is itself kept as a message
  from the session that answered, so one that can't be delivered isn't lost.
- **A session's purpose is its first message**, from whoever started it, so the answer to it
  goes back to its starter in the same way: a chief hears what came of a session it started
  without asking.
- **One message at a time.** Each ad-hoc session has an inbox: a message is typed in once the one
  before has been answered, and its answer is the session's answers since it was typed, so
  answers are never mixed up between senders. A turn that doesn't finish (no answer within an
  hour, or stuck waiting for an answer at the Mac) is stopped, so a late answer can't be taken for
  the next message's; the next message resumes the session. If it can't be stopped, nothing more
  is typed into it until that turn is over, or a later try to stop it works. Answers handed back to an ad-hoc session queue in
  its inbox in the same way.
- **An ad-hoc session can send to its owner** with `wheems session send owner "…"`, to tell it
  something unasked, such as what came of work it handed on. For a chief, that's the thread that
  started it, never with a wait: the chief answers in its own conversation, in its own time.

A send is a plain message and its answer, both kept as files under
`.wheems/messages/<workspace>/` and recorded in the store's `messages` table. A message still
waiting for its answer when the service stops is marked failed when it next starts. **From milestone 5 a send is a task aimed at an existing session** (`session: <id>` in
`task.md`) instead of a fresh one, so the task stays the one hand-off: a brief, a result, the same
checks and the same run record. The only difference is that the session receiving it keeps its
context.

**Rules**

- **Within one workspace only.** A session can't find, see or message another workspace's
  sessions. Every query is filtered by the caller's workspace in one place in code, taken from
  who's calling, never from an argument.
- **Who may send to whom.** A chief may send to any ad-hoc session in its workspace, and (from
  milestone 4) a lead to any in its project. Any other session may send to its owner and to the
  sessions it owns. You may send to any ad-hoc session from a terminal. A chief's thread sessions
  are conversations with you: only the sessions a thread started can send to it, and you talk to
  it in its chat. A session can't send to itself, or to an ended one.
- **Limits, so sessions can't multiply or loop.** `max_open_per_owner` (3 by default) caps the
  open (not ended) ad-hoc sessions one owner has. `max_depth` (2 by default) counts levels of
  ad-hoc sessions: one a chief's thread or you start is at level 1, one it starts at level 2, and
  none may start past `max_depth`. `max_sessions` per account (in `install.yaml`) counts every
  running session of every kind, in every workspace, as Herdr reports them; until tasks queue in
  milestone 5, `session new` beyond it, or resuming a stopped session beyond it, is refused.
  **No two sessions wait on each other:** a `--wait` send to a session that's waiting on the
  sender, directly or through others waiting in a chain, is refused, since neither could answer.
- **Who's calling.** The control socket knows the caller by the session id Wheems put in its
  environment at launch (`WHEEMS_SESSION`; thread sessions started before it had one are known by
  `WHEEMS_CONVERSATION`). That's convenience, not proof, on a machine with one person; the
  short-lived credential that tasks get in milestone 5 covers sessions too. You, at a terminal,
  aren't a session: you may name the workspace with `--workspace`.

```yaml
# workspaces/acme/workspace.yaml
sessions:
  max_open_per_owner: 3
  max_depth: 2
  end_after_idle: 7d # planned: ends an ad-hoc session nobody has used for this long
```

### States and lifetimes

An ad-hoc session is **starting**, **working**, **idle**, **stopped** (its Herdr session has gone,
and its engine session can be resumed) or **ended**. It's working from when a message is typed
in until its answer comes, and idle after; a stopped one is resumed when it's next sent a
message. Between messages, its state is brought up to date from Herdr whenever sessions are
listed, searched or shown.

`wheems session end <id>`, run by its owner or you, or (planned) `end_after_idle`, ends one:
Wheems asks it for its note first, as it does before stopping a session today, and gives it up
to ten minutes, then stops it and marks it ended. A stopped session is ended without a note. An
ended session stays in the store and in search as a record, but can't be sent messages.

An ad-hoc session's answers are never posted anywhere. The agent's last message of each turn is
its answer: its engine keeps it, `wheems session show` displays the latest, and it goes back to
whoever sent the message. `wheems reply`, which posts into a chat, is refused
inside an ad-hoc session and tells it to answer its owner instead.

| Command                                                              | What it does                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `wheems session new [<agent>] --title "…" --purpose "…" [--project]` | Starts an ad-hoc session owned by the caller, prints its id                         |
| `wheems session list [--mine] [--agent] [--project] [--state]`       | Sessions in the caller's workspace                                                  |
| `wheems session search "<words>"`                                    | Finds sessions by title, purpose, summary, agent or project                         |
| `wheems session send <id> "<message>" [--wait] [--timeout]`          | Sends a message into a session; its answer comes back, or with `--wait` is returned |
| `wheems session show <id>`                                           | Its details, latest answer, recent messages and the `hc attach` line                |
| `wheems session end <id>`                                            | Asks for its note, then ends it                                                     |

The agent is any agent in the workspace's `agents/` (or, from milestone 4, the project's team); with
none named, the session runs the owner's own agent file.

### The session store

`.wheems/state.sqlite`, one per install, using Node's built-in `node:sqlite` as the search index
does.

- **Herdr says whether a session is alive; the store says what it's for.** The store doesn't copy
  Herdr's live state. Every session Wheems starts is labelled `wheems=<session id>` in Herdr, and
  at service start the store is matched against `hc`'s list: a row whose Herdr session has gone
  becomes stopped, still resumable; a Herdr session with a Wheems label and no row is reported by
  doctor and left alone, never adopted or removed. This is how a running session is picked up
  again after a restart and never started twice.
  - Rows are matched by the Herdr session's name, which Wheems chooses and which outlives its
    address. `hc ls` doesn't report labels, so the Herdr driver reads them with `hc get`.
  - Runs that aren't sessions in the store keep labels of their own: the filer's
    (`wheems=filer`, until it becomes a task in milestone 5) and doctor's test session
    (`wheems=doctor`). Thread sessions started before the store carry `wheems=conversation` and
    are known by their name.
  - A thread session is working while messages wait for answers and idle when none do; stopped
    and ended come from Herdr and from ending one, never from a message.
- **Only the service writes to it.** The CLI and agents go through the control socket, as they do
  now, so there's one writer and every change passes the same checks.
- **Ids, states and short text, not content.** Messages, briefs, results and notes stay as files
  under `.wheems/` and in the knowledge base. Titles, purposes and summaries go through the same
  credential check as notes.
- **One store per install, not per workspace.** It holds no content, every row carries its
  workspace, and `max_sessions` counts across workspaces. The workspace filter lives in one module,
  like `hc` calls do.
- **Migrations in code.** The schema version is kept in `PRAGMA user_version` and migrations run at
  service start; a store from a newer Wheems is refused rather than written to. On the first
  start, `.wheems/conversations.json` is imported and renamed `conversations.json.imported`. An
  import never replaces a thread already in the store. A file that can't be read is left where it
  is and the service refuses to start, saying why, until it's fixed or removed: its threads'
  sessions may still be running, and a thread started afresh would replace its record for good.
- **In code**, `src/state/store.ts` holds every query. Those made for a caller go through
  `workspace(id)`, which filters each one by that workspace; the install-wide ones (writing
  agents, the import, matching Herdr, routing chat threads, whose keys carry their workspace)
  are the service's own.

| Table               | One row per                          | Holds                                                                                                                                                                                                 |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`            | Standing agent                       | Id (`acme/chief-of-staff`, `acme/reviews/lead`), workspace, project, role and engine, from config                                                                                                     |
| `sessions`          | Session Wheems started               | Id, workspace, project, agent, kind (`thread`, `adhoc`, `task`), owner, parent, title, purpose, summary, state, Herdr name, engine session id, folder, and when it started, was last active and ended |
| `threads`           | Chat thread                          | Connection, channel and thread, the session it belongs to, and what `conversations.json` kept per thread: the answer position, the waiting count and the note state                                   |
| `messages`          | Message sent between sessions        | Sender, receiver, the files holding the message and its answer, state and times                                                                                                                       |
| `tasks`, `attempts` | Task and attempt (milestone 5)       | See [How a task runs](#how-a-task-runs)                                                                                                                                                               |
| `session_search`    | Session, in a full-text search index | Title, purpose, summary, agent and project                                                                                                                                                            |

## Tasks

Planned, milestone 5. **The task is the one hand-off between agents**: a written brief to an
agent in a fresh Herdr session, and a written result back. A chief asking a project lead, a lead
handing work to a worker, a routine's run, a workflow's agent step, each member of a pair and
every judge are all tasks. It's built on the task runner that the filer already uses
(`src/service/runner.ts`), not a second agent loop.

### Lifetimes and session folders

| Who                                                     | Lifetime                                                 | Why                                 |
| ------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| Workspace chief                                         | One session per Slack thread, resumable (built)          | You talk to it                      |
| Project lead                                            | Per thread in its channel; fresh per task when sent work | Tasks don't clutter your threads    |
| Workers, pair members, judges, routines, workflow steps | Fresh per task                                           | Clean context; runs can be repeated |
| Ad-hoc sessions                                         | Until ended; stopped when idle, resumed when sent work   | Work you come back to               |
| Filer                                                   | Fresh per note (built)                                   |                                     |

A task goes to a fresh session by default, or to an existing [ad-hoc session](#sessions) when
`task.md` names one with `session: <id>`.

Agent front matter gains `lifetime: thread | task`: `thread` by default for chiefs and leads,
`task` for everyone else. Each agent session gets **its own folder**
(`.wheems/sessions/<workspace>/<agent>/` for thread agents, `.wheems/tasks/<id>/work/` for
tasks), so the engine driver writes that agent's instructions file and only its pinned skills
there. A task on a project with code works in a git worktree of the project's folder, on a branch
`wheems/<task-id>`.

### The brief and the result

`.wheems/tasks/20261113-0912-k7/task.md`, written by Wheems (proposed format):

<!-- prettier-ignore -->
```markdown
---
id: 20261113-0912-k7
from: acme/chief-of-staff
to: acme/reviews/lead
kind: job # question, job, review, pair-member, judge, routine, workflow-step
timeout: 30m
accept:
  sections: [Replies, Flagged]
  checks:
    - every reply is under 120 words
    - every reply names the review it answers, by id
    - no reply promises a refund
  rubric: review-reply # a judge grades tone, accuracy and policy
  pass_at: 4 # out of 5, on every rubric item
  review: before_send # a person approves before anything is sent
---

Draft replies to the reviews that arrived this week. Flag any that mention a safety issue.
```

The agent finishes with `wheems task done`, sending `result.md`: a status (done, blocked or
failed), a one-line summary, the sections asked for, its sources and its artifacts (a branch, a
CRM row, a draft). The result is filed as the session's note, so a task needs no extra note turn.

### How a task runs

1. `wheems task new` (or a routine, a workflow or a pair) writes `task.md` and records the task in
   the [session store](#the-session-store).
2. The runner prepares the agent in the task's own folder and starts it through the runtime
   driver, on the agent's machine, labelled with the task's id.
3. It follows the session as conversations are followed today: by status, or by answers for
   engines without status. A permission prompt is posted to `approvals` with the `hc attach` line.
4. The result is evaluated ([below](#evaluating-tasks)). A result that fails its checks goes back
   to the agent with the reasons, up to the task's retries (two by default); then the task fails.
5. A session that goes quiet without a result gets one reminder, then fails with `no_result`.
6. The session is stopped and kept for a day for `hc attach`. A caller that asked to wait gets the
   result.

A task's state is durable: queued, running, waiting for approval, succeeded, failed, cancelled,
or **outcome unknown**. Each attempt has its own id. After a service restart, a running task is
picked up again from its session, never launched a second time. The commands a task runs
(`wheems task done`, `note`, the broker's tools) authenticate with a **short-lived task
credential** bound to the task's scope and grants; an environment variable alone isn't proof of
who's calling. An external write whose outcome is uncertain (an email that may have been sent) is
marked outcome unknown and reconciled against the outside system before anything is retried;
it's never blindly retried.

`max_sessions` per account in `install.yaml` queues tasks, so chiefs, leads, workers, judges and
pairs together can't exhaust one subscription.

### Evaluating tasks

Every task says what "done" means, and Wheems checks it in three layers, cheapest and surest
first. Only the first layer guarantees anything; the other two are signals.

| Layer          | What it checks                                                                                                                                                                                                                                                                                                                                                                                | On failure                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **In code**    | The result's shape (sections, an output schema), allowed values (a label from the list, a score in range), sources that resolve to files the task may read, no credentials, artifacts that exist (the branch, the CRM row, the draft), side effects the broker recorded matching what the result claims, the steps of a skill procedure, and for code, the project's own checks on the branch | Back to the agent with the reasons, within the retries; then the task fails            |
| **By a judge** | Criteria code can't check: tone, accuracy, whether a claim follows from its source, policy. A separate fresh judge task, from another provider where possible, sees only the brief, the criteria, the result and the cited files, never which agent or engine wrote it. It returns a score and reasons per rubric item, which are themselves checked in code                                  | Below `pass_at`: back to the agent once with the judge's reasons, then flagged for you |
| **By people**  | Feedback buttons on results posted to Slack (good, not right, and why), your edits before something is sent (the difference is recorded), approvals and refusals, and pair picks                                                                                                                                                                                                              | Recorded with the task; refusals and "not right" feed the evals below                  |

Criteria come from the task's `accept:` block, from the agent's or skill's defaults, and from the
step that started it. Rubrics live in files, so the same rubric judges every run.

**Recorded outcomes.** Every task keeps a run record: its brief, result, each check and whether it
passed, the judge's scores and reasons, your feedback and edits, any outcome measure (the reply
was sent, the ticket closed, the customer answered), the time and turns it took, and the agent,
engine, model and skill versions it ran with. `wheems eval report` shows quality per agent, kind
of task and engine over time.

**Evals catch regressions.** An eval is a golden set: saved tasks with known-good outcomes
(`evals/<name>/`, each case an input and what must be true of the result). The set re-runs
whenever something it depends on changes (an agent's instructions, a skill's version, the model,
the engine, a prompt or a label set) and on demand with `wheems eval run`. When scores drop below
the last accepted baseline, Wheems posts to `updates`; a new baseline needs your approval. Your
"not right" answers and corrected results are offered as new cases.

**Business tasks are evaluated on business terms.**

- A classification (which kind of email this is, a review's sentiment) is measured against a
  labelled sample of real items: a confusion table per label, re-run when a prompt, model or label
  set changes. Precision matters most for labels that act.
- Anything new that acts on the outside world starts in **shadow mode**: it proposes, you
  approve. Once its approval rate over a stated number of items is high enough, you may switch
  individual labels or steps to act on their own, and a sample of their actions is still posted
  for audit.
- Written outputs (review replies, outreach emails) are judged against a rubric, and your edits
  before sending count as signal.
- Where an outcome exists, it's measured: a reply sent, a ticket closed, a lead bought.

Judges share blind spots, especially from one provider, and a consensus of two agents isn't
proof. That's why code checks come first, and why approvals stay on anything that can't be
undone.

### Pairs

Planned, milestone 5. A pair is two independent task members and a judge: the same brief to two
agents, ideally on different providers, each in its own folder or worktree and unaware of the
other. When both finish, an anonymised judge task sees the two results as A and B in random
order, with engines and models removed, and fills a fixed rubric: where they agree, where they
differ and which is better on each point, a recommended merge, and its confidence. You pick:
**Take A**, **Take B**, **Merge** or **Neither**. Pair members can't publish, merge or buy. If one
member fails, the pair is reported as incomplete, not re-run.

Pairs suit naming, plans, research, review replies, marketing copy and code reviews. They cost a
little more than twice one task, so they're opt-in per task or agent, with a daily limit and caps
on rounds and time.

## Routines, skill procedures and workflows

### Routines

Planned, milestone 5. A routine is a trigger, an agent and a skill, run as a task:

```yaml
# workspaces/acme/routines/morning-brief.yaml (proposed format)
description: Yesterday's work and what's waiting on me, every weekday morning.
trigger: { schedule: '0 7 * * 1-5' }
agent: chief-of-staff
skill: morning-brief
post: { channel: chat }
accept:
  sections: [Done, Waiting on you, Today]
  rubric: brief
```

When the skill lists steps (a skill procedure), each step has a name in the skill's front matter,
the agent marks it with `wheems step <name>` as it goes, and the broker records every tool and
integration call. After the run, Wheems compares the steps expected with the steps marked and the
calls made, and reports drift: a step skipped, done twice or out of order. That detects drift; it
can't prevent it, which is what workflows are for.

### Workflows

Planned, milestone 7. A workflow is a DAG in YAML: steps, the order between them, gates and
checks, run by Wheems. Agents work only inside steps, so the order never varies.

**Triggers:** a time, a message in a channel, a file landing, and **an event in an integration**:
a new email, a new review, a new form entry, a new row. Events are polled first, with webhooks
where the service offers them, and each item runs once (by its id in the outside system). Until
the always-on server (milestone 10), events are polled while the laptop is awake.

**Steps:**

| Step       | What it does                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task`     | Runs an agent [task](#tasks), with its acceptance criteria                                                                                                                                                                                                                                                   |
| `model`    | A **lightweight model call** for small, high-volume judgements: classify, extract fields, score. Runs through an API-key account (OpenRouter, Anthropic's API), not a full agent session, so it's fast and doesn't use subscription limits. Its output is always checked in code: an allowed label, a schema |
| `classify` | A `model` step whose labels map to actions                                                                                                                                                                                                                                                                   |
| `call`     | An action in an integration, through the broker: send an email, create a CRM row, fetch analytics                                                                                                                                                                                                            |
| `ask`      | Asks for approval in `approvals` and waits. A no stops the run                                                                                                                                                                                                                                               |
| `post`     | Posts to a channel                                                                                                                                                                                                                                                                                           |

Each step has an id, the steps it `needs`, a timeout, checks on its output and bounded retries.
A read that fails is retried with backoff; an uncertain write is reconciled first. Every run
records each step's input, output and checks. Shell and HTTP steps are deferred: outside calls
go through integrations and the broker.

**Classify, then act** is a core pattern. Which actions need approval is set in config and
enforced by the broker:

```yaml
# workspaces/acme/workflows/support-inbox.yaml (proposed format)
description: Sort the support inbox and act on each email.
trigger: { integration: { name: support-email, event: message.received } }
steps:
  - id: sort
    classify:
      account: openrouter
      labels: [refund, how-to, complaint, spam, other]
  - id: act
    needs: [sort]
    on:
      how-to: { task: { agent: support, skill: how-to-reply }, mode: shadow }
      refund: { task: { to: billing } } # a task for the billing project's lead
      complaint: { ask: { channel: approvals } }
      spam: { call: { integration: support-email, action: archive }, mode: auto }
      other: { post: { channel: chat } }
```

`mode: shadow` on a label means its action is proposed for your approval; when its approval rate
over enough items is high, you switch it to `auto`, and sampled audits continue.

**Evals** run per step and end to end on a golden set, and a classification step on its labelled
sample (see [Evaluating tasks](#evaluating-tasks)). Creating workflows by asking: the chief writes
the file, explains it in plain English, and saves it once you approve.

The first business integrations arrive with workflows (milestone 7): email, a reviews service and
search analytics. `connect` and `grant` for every integration, and the vault, follow in
milestone 9.

## Worked example: a lead-generation site

The first real use: running a website you already have and growing it into a lead generator, such
as a directory that connects people who need a specialist service with local providers, and sells
the enquiries to those providers. One workspace holds four projects:

| Project    | What it is                                       | Lead and team                  |
| ---------- | ------------------------------------------------ | ------------------------------ |
| `site`     | The website's code                               | Developer, reviewer            |
| `seo`      | Search performance and content                   | SEO lead, analyst, writer      |
| `outreach` | Finding and contacting businesses that buy leads | Sales lead, researcher, writer |
| `leads`    | The enquiries coming in, and who they're sold to | Uses the CRM blueprint         |

**A weekly SEO workflow:**

```text
fetch analytics ─► find opportunities ─► you approve a shortlist ─► make the changes
  (call)             (task: analyst,        (ask)                     (task: developer,
                      against criteria)                                 on a branch)
        ─► check the changes ─► project checks and a preview build ─► you approve the merge
           (task: reviewer,      (in code)                               (ask)
            or a pair)
```

Next week's run starts by measuring the effect of last week's changes, so the analyst's findings
are judged by what happened, not only by a rubric.

**An outreach workflow:**

```text
find candidate buyers ─► enrich and score ─► add rows to the CRM ─► draft an email each
 (task: researcher)       (model step)        (call, blueprint)       (task: writer, rubric judge)
   ─► send, in shadow mode at first ─► classify replies ─► interested: task for the sales lead
      (ask, then call: email)           (classify)         not now: follow-up in a month
                                                           unsubscribe: suppression list
```

Unsubscribes and the suppression list are enforced in code, before any send, and outreach must
follow the email marketing rules that apply, such as PECR in the UK. Each send is approved until
the approval rate earns automatic sends for that label.

**Why a DAG.** The order, the gates and the checks are fixed in YAML; only the judgement inside
each agent step varies, and every step's output is checked before the next runs.
[The roadmap](roadmap.md#the-reference-use-case) says which milestone first runs each for real.

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
- Planned (milestone 5): API-key accounts (OpenRouter, Anthropic's API) also serve the
  lightweight model step, for high-volume classification and extraction that doesn't need a
  full agent session; and `max_sessions` per account queues tasks so one subscription isn't
  exhausted.

A model isn't a connection to a service. A Grok agent for X can write posts but can't publish
them. Posting and reading mentions need the X API. That's an integration the agent uses,
whatever its model.

## Integrations

Every outside service is an integration: an email inbox, a reviews service, search analytics,
GitHub, Google, Linear, Stripe, a database. Each is connected once and given to workspaces and
agents with the same three-level pattern as skills. Planned: the first business integrations
(email, a reviews service, search analytics) arrive with workflows in milestone 7, with their
events as workflow triggers; `connect`, `grant` and the rest below arrive in milestone 9.

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

## The vault and purchases

Planned, milestone 9.

**The vault** holds credentials in the macOS Keychain on a Mac, the secret service on a Linux
desktop, and an encrypted file on a headless server, where the secret service usually isn't
unlocked. It never falls back to plain text without saying so. Agents never get a secret's value:
they ask the broker to use it ("send this email with the support inbox's credentials"), and the
broker logs every use (which secret, agent, task and call, never the value). Today's secrets file
(mode 600) is the step before it.

**Purchases: the agent prepares, you pay.** No agent ever types a card number.

1. Through an integration's own billing API where there is one (a domain registrar, a cloud
   provider): the purchase is a broker action against the card already on that account.
2. Otherwise `wheems buy` posts the merchant, items, amount, currency, card and reason with the
   checkout link; you pay on your phone and tap Paid.

Limits per purchase, per day, per month and per agent, and a merchant allowlist, are checked in
code **before** asking: over a limit is refused, not offered. Every purchase asks, every time,
with no auto-approve. **An approval binds to the exact quote** (merchant, items, amount, currency,
destination) and expires; any change needs a fresh approval. An outcome that's uncertain is
reconciled with the merchant, never retried blindly. A card with a low limit set at the bank is
the backstop. Single-use cards come later.

```yaml
# workspaces/acme/workspace.yaml (proposed format)
payments:
  currency: GBP
  limits: { per_purchase: 50, per_day: 100, per_month: 300 }
  agents: { marketer: { per_day: 20 } }
  merchants: [registrar.example, cloud.example] # anything else is refused
```

## Other machines and computer use

**Other machines** (planned, milestone 10). An agent can name its `machine:`, falling back to its
project's and then its workspace's. Herdr already runs terminals on other machines, but that
alone isn't enough: the launch files, the `wheems` command's link to the service, and the results
all live on the hub. A small worker, `wheems node`, runs on each machine: it receives an agent's
launch files, relays its `wheems` commands to the service, and returns results. Secrets stay on
the hub, behind the broker. Whether Herdr's SSH link can carry this is the main thing to test.

**Computer use** (after version one) is a tool given to an existing engine, not a new engine:
Claude Code or Codex gets desktop tools (a `desktop` driver with the `ComputerDriver` contract:
screenshot, click, type, keys, scroll) that act on a dedicated, resettable GUI machine through
the broker, which logs every action and keeps the screenshots. The machine itself is the real
guardrail: no saved passwords, no payment methods, reset to a snapshot on a schedule. Typing
anything that looks like a credential or a card number is refused, and anything irreversible
waits for approval.
