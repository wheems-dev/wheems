# Config formats

Config is YAML and Markdown in a git folder, `~/opinr` by default (`OPINR_HOME` or `--home`
moves it). Adding an agent, channel or workflow means editing config, not code.

Every format has a JSON Schema in [`schemas/`](../schemas/), generated from the Zod schemas in
[`src/config/schemas.ts`](../src/config/schemas.ts). They ship in the npm package. Point your
editor at one for completion and hover help, for example with the YAML language server:

```yaml
# yaml-language-server: $schema=/path/to/opinr/schemas/workspace.schema.json
```

`opinr validate` checks files or a whole install folder, with line numbers. For a folder it also
checks the links between files: that names point at things that exist, and that each level only
picks from the level above. `opinr doctor` runs the same checks.

Keys are `snake_case`. Names (of workspaces, agents, accounts, connections, channels, skills and
workflows) are lowercase letters, digits and dashes. Unknown keys are errors, so a typo never
passes silently.

A complete example lives in [`examples/install/`](../examples/install/).

## install.yaml

One per person. Holds what every workspace shares.

```yaml
herdr:
  version: 0.1.20 # the minimum Herdr core version; Opinr's own minimum applies if higher
  binary: /opt/hc # optional: hc's path when it is not on PATH

machines:
  laptop:
    local: true # the machine the install lives on (at most one)
    reach: outbound # it connects out to the hub to collect work; the hub never connects in
  server:
    herdr: server # its name in `hc machine ls`
    always_on: true

accounts: # what pays for models
  claude-subscription: { driver: claude }
  openrouter: { driver: openrouter, secret: openrouter-key }

connections: # channels and integrations, connected once
  slack: { driver: slack, secret: slack-tokens }
  github: { driver: github, secret: github-token }
```

`secret` names a credential in Opinr's secret store. Credentials never appear in config.

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

channels: # chat, approvals and updates are built in; add any others
  chat: { connection: slack, channel: acme-chat }
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
---

# Reviewer

Review the pull request you are given. Report findings; do not change code.
```

`name` defaults to the file name, and must match it if given.

## workspaces/&lt;id&gt;/skills.yaml

The skills this workspace uses, each pinned to a library version, so library edits never
silently change a live workspace. Agents pick from this list.

```yaml
skills:
  release-notes: 1.2.0
  code-review: 0.4.1
```

## workspaces/&lt;id&gt;/workflows/&lt;name&gt;.yaml

A trigger, then steps. Version one has three triggers and three steps.

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
