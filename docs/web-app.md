# The web app

A page in your browser for setting Wheems up, seeing what your agents are doing and deciding what
they propose. Designed on 16 November 2026 from a clickable mockup. Chat stays the way you talk to
your chiefs: the web app is for looking things over and changing settings, the way `wheems setup`,
`wheems status` and `wheems review` are today.

**Built so far (stage 1, first part):** the workspace switcher, Overview, Sessions, and Setup and
health, read-only, in light and dark. Review, Settings, Connections and every action come next;
until then the pages say which command does it.

## How it runs

- **Served by the Wheems service**, on `127.0.0.1` port 4317 (or `$WHEEMS_WEB_PORT`), so
  `wheems start` starts it with everything else. If the port is taken, Wheems runs without it and
  logs why. `wheems web open` opens it in your browser.
- **Or on its own:** `wheems web run` serves it in a terminal until Ctrl+C, beside a service that
  doesn't serve it, such as an older one.
- **It only reads, for now.** Config from the install folder, the session store opened read-only
  (a store from an older Wheems is read as if current, without changing it), the service's status
  over its control socket, and doctor's quick checks.
- **Only you can use it.** It's local only, and every request needs a token that Wheems keeps in
  `.wheems/web-token` (readable only by you). Pages live under it (`/k/<token>/…`), so every
  address `wheems web open` gives and every link carries it. It's never a cookie: a browser sends
  cookies for `127.0.0.1` to every port, so other local servers could read one. The server also
  checks the `Host` header and answers only GET, so another site open in your browser can't reach it, and a strict
  Content-Security-Policy keeps the page to its own script and styles. It loads nothing from the
  internet.
- **One set of code paths.** Every change goes through the code the CLI uses: config edits through
  the same loaders and validators, service actions through the same requests the control socket
  takes (`session-send`, `session-end`, `reindex`, `workspace-retire` and the rest). The web app
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
original ask** (the message that started the chain), its purpose, who started it, and its
messages. You can send it a message, watch it in Herdr or end it. Sessions you started yourself
with `wheems session create` are a group of their own.

Showing the original ask on every session follows a lesson from running many agents: work drifts
from what was asked one sensible step at a time, so the ask stays visible all the way down.

### Review

What the workspace's agents propose, waiting for your yes: new skills and new versions of skills,
each with why it's proposed and the text itself. Approve, decline or ask the chief why; a decision
can be undone until you leave the page.

When agents ask before acting (milestone 3), each request and your answer are kept here as the
approvals history, with what the agent knew when it asked.

Changes to `about-you.md` are install-wide, because every agent in every workspace reads it, so
they're reviewed under Install rather than in one workspace.

### Settings

The workspace's own settings, saved in `workspace.yaml` so you can still edit the file: the chief
of staff (agent file, engine, model, account, the name it posts as), chat and session limits, the
knowledge base (folder, search, rebuilding the index), the skills pinned in `skills.yaml`, and
archive or remove.

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

| Page             | Can show now (0.1.1)                                                            | Waits for                                                     |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Overview         | Workspace, chief, session tree, knowledge base stats and search, skills, health | Projects in the tree (milestone 4)                            |
| Sessions         | The session store: tree, detail, messages, send and end                         | Nothing: who started what, and the person's ask, are recorded |
| Review           | Skill proposals, approve and decline                                            | Approvals history (milestone 3)                               |
| Settings         | Everything in `workspace.yaml`, archive and remove                              | Connection switches (milestone 9)                             |
| Connections      | Slack and engine accounts                                                       | Integrations and MCP servers (milestones 7 and 9)             |
| Setup and health | Setup's steps and doctor's checks and fixes                                     |                                                               |

## Open questions

- **Per-agent connections.** The design lets each agent pick from its workspace's connections.
  The web app shows only the workspace level for now.
- **What it's built with:** pages rendered by the service, or a small client app shipped in the
  npm package. Either way, no build tools for the person installing Wheems.
- **Reaching it from elsewhere** once the service runs on an always-on server (milestone 10):
  until then it's this computer only.
