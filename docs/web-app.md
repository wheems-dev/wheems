# The web app

A page in your browser for setting Wheems up, seeing what your agents are doing and deciding what
they propose. Designed on 16 November 2026 from a clickable mockup. Chat stays the way you talk to
your chiefs: the web app is for looking things over and changing settings, the way `wheems setup`,
`wheems status` and `wheems review` are today.

**Built so far (stage 1):** the workspace switcher; each workspace's Overview, Sessions, Review and
Settings; and the install's Connections, About you, and Setup and health; in light and dark. From
the page you can approve or decline skills (choosing which agents get each, and editing it first)
and changes to `about-you.md`, and send a message to a session or end it (ending and declining ask
first), and edit a workspace's settings and restart the service to use them. When nothing
answers, the page and its sidebar say Wheems can't be reached. The chat channel, accounts,
connecting and granting, archiving and removing, and setup steps still use the commands each page
names.

## How it runs

- **Served by the Wheems service**, on `127.0.0.1` port 4317 (or `$WHEEMS_WEB_PORT`), so
  `wheems start` starts it with everything else. If the port is taken, Wheems runs without it and
  logs why. `wheems web open` opens it in your browser.
- **Or on its own:** `wheems web run` serves it in a terminal until Ctrl+C, beside a service that
  doesn't serve it, such as an older one.
- **What it reads:** config from the install folder, the session store opened read-only (a store
  from an older Wheems is read as if current, without changing it), the service's status over its
  control socket, and doctor's quick checks.
- **What it does:** approving and declining run the same code as `wheems review`; sending to a
  session and ending one go through the service's control socket, as `wheems session send` and
  `end` do, as you, in that session's workspace. Each action says how it went; a slow send's or
  end's result shows on the session when the service has it.
- **Built with React and Vite** (`web/`), as a single-page app. `npm run build` builds it into
  `dist/web/app`, so the npm package ships only the built files and installing Wheems builds
  nothing. The service serves those files and a JSON API under `/api` that reads through
  `data.ts` and acts through `actions.ts`. Pages that change while you watch (Overview,
  Sessions) refresh every few seconds. `npm run dev:web` serves the app with live reload,
  passing `/api` to a running Wheems.
- **Only you can use it.** It's local only, and the API needs a token that Wheems keeps in
  `.wheems/web-token` (readable only by you). `wheems web open` gives it after the `#` in the
  address, which no browser sends to a server; the app keeps it in this origin's own storage and
  sends it in a header with every request, which a link or form on another site can't. It's never
  a cookie: a browser sends cookies for `127.0.0.1` to every port, so other local servers could
  read one. The server also checks the `Host` header, and takes a change only when the browser
  says it came from this page (its `Origin`). A strict Content-Security-Policy keeps the page to
  its own script and styles, and it loads nothing from the internet. The app's own files hold no
  data, so they're served without the token.
- **One set of code paths.** Every change goes through the code the CLI uses: config edits through
  the same loaders and validators, service actions through the same requests the control socket
  takes (`session-send`, `session-end`, `restart`, `workspace-retire` and the rest). The web app
  adds pages, not a second way of doing things.
- **The workspace is in the address** (`/w/default/sessions`), so a link opens the right workspace
  and the switcher's choice survives moving between pages.

## Layout

A sidebar on the left, the page on the right; on a phone the sidebar stacks above.

- **The workspace switcher** at the top: every workspace, with how each chats, and "New
  workspace". Everything below it belongs to the chosen workspace.
- **The workspace's pages:** Overview, Sessions, Review and Settings.
- **Install**, for what's shared by every workspace: Connections, and Setup and health.
- **At the bottom:** whether the service is running, the version, and the light or dark switch.

## The pages

### Overview

The workspace at a glance: its name and how it chats, where its chief runs, the install's health
as a row of links (service, Slack, Herdr, search), anything waiting for you, and **the chief of
staff with its sessions as a tree**. Your conversations with the chief and the sessions it started
hang under it, and a session started by another session hangs under that one, so you can see who
is working for whom. Below, the knowledge base (pages, notes waiting in the inbox, a search box)
and the workspace's skills.

### Sessions

The same tree on the left, and the chosen session on the right: its state, its id in Herdr, **your
original ask** (the message that started the chain), its purpose, who started it, and its latest
messages: what was said in its chat thread (your messages, its answers and Wheems's notices, kept
in the session store as they're posted) and messages sent to it through Wheems. A message that
seems to hold a password, token or key is kept only as a line saying so. You can send it a
message, watch it in Herdr or end it; ending asks first, in the page, since it can't be undone.
Only sessions started on purpose (by you, the chief or another session) take messages and can be
ended here. A chat thread's session hears you in its thread, so the page says to reply there,
and offers **Hand over** and **Start fresh**, each asking first, with its handovers listed:
who wrote each, from which engine and model, and whether a new session has taken it over.
Sessions you started yourself with `wheems session create` are a group of their
own. A session you end stays in view, with how it went, even while ended sessions are hidden.

Showing the original ask on every session follows a lesson from running many agents: work drifts
from what was asked one sensible step at a time, so the ask stays visible all the way down.

### Review

What the workspace's agents propose, waiting for your yes: new skills and new versions of skills,
each with why it's proposed and the text itself. Approve or decline; declining asks first, in the
page. Asking the chief why, and undoing a decision, are still to come.

When agents ask before acting (milestone 3), each request and your answer are kept here as the
approvals history, with what the agent knew when it asked.

Changes to `about-you.md` are install-wide, because every agent in every workspace reads it, so
they're reviewed under Install rather than in one workspace.

### Settings

The workspace's own settings, saved in `workspace.yaml` so you can still edit the file: the chief
of staff (agent file, engine, model, account, the name it posts as), chat and session limits, the
knowledge base (folder, search, rebuilding the index), the skills pinned in `skills.yaml`, and
archive or remove.

**Built:** editing the name and description, the name the chief posts as, open sessions per owner
and how deep sessions may start sessions, when a note is asked for and the nightly tidy, and the
skill budget. A save changes only the values you changed in `workspace.yaml`, keeping comments,
and commits it as an approval does. Nothing is written if the file changed since the page showed
it, or if a value fails the checks the file has; the page says which, and keeps what you typed, so
saving again applies it to the file as it now is. Renaming moves the name it posts as along, when
it was made from the old name, as `wheems workspace rename` does. The service uses a change once
it restarts, so a save offers **Restart now**: the service answers, then has launchd restart it. A
Wheems that launchd doesn't run (`wheems service run`) says to restart it where it runs.

The chief's engine, model, account and permissions are edited too, in its agent file. A chat
thread's chief keeps running in Herdr across a restart as it started, so saving a change to them
lists the conversations already open, each with a choice ([session-handover.md](session-handover.md)):
**Carry on** resumes it with the new settings and its memory, and is the default when the engine
stays the same; **Hand over** starts a new session from a handover its chief writes, the default
for a thread active in the last week when the engine changes; **Start fresh** starts one with only
the ask, the default for older threads then. Carry on isn't offered across an engine change, and
the service refuses it then even if a page sends it. **Apply and restart** sets each up while the old
service still runs, so the old chiefs can write their handovers, and says how each went. The
service restarts itself in the same step, and only once every conversation is set up: one left
as it was (answering a message, say) would run on with its old session, so then nothing restarts
and **Try again** sets up the rest. While it works, the old service starts no session in the
workspace: a message, in a new thread or an old one, is answered with a line asking to send it
again in a moment. If a conversation opened after the page listed them, nothing is done and the
page lists them again. Saving waits while it works, and if the chief's settings change some other
way meanwhile (another tab, or the file by hand), nothing restarts and the choices are asked
again. Still commands: the chat channel, accounts, archive and remove.

**Connections this workspace may use:** a switch for each of the install's connections, with
read-only or full access where an integration offers both. The chat channel is always on, because
it's how you reach the chief. Agents get only what's switched on, through the broker.

### Connections (Install)

Everything connected once for the whole install, each showing which workspaces use it:

- **Chat channels:** Slack, then Telegram and others as they arrive.
- **Integrations and MCP servers:** outside services such as GitHub, an email inbox or a reviews
  service. Each brings an MCP server, a CLI or both, and is reached through the broker.
- **Engine accounts:** the subscriptions and API keys agents run on, signed in or not.

### Setup and health (Install)

The steps of `wheems setup` (engines, chat app, workspaces, knowledge, the service, trust) with a
progress bar; choosing one shows what it covers and what to do next. Below, the checks from
`wheems doctor`, each with its fix where doctor has one.

## Look

The palette and type of [wheems.dev](https://wheems.dev): Manrope and IBM Plex Mono, warm paper
and ink, cobalt for links and actions. Every colour is a named token with a light and a dark value.
The page follows the computer's light or dark setting until you choose one with the switch, and
then remembers it.

## What can be built when

| Page             | Can show now (0.1.13)                                                           | Waits for                                                       |
| ---------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Overview         | Workspace, chief, session tree, knowledge base stats and search, skills, health | Projects in the tree (milestone 4)                              |
| Sessions         | The session store: tree, detail, messages, send and end                         | Sub-agents read-only, with End as a stop ([team.md](team.md))   |
| Team             | The chief and the workspace's agents, from `agents/`                            | Creating and editing agents, project teams ([team.md](team.md)) |
| Review           | Skill proposals, approve and decline                                            | Approvals waiting and their history (milestone 3)               |
| Settings         | Everything in `workspace.yaml`, archive and remove (most of it editable now)    | Connection switches (milestone 9)                               |
| Connections      | Slack and engine accounts                                                       | Integrations and MCP servers (milestones 7 and 9)               |
| Setup and health | Setup's steps and doctor's checks and fixes                                     |                                                                 |

## Open questions

- **Per-agent connections.** The design lets each agent pick from its workspace's connections.
  The web app shows only the workspace level for now.
- **Reaching it from elsewhere** once the service runs on an always-on server (milestone 10):
  until then it's this computer only.
