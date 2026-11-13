# Wheems architecture ideas: a proposal

Claude's answer to the design round on [architecture.md](architecture.md), 13 November 2026.

> Kept as written for the design round, apart from personal details. What was decided is in
> [decisions.md](decisions.md).

**In one paragraph.** Most of the sketch fits the roadmap as it stands. The new parts hang together if Wheems gets one new primitive: **the task**. A task is a written brief handed to an agent that runs in a fresh Herdr session, with a written result handed back. Routing a question to a project lead is a task. A workflow's agent step is a task. A pair is two tasks plus a third that compares them. Projects become real units inside a workspace, each with its own lead, knowledge base and Slack channel. They are scoped, not sealed: the workspace stays the only wall Wheems enforces. Purchases start as "the agent prepares, you pay", and the vault never types card numbers into web pages. Computer use is a tool the agent is given, not a new engine.

---

## 1. Map of the ideas

"Planned" means on the roadmap today. Milestone numbers are the current ones.

| Idea in the write-up                                                        | Status                         | Where, or what differs                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Top chief you can always talk to                                            | Built                          | The workspace chief of staff (M1)                                                                       |
| Three levels: install, workspace, project                                   | Planned differently            | M4 has projects inside workspaces, but as one file each (folder, space, agents, rules), not a unit      |
| A chief officer per project, reachable directly in Slack                    | **New**                        |                                                                                                         |
| A knowledge base per project                                                | **New**                        | Today there is one per workspace                                                                        |
| Top knowledge base as an index of project cards                             | **New**                        |                                                                                                         |
| Questions routed down to a project and answered back up, with sources       | **New**                        |                                                                                                         |
| `wheems project new` writes the card, the chief and Wheems' instructions    | **New**                        | M4 creates projects, but no command or card is planned                                                  |
| Direct search or always ask the project's chief                             | **New** (a decision)           | See decision 2                                                                                          |
| Every chief and agent its own Herdr session, folder, instructions, memory   | Partly built, partly new       | One session per chat thread exists (M1). Agents all share the workspace folder today                    |
| Hand-offs as a written task in, result out                                  | **New**                        | Close to M6's "checked step outputs"                                                                    |
| A project chief's messages copied up to Wheems as a one-line note           | **New**                        | The overseer's summaries (Later) are the nearest thing                                                  |
| Teams are the user's own: agents as Markdown files                          | Built (format), planned (team) | Agent files exist; teams in M5                                                                          |
| Templates: marketing, research, Cloudflare, AWS                             | Planned differently            | M5 ships developer and reviewer; product.md lists marketer, DNS specialist, servers engineer            |
| Long-lived or fresh, as a setting per agent                                 | **New**                        |                                                                                                         |
| Several agents with the same role                                           | Already possible               | Two agent files                                                                                         |
| Pairs: two engines, same brief, then compare                                | **New**                        | M5's Codex-reviews-Claude is related but different                                                      |
| Secrets in the device keychain                                              | Planned differently            | M8's secret store is an encrypted file; Keychain is "later"                                             |
| Agents never see a secret; a Wheems tool uses it                            | Planned                        | The broker, M8                                                                                          |
| A log of every use of every secret                                          | Planned                        | The broker logs every call, M8                                                                          |
| The vault decides which secrets each machine may use                        | **New**                        |                                                                                                         |
| Cards, purchases, spending limits, asking first                             | **New**                        |                                                                                                         |
| Card numbers passed to a payment page by the vault itself                   | **New**                        | I recommend cutting it (section 3.6)                                                                    |
| One skills library; workspace opts in; agent narrows; nothing on by default | Planned                        | Library and proposals built (M2); scoping and pinning in agents' sessions, M4                           |
| Skills loaded only when needed                                              | Already true                   | The Agent Skills format loads names and descriptions first; the skill budget warning is planned (M4)    |
| DAG workflows as YAML, recorded runs                                        | Planned                        | M6                                                                                                      |
| Agent step runs as a full Herdr session                                     | Planned                        | M6's "run an agent" step; this proposal says how                                                        |
| Plain LLM call step                                                         | **New**                        | Defer (section 4)                                                                                       |
| Shell, HTTP and wait steps; retries                                         | **New**                        | v1 has agent, ask and post; "wait for an event" and "call an integration" are Later                     |
| SQLite search, zero setup                                                   | Built                          | M2                                                                                                      |
| Postgres with pgvector                                                      | Planned                        | Later (vector store driver)                                                                             |
| Headless systems from blueprints, CRM first                                 | Planned                        | M7 (named "blueprints")                                                                                 |
| Read-only web view of a blueprint                                           | Planned differently            | A web interface is Later, for set-up and approvals                                                      |
| Agents on other machines, per agent                                         | **New** in part                | The runtime contract already takes `machine`; workspaces name a default machine; always-on server is M9 |
| Computer use on GUI machines                                                | **New**                        |                                                                                                         |
| Services beside the tree, granted per workspace or agent                    | Planned                        | The three-level grant pattern for skills, integrations and accounts                                     |

---

## 2. Decisions to make

### Decision 1. Levels: what is a project?

| Option                                | What it means                                                                                                                                               | For                                                   | Against                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Sealed unit                        | Own Claude config folder, secrets, accounts, deny rules against sibling projects                                                                            | Real walls between projects                           | It is a workspace under another name. Two kinds of wall to explain and test. The workspace chief can't read it, so every question must go through its lead.      |
| B. Workspace with a parent            | Two levels; a "project" is a child workspace                                                                                                                | Reuses all the workspace code                         | Same as A, and integrations, skills and accounts must be granted twice. Routing across a wall breaks the product's promise that workspaces can't see each other. |
| **C. Scoped unit inside a workspace** | Own lead (optional), knowledge base, team list, Slack channel and session folders. Shares the workspace's accounts, secrets, integrations, rules and skills | Matches the sketch; cheap; routing is easy and honest | Projects in one workspace are not confidential from each other                                                                                                   |
| D. Light: a folder and a tag          | Today's plan: one file per project                                                                                                                          | Least work                                            | No lead, no knowledge base, no channel. Doesn't do what the owner wants                                                                                          |

**Recommendation: C.** It keeps the product's existing rule: _a workspace is the confidentiality boundary; a project is a body of work inside one._ Walls between projects are about clean context, not secrecy. Wheems enforces them in its own commands (search, tasks, notes), and the engine driver writes deny rules for sibling project folders as best effort (layer 5). Doctor and the README say plainly that projects are scoped, not isolated. That avoids claiming a guardrail that rests on instructions, which the product forbids.

The rule to give users: **if you want one chief who can answer about it all, put it in one workspace as projects. If it needs secrecy or other people, make it a workspace.** The cross-workspace top level stays the read-only overseer (Later), which sees summaries only. There is no chief above workspaces.

So there are three levels (install, workspace, project), but only workspaces and projects have chiefs, and only workspaces have walls.

### Decision 2. Routing: search directly, or ask the lead?

| Option                         | For                                                                  | Against                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Always ask the lead            | The lead adds judgement and knows live state                         | A fresh session per question: a minute or more, real tokens, and rate limits. The lead would mostly run the same search the chief could run |
| Always search directly         | Fast (under a second), free, no extra session                        | Misses what isn't written down yet; can't act                                                                                               |
| **Search first, ask for jobs** | Questions answered from the page; work and live state go to the lead | Two paths to explain                                                                                                                        |

**Recommendation: search first, ask for jobs.** This changes the owner's suggested default, for a reason: under option C there is no wall for "asking" to respect, so asking buys judgement, not privacy, and judgement costs a session. Concretely:

- `wheems kb search` from the workspace chief searches the workspace's own pages, the cards, and every project with `routing: search` (the default). Each result is labelled with its project.
- A project with `routing: ask` is left out of the chief's search. The chief must send it a task. That's for projects whose lead holds context that isn't in the knowledge base yet, or that the owner wants answered in the lead's voice.
- Anything that needs doing, or live state ("is the deploy finished?"), goes to the lead as a task, whatever the setting.

### Decision 3. Slack: how project leads are reached

The free plan allows unlimited channels, 10 apps and 90 days of history. Wheems already uses one app for every workspace, and the channel driver already supports per-workspace identities (`chat:write.customize` works on the free plan).

| Option                                       | For                                                      | Against                                                                          |
| -------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **A channel per project**                    | Obvious where to talk; one binding per channel, as today | More channels (free, though)                                                     |
| Threads in the workspace chat, with a prefix | No new channels                                          | Routing by parsing text; a typo goes to the wrong agent; hard to scan on a phone |
| An app per lead, so each can be @-mentioned  | Real mentions                                            | Hits the 10-app limit fast, and each app needs its own install and tokens        |

**Recommendation: a channel per project**, named `<workspace>-<project>` by default (`acme-storefront`), with the lead posting under its own name and icon. `approvals` and `updates` stay one per workspace, with each post tagged with its project, so channels don't multiply by three. `wheems project new` creates the channel if the app has `channels:manage`. If not, it tells you to create it and invite the bot, and doctor checks it.

The copy-up to Wheems is not a Slack post. When a project note is filed, its first line goes onto the project's card ("Recent") and into the workspace's `knowledge/activity.md`. The workspace chief loads the latest lines at launch. Slack stays quiet, and the chief still knows what happened.

### Decision 4. Context: long-lived or fresh

Today a chief has one engine session per Slack thread, stopped when idle (at most 4 live per workspace) and resumed on the next reply. That is the right shape, and I would not change it to one immortal session per chief. A session that runs for weeks gets compacted, loses detail without saying so, and one crash loses it all. Continuity should come from the knowledge base, the brief and the activity lines, which are files.

| Who                                     | Lifetime                                                                         | Why                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| Workspace chief                         | Per Slack thread, resumable (as today)                                           | You talk to it                                      |
| Project lead                            | Per Slack thread in its channel; **fresh per task** when the chief sends it work | Same as the chief; tasks don't pollute your threads |
| Workers (developer, reviewer, marketer) | **Fresh per task**, ends when it reports                                         | Clean context, cheap to run in parallel             |
| Filer                                   | Fresh per note (as today)                                                        |                                                     |
| Pair members and the judge              | Fresh per task                                                                   | They must not see each other in round one           |
| Workflow agent steps                    | Fresh per run                                                                    | Runs must be repeatable                             |

Agent front matter gets `lifetime: thread | task`. The default is `thread` for the chief and leads, `task` for everyone else.

**The hand-off format is a task file and a result file**, both Markdown with front matter, kept in `.wheems/tasks/<id>/`. One format for every hand-off: chief to lead, lead to worker, workflow step, pair. The result doubles as the session's note, so a task costs no extra note turn. See 3.2.

---

## 3. Designs for the new pieces

### 3.1 Projects: layout, config and commands

```text
workspaces/acme/
├── workspace.yaml
├── agents/                    workspace agents: chief of staff, shared workers
├── skills.yaml
├── knowledge/
│   ├── brief.md
│   ├── activity.md            new: one line per filed project note, newest first, capped
│   ├── cards/storefront.md        new: generated, one per project
│   └── inbox/ notes/ pages/ reports/
└── projects/
    └── storefront/            was projects/storefront.yaml
        ├── project.yaml
        ├── agents/lead.md     project-only agents
        └── knowledge/         same shape as the workspace's: brief, inbox, notes, pages, reports
```

```yaml
# projects/storefront/project.yaml
name: Storefront
description: Acme's online shop.
folder: ~/Projects/storefront # the code, if there is any; worktrees are made from it
lead: lead # agents/lead.md in this project; leave out and the workspace chief covers it
channel: { connection: slack, channel: acme-storefront }
team: [developer, reviewer] # workspace agents this project may use, plus its own agents/
skills: [release-notes] # narrows the workspace's skills.yaml
machine: server # default for this project's agents
routing: search # search (default) or ask
```

Rules stay in `workspace.yaml`, which already takes `project:` on a rule.

**Cards are generated, never written by an agent.** A card holds the project's name, description, lead, channel, folder, status, a "Can answer about" list taken from the project's brief headings, and the last five "Recent" lines. Code writes it at `project new`, after each project note is filed, and at the nightly tidy. It is capped at 1,500 characters and checked like any page. Because it's derived from `project.yaml` and the project's brief, it can't drift; `wheems validate` reports a card with no project or a project with no card, and doctor rewrites them.

**Wheems' own instructions aren't edited either.** The built-in instructions (`withBuiltins`) gain a generated "Projects" section, built from the `project.yaml` files at each launch: name, one line, lead, channel, routing.

Commands:

| Command                                                                             | What it does                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wheems project new <name> [-w ws] [--folder p] [--lead template] [--channel name]` | Creates the folder, `project.yaml`, the lead from a template, an empty knowledge base and the card; creates or checks the channel; validates; commits |
| `wheems project list`                                                               | Projects, leads, channels, routing, note counts                                                                                                       |
| `wheems project rename <old> <new>`                                                 | Moves the folder, rewrites the card, rules and bindings; old sources stay valid through a `renamed_from` line                                         |
| `wheems project archive <name>`                                                     | Moves it to `projects/_archive/`, marks the card archived, stops its channel binding. Knowledge is never deleted                                      |
| `wheems kb search "<q>" [--project p \| --all]`                                     | Defaults: a lead searches its project; the workspace chief searches its own pages, cards and `routing: search` projects                               |

**Under the hood**, small changes to what exists:

- A note carries `project` from `WHEEMS_PROJECT`, which the service sets like `WHEEMS_WORKSPACE`. The workspace's one filer files it into that project's knowledge base. One filer per workspace, still one note at a time.
- The search index gets one generation per knowledge base: collection `<workspace>.<project>.<generation>`. A search over several is fused with the same reciprocal rank fusion, since one embeddings model built them all.
- `Binding` gains `project` and `agent`, so a message in `acme-storefront` reaches Storefront's lead. The conversation key gains the project.
- Sessions are labelled `project=<name>`, and each project is a Herdr space, as M4 already planned.

### 3.2 The task: one hand-off for everything

This is the new core piece. It also settles the open question in `architecture.md` about how a skill reaches only its own agents: every agent session gets **its own folder** (`.wheems/sessions/<workspace>/<agent>/` for thread agents, `.wheems/tasks/<id>/work/` for tasks), so the engine driver can write that agent's instructions file and only its pinned skills there.

```markdown
<!-- .wheems/tasks/20261113-0412-k7/task.md, written by Wheems -->

---

id: 20261113-0412-k7
from: acme/chief-of-staff (conversation acme:slack:C01:1731)
to: acme/storefront/lead
kind: question # question, job, review, pair-member, judge, workflow-step
timeout: 15m
expects: { sections: [Answer, Sources] } # optional; a result without them fails
---

What is still blocking the storefront release?

## Context

- knowledge/cards/storefront.md
- projects/storefront/knowledge/pages/release-plan.md
```

```markdown
<!-- result.md, sent by the agent with `wheems task done` -->

---

status: done # done, blocked or failed
summary: Two migrations are untested on staging; nothing else blocks it.
artifacts: [https://github.com/…/pull/212]
---

## Answer

…

## Sources

- projects/storefront/knowledge/pages/release-plan.md
```

How a task runs (the `TaskRunner`, in the service):

1. `wheems task new --to <project>/<agent> "<brief>" [--wait 15m] [--pair …]` writes `task.md` and records the task in the service's SQLite store.
2. The runner prepares the agent with its engine driver, in the task's own folder. For code work it first makes a git worktree of the project's `folder` on a branch `wheems/<task-id>`.
3. It starts the session through the runtime driver on the agent's machine, labelled `wheems=task`, `task=<id>`.
4. It follows the session as conversations are followed today: by status for Claude Code and Codex, by answers for opencode. A permission prompt posts to `approvals` with the `hc attach` line.
5. The agent finishes with `wheems task done < result.md`. The service checks the shape (front matter, `expects`, nothing that looks like a credential) and refuses a bad result with the reason, so the agent can fix it.
6. If the session goes quiet without a result, the runner types one reminder. After that, the task fails with `no_result`.
7. The result is filed as the session's note (with `origin: automated` unless a person asked), then the session is stopped and kept for a day for `hc attach`. A waiting `--wait` caller gets the result on standard output.

Concurrency: a new `max_sessions` per **account** in `install.yaml` (not just per workspace) queues tasks so leads, workers and pairs can't exhaust one subscription together.

**A workflow's agent step is a task.** `- agent: developer` with `task:` becomes `task.md` with `kind: workflow-step`, run as above; `output:` on the step becomes `expects:`. The run record keeps the paths of both files. Nothing else in M6 changes.

**The routing flow**, end to end:

1. You ask in `acme-chat`: "What's blocking the storefront release?"
2. The chief runs `wheems kb search`. Hits are labelled `[storefront]`, and the Storefront card ranks too.
3. If the pages answer it, the chief replies with links.
4. If not, or Storefront has `routing: ask`, or it's live state or work: `wheems task new --to storefront "<question>" --wait 15m`. The Storefront lead answers in a fresh session.
5. A question spanning projects sends tasks **in parallel**, not in turn, and the chief combines the results.
6. The chief replies, citing the lead's sources.

### 3.3 Pairs

A pair is two task members and a judge task, all fresh sessions.

```yaml
# on an agent, a workflow step, or `wheems task new --pair`
pair:
  with: [designer-claude, designer-codex] # two agents, ideally on different providers
  rounds: 1 # 2 or more: each sees the other's result, anonymised, and may revise
  judge: asker # asker (default), or an agent name, such as one on a third provider
```

1. **Run.** The same `task.md` goes to both members, each in its own folder or worktree. Neither is told about the other.
2. **Rounds.** For `rounds: 2+`, each member gets the other's result labelled only "the other proposal", and revises. This is how the brand was made, and how this design round is run.
3. **Judge.** A judge task gets both results as A and B, in random order, with engines and models stripped out to cut self-preference. A fixed template asks for: where they agree, where they differ and which is better on each point, a recommended merge, and a confidence. That becomes `compare.md`.
4. **Pick.** Wheems posts the comparison with buttons: Take A, Take B, Merge, Neither. For code, A and B are branches; Merge sends the winner a follow-up task listing the points to bring over.

The judge defaults to the agent that asked, because it holds the context. For evals, the existing rule applies: a judge from a different provider, such as opencode on OpenRouter. Pairs are off unless asked for. Doctor reports how many ran this week, and `pairs.daily_limit` in `workspace.yaml` caps them.

A useful side effect: a Claude member and a Codex member draw on different accounts, so pairs spread load across providers rather than doubling it on one.

### 3.4 Agents on other machines

The runtime contract already takes `machine`, and `hc run --on` works. What's missing:

- `machine:` in agent front matter, falling back to the project's, then the workspace's.
- **Files on the other machine.** The service writes launch-plan files locally today (`writePlanFiles`). The remote machine needs them. Proposal: a small `wheems node` on each machine, started by Herdr, which receives plan files from the service and writes them into the session folder there.
- **The CLI on the other machine.** `wheems note`, `reply` and `task done` talk to the service over a local Unix socket. `wheems node` relays them to the hub. The relay should go over the same SSH link Herdr already uses; whether Herdr can carry it (a forwarded socket or a channel of its own) is the main unknown to test.
- **Secrets stay on the hub.** Remote agents call the broker like local ones, so no secret has to sit on another machine. If a CLI there truly needs one, `machines.<name>.secrets: [...]` names it, and doctor flags it.

This is the same machinery as the laptop that connects out to collect work (old M9, new M10), so it belongs there.

### 3.5 Computer use

**Computer use is a tool given to an agent, not an engine.** The agent is still Claude Code or Codex. It gets desktop tools that act on a GUI machine. That keeps every engine able to use it, and it puts every click through the broker, where rules and logs live.

- **New driver type `desktop`**, with a contract and contract tests: `screenshot()`, `click(x, y)`, `type(text)`, `key(combo)`, `scroll()`, `check()`. First driver: `linux-x11` for Ubuntu, using xdotool and a screenshot tool, run by `wheems node` on that machine. `wheems/testing` gets a `MemoryDesktop`.
- **Config.** `machines.lab-ubuntu: { gui: { driver: linux-x11, display: ':0' } }` in `install.yaml`. It is granted like an integration: `integrations: [desktop-lab-ubuntu]` on the agent.
- **Through the broker.** The broker's MCP server offers `desktop.*` tools only to agents that were granted them. It logs every action and keeps every screenshot in `.wheems/desktop/<task-id>/` for review.
- **Guardrails, in order of strength:**
  1. _Machine level (the real one)._ The GUI machine is a dedicated VM or desktop user with no saved passwords, no payment methods and only the accounts the job needs. It resets to a snapshot on a schedule.
  2. _Broker._ `type()` refuses text that looks like a credential or passes a card-number (Luhn) check. It refuses typing into a password field where the accessibility tree says so (best effort).
  3. _Approval._ A task with desktop tools runs with `approval: before_irreversible`: the agent must `wheems ask` before submitting, paying, sending or deleting. This one rests on instructions, so doctor shows it as a warning, as the product requires.

### 3.6 Vault, cards and purchases

**Keys.** Ship the secret store contract as planned (old M8, new M9), with `keychain` (macOS) as the default on a Mac, `secret-service` on Linux desktops, and the encrypted file kept for headless servers, where the Linux secret service usually isn't unlocked. The broker logs every use to `.wheems/audit/secrets.jsonl`: secret, agent, task, call, time.

**Purchases.** The idea of the vault passing card numbers into a payment page should be **cut**. It makes Wheems a browser autofill, it's fragile, and the agent controls the same browser and can read what was typed. Instead, three paths, in order of preference:

1. **Through an integration's own billing.** Most of what agents would buy (domains, cloud, SaaS seats) can be bought through the merchant's API against the account's stored card, such as Cloudflare Registrar. A purchase is then a broker action like any other, with a price, limits and approval. No card number goes anywhere.
2. **You pay (new M9).** `wheems buy` posts the item, merchant, amount, card last four, agent and task, with the checkout link. You pay on your phone and tap Paid. The agent continues. No card in Wheems at all.
3. **Single-use cards (Later).** A `card-issuer` driver (where an issuer API exists, such as Lithic or Stripe Issuing) mints a card locked to that merchant and amount, valid for an hour, after you approve. The agent may type that one card, because it is worthless for anything else.

```yaml
# workspace.yaml
payments:
  currency: GBP
  limits: { per_purchase: 50, per_day: 100, per_month: 300 }
  agents: { marketer: { per_day: 20 } }
  merchants: [cloudflare.com, namecheap.com] # anything else is refused outright
```

```bash
wheems buy --merchant cloudflare.com --amount 9.77 --currency USD \
  --item "example.com, 1 year" --reason "Landing page for the launch"
```

The broker checks limits **before asking**: over a limit is refused, not offered for approval. Every purchase asks, every time, with no auto-approve setting. Every request, answer and payment goes to `.wheems/audit/purchases.jsonl`, and running totals come from that file. The hard backstop is a card with a low limit set at the bank. Doctor warns if `payments` is on and no issuer-side limit is recorded.

---

## 4. Roadmap changes

M0 is done, M1 is waiting for its Slack test, and M2 is mostly built. Nothing here touches M1 to M3. The change is to put **projects and tasks before the second workspace**, because the owner's daily use is many projects in a few workspaces, and the task primitive solves the open skill-delivery question that M4 needs anyway.

| #   | Milestone                                       | What changes                                                                                                                                                                                        | Done when                                                                                                                                                          |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3   | Approvals and updates                           | Unchanged. Pairs and purchases need its buttons                                                                                                                                                     | Unchanged                                                                                                                                                          |
| 4   | **Projects and leads** (new)                    | Project folders, `project.yaml`, `wheems project new/list/rename/archive`, project knowledge bases and indexes, cards, `activity.md`, a lead per project in its own channel, search across projects | You ask the workspace chief about a project and get an answer with sources from its knowledge base, and you chat with that project's lead in its channel every day |
| 5   | **Tasks and a team** (was 5, grown)             | The task format and runner, `lifetime`, per-agent session folders (which deliver pinned skills), per-account `max_sessions`, developer and reviewer templates, routing jobs to leads, **pairs**     | A lead hands a job to a Claude developer, a Codex reviewer checks it, and a pair answers a design question with a comparison you pick from                         |
| 6   | A second workspace, kept apart (was 4)          | Per-workspace Claude config folder, deny rules, skill budget. Skill scoping already works from M5                                                                                                   | Unchanged                                                                                                                                                          |
| 7   | Workflows and evals (was 6)                     | The agent step is a task; `pair:` on a step; add `shell` and `wait` steps and retries                                                                                                               | Unchanged                                                                                                                                                          |
| 8   | Data and blueprints (was 7)                     | Unchanged                                                                                                                                                                                           | Unchanged                                                                                                                                                          |
| 9   | Integrations, guardrails and the vault (was 8)  | Keychain and secret-service drivers, the secret-use log, `payments` limits, `wheems buy` paths 1 and 2                                                                                              | Add: an agent buys a domain after one tap, and an over-limit purchase is refused without asking                                                                    |
| 10  | Always on, more channels, more machines (was 9) | `wheems node`, plan files and the CLI relayed to remote machines, `machine:` per agent                                                                                                              | Add: one project's worker runs on the home-lab server while the lead runs on the always-on server                                                                  |
| 11  | Plugins and release (was 10)                    | Unchanged                                                                                                                                                                                           | Unchanged                                                                                                                                                          |

**Version one's goal** becomes: one person runs two workspaces every day, one of them with at least three projects that have leads, from Slack and Telegram, across a laptop, an always-on server and a home-lab machine.

**Deferred to Later:**

- Computer use (the `desktop` driver). It needs `wheems node` (new M10) and a safe GUI machine. Build it first after version one.
- Single-use cards (purchase path 3).
- The plain LLM call step. The owner's accounts are subscriptions, which don't give a raw API. When it comes, it should run through an account driver with an API key (OpenRouter), as a step type, not a special case.
- The HTTP step. Calls to outside services should go through integrations and the broker, which is "call an integration", already Later.
- Read-only blueprint views, folded into the web interface.

**If version one gets too long**, the cheapest cut is Telegram. Projects and tasks are worth more day to day.

---

## 5. Risks and unknowns

- **Cost of pairs.** Roughly 2.3 times one task: two members, plus a judge reading both. Opt-in only, with a daily cap and doctor's weekly count. Rounds multiply it again; keep the default at one.
- **Rate limits.** More leads, workers and pairs all draw on the same subscriptions. The per-account `max_sessions` queue is the defence. Expect to tune it after a week of use. Pairs across two providers hurt less than two sessions on one.
- **Provider terms.** Running Claude Code and Codex unattended on your own subscription, for yourself, is the current assumption. Tasks make Wheems much more unattended (workflows, leads answering each other). Check Anthropic's and OpenAI's terms again before M5, and before the release say clearly that installs serving others should use API keys.
- **Herdr on other machines.** Unknown whether `hc` can carry files and the CLI relay over its SSH link, or whether `wheems node` needs its own SSH. Test before planning M10 in detail.
- **Purchases.** The danger is prompt injection: a web page or email telling an agent to buy something. Defences: a merchant allowlist, limits checked in code before asking, every purchase asked, a low-limit card at the bank, and no card in Wheems for path 2. Never add auto-approve.
- **Computer use.** Screens can carry injected instructions too, and approval before irreversible actions rests on instructions. The machine-level guard (a reset VM with nothing worth stealing) is the one to trust. Also: Ubuntu's default desktop is Wayland, where xdotool doesn't work. The first driver needs an X11 session, or a Wayland tool such as ydotool.
- **Projects aren't walls.** Someone will assume they are. Doctor, the README and `project new`'s output must say so, and point to workspaces for secrecy.
- **Slack history.** The free plan drops messages after 90 days. Conversations still resume, because Wheems keeps the session, but old threads disappear from Slack. That's already noted for version one; leads in more channels make it more visible.
