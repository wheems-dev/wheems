# Config formats

Config is YAML and Markdown in a git folder, `~/wheems` by default (`WHEEMS_HOME` or `--home`
moves it). Adding an agent, channel or workflow means editing config, not code.

Every format has a JSON Schema in [`schemas/`](../schemas/), generated from the Zod schemas in
[`src/config/schemas.ts`](../src/config/schemas.ts). They ship in the npm package. Point your
editor at one for completion and hover help, for example with the YAML language server:

```yaml
# yaml-language-server: $schema=/path/to/wheems/schemas/workspace.schema.json
```

`wheems configuration validate` checks files or a whole install folder, with line numbers. For a
folder it also checks the links between files: that names point at things that exist, and that each
level only picks from the level above. `wheems doctor` runs the same checks.

Keys are `snake_case`. Names (of workspaces, agents, accounts, connections, channels, skills and
workflows) are lowercase letters, digits and dashes. Unknown keys are errors, so a typo never
passes silently.

A complete example lives in [`examples/install/`](../examples/install/).

## install.yaml

One per person. Holds what every workspace shares.

```yaml
herdr:
  version: 0.1.20 # the minimum Herdr core version; Wheems's own minimum applies if higher
  binary: /opt/hc # optional: hc's path when it is not on PATH

machines:
  laptop:
    local: true # the machine the install lives on (at most one)
    reach: outbound # it connects out to the hub to collect work; the hub never connects in
  server:
    herdr: server # its name in `hc machine ls`
    always_on: true

accounts: # what pays for models
  claude-subscription: { driver: claude, max_sessions: 6 } # optional: most sessions at once
  openrouter: { driver: openrouter, secret: openrouter-key }

connections: # channels and integrations, connected once, shared by every workspace
  slack:
    driver: slack
    secret: slack # the entry in the secrets file (default: the connection's name)
    allowed_users: [U012ABCDEF] # who may talk to agents; everyone else is ignored
  github: { driver: github, secret: github-token }
```

```yaml
knowledge: # how every workspace's knowledge base is searched
  embeddings: # leave out for keyword search only
    driver: ollama
    model: nomic-embed-text # default: the driver's usual model
    url: http://127.0.0.1:11434 # Ollama's own option; other drivers take their own
  vector_store: { driver: sqlite } # the default: SQLite files in .wheems/index/
```

`knowledge.embeddings` turns on searching by meaning. Keys besides `driver` and `model` are the
driver's own options. `wheems setup` (Knowledge) writes it, using the model Ollama already has when
it can. Changing the driver or model rebuilds every index the next time the service syncs it.

`secret` names a credential in the secrets file, `~/.config/wheems/secrets.json` (mode 600; an
encrypted store comes later). Credentials never appear in config. `wheems setup` writes the Slack
tokens there and your Slack member id into `allowed_users`.

One Slack app serves every workspace: workspaces bind its channels, they don't get apps of their
own.

## workspaces/&lt;id&gt;/workspace.yaml

The folder name is the workspace's id.

```yaml
name: Acme
description: A small software business.
chief_of_staff: chief-of-staff # the file in agents/; this is the default
accounts: [claude-subscription, openrouter] # install accounts this workspace may use
machine: server # where its agents run by default
isolation: enforced # or hard
skill_budget: 20 # doctor warns past this many skills
knowledge:
  note_after_idle: 30 # minutes quiet, after new work, before the agent is asked for a note; 0 is off
  filer: # the agent that files notes; each defaults as shown
    engine: claude-code # the chief of staff's engine
    model: claude-sonnet-5-5 # Sonnet on Claude Code, else the chief of staff's model
    account: claude-subscription # the chief of staff's account
  tidy_at: '03:00' # local time of the nightly tidy (reports and the brief); false is off

sessions: # limits on ad-hoc sessions; each defaults as shown
  max_open_per_owner: 3 # open sessions one owner (a chief, a session or you) may have
  max_depth: 2 # a chief's session may start one level of sessions, and those one more

identity: { name: Acme chief of staff, icon: ':office:' } # how its posts appear, where supported

channels: # chat, approvals and updates are built in; add any others
  chat: { connection: slack, channel: acme-chat } # or { connection: slack, direct: true }
  approvals: { connection: slack, channel: acme-approvals }
  updates: { connection: slack, channel: acme-updates }
  briefs: { connection: slack, channel: acme-briefs }

integrations: # install connections this workspace may use
  github: { access: full } # read (the default) or full

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

`sessions` limits [ad-hoc sessions](architecture.md#sessions), so they can't multiply or loop.
`max_sessions` on an account counts every running session on it, of every kind and in every
workspace; beyond it, `wheems session create` is refused (from milestone 5, tasks queue instead).

`direct: true` means the app's direct messages. Only one workspace per connection can have them;
every other workspace chats in a channel, by name or id, that the app has been invited to.

A rule needs at least one of `deny`, `require` or `approval`; `approval` names a channel and goes
with `action`.

## workspaces/&lt;id&gt;/agents/&lt;name&gt;.md

YAML front matter, then the agent's instructions in Markdown. The engine driver writes the
instructions into the engine's own file (`CLAUDE.md`, `AGENTS.md`).

```markdown
---
description: Reviews pull requests, from a different provider than the developer.
engine: codex # claude-code, codex, opencode, or a plugin's engine
model: gpt-5.5-codex # the engine's model id
account: chatgpt-subscription # one of the workspace's accounts
skills: [code-review] # from the workspace's skills.yaml
integrations: [github] # from the workspace's integrations
permissions: ask # ask (default), auto or skip
---

# Reviewer

Review the pull request you are given. Report findings; do not change code.
```

`name` defaults to the file name, and must match it if given. `adhoc` is reserved: ad-hoc
sessions' folders use it.

`permissions` says how much the agent may do without asking: `ask` uses the engine's normal
prompts, `auto` lets the engine allow routine actions and ask for risky ones, and `skip` never
asks.

| Engine      | `model`, for example                            | `auto`                                           | `skip`                                       |
| ----------- | ----------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| claude-code | `claude-opus-5-5`                               | `--permission-mode auto`                         | `--dangerously-skip-permissions`             |
| codex       | `gpt-6.1-sol`                                   | `--approve-for-me`                               | `--dangerously-bypass-approvals-and-sandbox` |
| opencode    | `openrouter/x-ai/grok-5`, `opencode/big-pickle` | `--auto` (approves what its config doesn't deny) | `--auto`                                     |

Until approvals arrive, a prompt means someone has to answer it at the machine, so a chief of
staff you talk to from your phone usually runs on `auto`.

Every agent also gets Wheems's built-in instructions: its last message of each turn is posted to
the chat thread for it, and `wheems chat reply "..."` sends a progress note during long work.

## workspaces/&lt;id&gt;/skills.yaml

The skills this workspace uses, each pinned to a version in the install's library, so library
changes never silently change a live workspace. Versions are whole numbers. Each agent lists the
skills it uses in its own `skills:`, picked from this list.

```yaml
skills:
  release-notes: 2
  code-review: 1
```

`wheems review` adds the pin when you approve a skill an agent proposed.
`wheems configuration validate` and doctor report a pin with no such skill or version in the
library.

## library/skills/

Every skill, at every version, in a numbered folder. A workspace pins the versions it uses; the
library itself is never loaded into an agent.

```text
library/skills/release-notes/
├── skill.yaml       who wrote each version
├── 1/SKILL.md
└── 2/SKILL.md
```

`SKILL.md` is the [Agent Skills](https://agentskills.io) format: front matter with `name` (the
folder's name) and `description` (what it does and when to use it), then the instructions.

```markdown
---
name: release-notes
description: Writes release notes for a new version. Use when a release is being tagged.
---

1. List the pull requests merged since the last tag.
2. Group them into features, fixes and everything else.
```

`skill.yaml` lists the versions agents proposed, with who proposed them and when they were
approved. A version it doesn't list was written by a person: add one by hand by creating its
numbered folder. Agents can't propose changes to a skill whose latest version a person wrote.

## workspaces/&lt;id&gt;/workflows/&lt;name&gt;.yaml

**Today** the schema accepts a trigger and a list of steps, validated so config written now
keeps working, but nothing runs workflows yet:

```yaml
description: A summary of yesterday and what is waiting, every weekday morning.
trigger: { schedule: '0 7 * * 1-5' } # or { message: { channel: chat, contains: invoice } }
#                                      or { file: { path: 'wiki/inbox/*.md' } }
steps:
  - agent: chief-of-staff # run an agent with a task
    task: Summarise yesterday's notes, open work and anything waiting on me.
  - ask: { question: Send it? } # ask for approval (in approvals unless channel is given)
  - post: { channel: briefs } # post; without text, posts the previous step's result
```

`name` defaults to the file name, and must match it if given.

**Planned (milestone 7):** workflows become DAGs. Each step gets an `id`, the steps it `needs`, a
timeout, checks on its output and bounded retries. Triggers add an event in an integration
(`{ integration: { name: support-email, event: message.received } }`), and steps add `task` (an
agent task with acceptance criteria), `model` (a lightweight model call on an API-key account),
`classify` (labels mapped to actions, each `mode: shadow` or `auto`) and `call` (an integration
action through the broker). A morning brief like the one above is better as a routine. See
[architecture.md](architecture.md#workflows) for the format and a worked example.

## Planned formats

These are designed and will change as they're built; nothing reads them yet. See
[architecture.md](architecture.md) for how each works.

### workspaces/&lt;id&gt;/projects/&lt;name&gt;/project.yaml (milestone 4)

A project is any body of work, with an optional lead (an agent on the chief's team, with no
channel of its own), its own knowledge base and team list. Only workspaces are confidentiality walls.

```yaml
name: Reviews
description: Replies to reviews from the reviews service.
lead: lead # agents/lead.md in this project; leave out and the chief hands work to the team itself
team: [writer] # workspace agents this project may use, besides its own agents/
skills: [review-replies] # narrows the workspace's skills.yaml
integrations: [reviews] # narrows the workspace's integrations
routing: search # search (default): the workspace chief searches it; ask: send it a task
folder: ~/Projects/acme-site # only for projects with code; given to its sessions as an extra folder
start_in: install # install (default) or folder: where its sessions start
machine: server # default machine for its agents (milestone 10)
```

**`folder:`** is a folder of yours that the project works on, such as a website's code. Its
sessions still start in their own folder inside the install, which is trusted once at setup, and
get `folder:` as an extra folder (`--add-dir` for Claude Code and Codex), so no engine ever asks
whether to trust it. You approve it once, when it's linked: a yes in chat, or `wheems project
create --folder` at the terminal. A chief can't link a folder itself; it asks you. Because
sessions start outside it, the folder's own hooks and settings don't load; Wheems tells the agent
to read its `CLAUDE.md` or `AGENTS.md`. **`start_in: folder`** starts sessions inside it instead,
so they do load, and Wheems marks the folder trusted when it's linked. See
[architecture.md](architecture.md#a-projects-folder-approved-once-never-at-the-mac).

### Agent front matter (milestones 5 and 10)

```yaml
lifetime: task # thread (chiefs) or task (everyone else, fresh per task)
machine: lab-server # where it runs; defaults to its project's, then its workspace's
```

### install.yaml accounts (milestone 5)

```yaml
accounts:
  claude-subscription: { driver: claude, max_sessions: 4 } # refuses new sessions now; queues tasks from milestone 5
  openrouter: { driver: openrouter, secret: openrouter-key } # also serves model steps
```

### workspaces/&lt;id&gt;/routines/&lt;name&gt;.yaml (milestone 5)

A trigger, one agent and one skill, run as a task.

```yaml
description: Yesterday's work and what's waiting on me, every weekday morning.
trigger: { schedule: '0 7 * * 1-5' }
agent: chief-of-staff
skill: morning-brief
post: { channel: chat }
accept: { sections: [Done, Waiting on you, Today], rubric: brief }
```

### workspace.yaml additions (milestones 5 and 9)

```yaml
pairs: { daily_limit: 3, max_rounds: 1 } # pairs are opt-in per task or agent
payments: # milestone 9
  currency: GBP
  limits: { per_purchase: 50, per_day: 100, per_month: 300 }
  agents: { marketer: { per_day: 20 } }
  merchants: [registrar.example] # anything else is refused
```
