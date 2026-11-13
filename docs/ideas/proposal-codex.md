# Wheems: projects with chiefs, one execution path

Codex's answer to the design round on [architecture.md](architecture.md), 13 November 2026.

> Kept as written for the design round, apart from personal details. What was decided is in
> [decisions.md](decisions.md).

**Recommendation:** keep install → workspace → project. Give each project a chief, knowledge base and team. Keep confidentiality at the workspace boundary. Route project questions through their chiefs by default. Use the existing task runner for delegation, workflow steps and pairs. Defer purchases and computer use until broker enforcement and remote execution are dependable.

This proposal uses only the local repository and its architecture ideas. No external service or provider terms were checked. All configuration additions below are proposals, not syntax supported today.

## 1. Map of the ideas

“Planned” means in the existing roadmap, not necessarily implemented. M refers to its current milestone numbers.

| Idea from the sketch and notes                                      | Status against the existing plan                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top chief that answers and delegates                                | **Planned, M1/M5:** workspace chief and team. An install-wide executive would differ from the later, read-only overseer.                                      |
| Projects inside workspaces, shown as Herdr spaces                   | **Planned, M4.** Project loading and execution are not built.                                                                                                 |
| Project chief, its own team and KB                                  | **New:** M4 projects currently have folder, space, agents and rules, not independent chiefs or knowledge loops.                                               |
| Projects walled off from one another                                | **Planned differently, M4:** isolation belongs to workspaces; hard isolation is later.                                                                        |
| Shared services with grants at each level                           | **Planned, M4/M8:** skills, accounts and integrations narrow from install to workspace to agent. Project grants add a level.                                  |
| Top KB contains project cards, not project content                  | **New:** M2 currently keeps a workspace KB, brief and notes.                                                                                                  |
| Keyword and meaning search to select a project                      | **Partly planned, M2:** search exists; searching cards and routing are new.                                                                                   |
| Ask project chief; return sources; combine several answers          | **New:** direct project search as an alternative is also a new access decision.                                                                               |
| `project new`, rename/remove, card and instruction maintenance      | **New command and lifecycle** within M4's planned projects.                                                                                                   |
| Each agent has its own Herdr session, folder and context            | **Planned differently, M1/M5:** conversations have sessions per thread, but chat sessions currently share a workspace folder.                                 |
| Written task/result hand-offs                                       | **New team contract:** the filer already uses a one-task runner.                                                                                              |
| Direct Slack access to project chiefs; optional summary upward      | **New routing:** M1 supplies Slack and thread continuity.                                                                                                     |
| User-edited Markdown teams and role templates                       | **Planned, M5:** developer/reviewer first. Marketing, research, Cloudflare and AWS are additional templates. Two agents with one role need no new role type.  |
| Chiefs stay alive; workers start fresh; per-agent choice            | **Planned differently:** M1 resumes thread conversations; the filer starts fresh. A lifecycle setting is new.                                                 |
| Claude/Codex pairs, independent answers and comparison              | **New:** M5 cross-provider review and M6 eval judges are related, but not independent parallel attempts.                                                      |
| Vault injects keys outside the model; audited uses                  | **Planned, M3/M8:** broker and secret store. **Different default:** drivers.md plans an encrypted file first, Keychain later; today's store is mode-600 JSON. |
| Keychain/Linux secret service instead of credential files           | **Planned differently, M8:** changes the secret-store driver priorities.                                                                                      |
| Cards, purchase approvals, limits, vault-only payment entry         | **New.** Requires a payment executor as well as secret storage.                                                                                               |
| Install skill library, opt-in, scoped and pinned                    | **Planned, M4; partly built in M2:** library/proposals/pins exist, session delivery does not. Mandatory framework instructions remain built in.               |
| Skill descriptions first, full text on demand                       | **New explicit delivery requirement:** hundreds of descriptions still have a context cost.                                                                    |
| YAML DAG, parallel dependencies, checked outputs and recorded runs  | **Planned, M6.** Durable retry policy needs specification. Current schema only describes sequential agent/ask/post steps.                                     |
| Agent workflow step runs a full Herdr session                       | **Planned, M6:** `TaskRunner` already does this for filing. Subscription use remains subject to terms and limits.                                             |
| Shell, HTTP, plain LLM and wait steps                               | **New expansion:** V1 plans only agent, approval and post. Schedule is already an M6 trigger; event waiting is later in drivers.md.                           |
| SQLite/local RAG; Postgres/pgvector option                          | **Planned, M2 and later vector drivers.** Blueprint Postgres in M7 is a separate database contract; it does not move the search index to Postgres.            |
| Headless CRM/leads/inventory/content calendar, editable blueprints  | **Planned, M7:** CRM first, more templates later. KB pointers instead of rows are a useful added convention. Read-only web views are later scope.             |
| Agents placed on different machines; machine-specific secret grants | **Partly planned, M9:** install machines, workspace default and outbound laptops. Per-agent placement/grants are new; the runtime already accepts a machine.  |
| Ubuntu/cloud desktop computer use, screenshots and approvals        | **New:** the proposed “engine driver” needs a separate tool capability as well.                                                                               |
| Suggested build order                                               | **Different:** it puts projects ahead of approvals and keys after pairs. Keep M3 first; pairs must inherit its broker checks.                                 |

The starting evidence is [roadmap.md](../roadmap.md), [config.md](../config.md), [drivers.md](../drivers.md) and [the ideas](architecture.md).

## 2. Decisions to make

| Decision  | Options and trade-offs                                                                                                                                                                                                                           | Recommendation                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Levels    | Lightweight projects are cheap but cannot own the proposed knowledge and delegation. Full projects add configuration and filing work. Workspaces with parents reuse isolation but confuse workspace ownership and invite cross-workspace access. | Full operational projects inside workspaces. Separate workspaces for different people, confidentiality or future handover. No recursive workspace hierarchy.                                                                           |
| Isolation | Treat project folders as organization; enforce project access through tools; or give every project an OS boundary. The last is much more infrastructure.                                                                                         | Project scopes prevent accidental context mixing. They are **not confidentiality walls**. Keep M4's enforced workspace isolation; hard isolation requires separate users/VMs/machines. Asking a chief does not itself enforce secrecy. |
| Routing   | Direct search is faster and cheaper. Asking a chief adds latency but uses project judgement and local context.                                                                                                                                   | Ask the chief by default. Permit explicit read-only direct search per project. Actions always delegate through the broker.                                                                                                             |
| Top KB    | Cards only match the sketch but discard shared business knowledge and existing notes. Copying project content creates stale duplicates.                                                                                                          | Keep workspace-owned knowledge plus a generated project directory. Never mirror project pages upward. An install-level overseer still sees only published statuses.                                                                    |
| Slack     | One channel per project is obvious but creates channels. Prefixes in one channel are compact but need explicit addressing. One bot per chief wastes app slots.                                                                                   | One shared Slack app. Dedicated channels for active projects; `project:<slug>` in a workspace channel for occasional ones. Threads retain their selected chief.                                                                        |
| Context   | One immortal session per chief mixes unrelated jobs and serializes everything. Fresh sessions lose conversational continuity.                                                                                                                    | Chiefs resume **per thread**. Workers, delegated questions, pair members and scheduled steps start fresh per task. Knowledge outlives terminals.                                                                                       |
| Vault     | Encrypted files work headlessly; OS stores improve local custody but may be locked or unavailable on servers.                                                                                                                                    | Secret-store contract in M8, Keychain on Mac and a usable Linux backend. Retain an explicit encrypted-file option for headless hosts. Never silently fall back to plaintext.                                                           |

The repository records Slack Free as ten apps and ninety days of history. Those are planning assumptions, not freshly verified limits. One app serves all chiefs; changing its display identity does not create another mentionable bot. Persist task records and sources in Wheems so Slack retention is not the archive.

## 3. Projects, knowledge and conversations

### Files and configuration

Keep workspace-level agent definitions; projects select their team. This avoids duplicating templates and account declarations.

```text
workspaces/acme/
  workspace.yaml
  agents/{chief-of-staff,store-chief,developer,reviewer}.md
  skills.yaml
  workflows/
  knowledge/                  existing workspace-owned knowledge
    projects/<id>.md          generated routing cards
  projects/storefront/
    project.yaml
    knowledge/                brief, inbox, notes, pages, reports

.wheems/
  sessions/<workspace>/<conversation-or-task>/
  runs/<run-id>/               input, events, result, artifacts
  index/<workspace>/<scope>/   separate workspace/project generations
  filing/<workspace>/<scope>/
```

```yaml
# projects/storefront/project.yaml — proposed
id: 3db4f215-5c65-4ea8-b391-9cf097335e14 # immutable, generated
name: Storefront
description: Online shop, checkout and fulfilment.
answers: [checkout, orders, fulfilment]
folder: /srv/acme/storefront
space: acme-storefront
chief: store-chief
agents: [store-chief, developer, reviewer]
skills: [code-review] # subset of workspace pins
integrations: [github] # subset of workspace grants
knowledge:
  routing: chief # chief or direct
channels:
  chat: { connection: slack, channel: acme-storefront }
```

Agent front matter gains `lifecycle: thread | task`, optional `machine`, and later `computer: <grant>`. Defaults depend on launch purpose: chat uses threads; jobs use tasks. No workflow implicitly borrows a chat session. A project may select different agents with the same role. Existing workspace-only installs continue to work.

Effective skills and integrations are the intersection of workspace grants, project grants and agent selections. Workspace pins determine versions. Project omission inherits the workspace ceiling; an empty list grants nothing. Rules can narrow permissions, never relax an ancestor's denial. Machine selection is also checked against the workspace's permitted machines.

Extend the strict Zod schemas, generated JSON Schemas, loader, reference checks and doctor together. Reject missing chiefs, duplicate channel bindings, cycles and paths outside approved roots. A Herdr space is presentation, not an isolation mechanism.

### Registration and maintenance

Add `wheems project new storefront --workspace acme`, `project rename`, `project archive` and `project list`. Creation writes the manifest, chief template, empty KB and generated card in one staged change. Validate before publishing; use a recoverable journal for interrupted updates. Rename preserves the immutable ID, updates references and replaces the card. Archive disables new routing and retains sources and history; deletion is a separate deliberate operation.

Cards contain project ID, relative KB location, description, topics, chief, routing policy and manifest revision. The service generates them from manifests, including after manual edits. Doctor detects drift; startup repairs derived cards. Agents and the filer cannot edit generated cards. Keep them outside `pages/` and explicitly include them in the routing index.

Do not rewrite instructions inside a busy conversation. At each new turn, supply a bounded directory revision/update; fetch matching cards on demand. A hundred project cards should not become a hundred launch-time paragraphs.

### Reuse the knowledge loop

Generalize the existing workspace parameter into a scope `{workspace, project?}` in notes, search and filing. Keep each scope's inbox, filer scratch space, brief and index separate. Preserve current credential screening, source retention, conflict checks, brief cap and generation swaps. The service stamps scope and task provenance; agents cannot choose an arbitrary destination by changing an environment variable.

Do not automatically move old workspace pages into projects. Start new project KBs empty, then explicitly migrate selected sources. Workspace search must not recursively ingest project folders. Optional upward notices contain task status and a link, not project evidence. Full answers can pass through the parent conversation to the user, but are not automatically filed again as workspace knowledge.

### Routing and Slack flow

1. Authenticate the sender using the connection allowlist. Resolve workspace and an explicit project/channel binding before semantic routing.
2. For an existing thread, reuse its saved `{workspace, project, agent}` target. For a new workspace question, search only workspace knowledge and project cards. Low-confidence matches ask for clarification.
3. Submit a bounded task to the chosen chief. Default maximum: three projects, two running concurrently, one delegation level. No recursive chief-to-chief loops.
4. Each project chief searches its own scope and returns an answer, source paths/anchors and content revisions, uncertainty, and any unanswered part. A direct-search grant performs the same scoped retrieval without the extra agent turn.
5. Validate citations against authorized source files. Combine answers without hiding disagreements or missing projects. Return to the original thread. A timeout produces a partial answer, not an invented consensus.

In project channels, plain messages reach that chief. `@Wheems workspace: ...` explicitly reaches the workspace chief in a new routed conversation. In shared channels, `@Wheems project:storefront ...` selects a project. Changing target inside an established thread creates a linked child task, rather than feeding its transcript into another chief. Keep one workspace approvals channel initially; project IDs appear on every request.

`ConversationManager` currently hardcodes the chief and keys conversations by workspace/connection/channel/thread. Add persisted targets and keep old keys mapped to the workspace chief. Separate session directories also fix the shared instruction-file problem before multiple roles launch concurrently.

## 4. One task contract for workers, workflows and pairs

The useful starting point is [service/runner.ts](../../src/service/runner.ts). It already prepares an engine, writes launch files, starts Herdr, reads structured answers and stops the session. Extend it; do not add another agent loop.

A service-owned `input.json` contains task ID, parent ID, scope, agent, objective, acceptance criteria, allowed actions, source references/revisions, deadline and output schema. `result.json` contains status, answer, artifacts, sources, checks performed, unresolved questions and a proposed note. Keep these files bounded. Hand-offs reference artifacts; they never copy the full parent transcript.

The service validates results and queues their notes through the normal knowledge loop. Failed or interrupted work also leaves a service-authored outcome record. Distinguish work requested by a person from automated runs; do not blindly mark every child task automated and halve its search relevance.

Tasks need durable states: queued, running, waiting for approval, succeeded, failed, cancelled and outcome unknown. Persist runtime ID, engine ID, answer cursor and attempt before acknowledging progress. Recover existing work after restart instead of relaunching it. Authenticate CLI/MCP calls with a short-lived task credential bound to scope and grants, protected by the workspace execution boundary. Environment labels alone are not authorization.

### Workflow agent steps

Extend M6's schema with step IDs, dependencies, timeouts, output schemas and bounded retry policy. For example, a proposed step can declare:

```yaml
- id: brief
  agent: chief-of-staff
  needs: [collect]
  task: Summarise the collected notes and open work.
  timeout_seconds: 600
  output_schema: schemas/brief.json
```

Resolve dependency outputs into immutable task inputs; validate the DAG before launch. Pass the task through `EngineDriver.prepare` and `RuntimeDriver.start`. Follow engine status and structured answers, never terminal screen scraping. Validate the submitted result before releasing dependent steps. A completed turn is different from a terminated terminal, and a runtime wait timeout is only a check-in.

Upgrade the runner to support `typeAfterStart`, approval suspension, cancellation and crash recovery. Its current cleanup always stops/removes the terminal, and rerunning a matching job name replaces a session; neither is suitable for durable workflows unchanged. Give each attempt a unique identity. Retry read-only failures with backoff; an uncertain external write requires reconciliation before any retry. Approval/post steps use broker records and idempotency keys.

Ship agent/ask/post first. Keep schedules as triggers. Defer generic shell, HTTP, raw LLM and wait steps; later integration steps must use the broker. A shell step with credentials would bypass the architecture's main protection.

### Pairs

Add `wheems pair run design --workspace acme --project storefront --brief brief.md`. A workspace `pairs/design.yaml` names two agents, a comparison agent, rubric, timeout and budget. Prefer a named pair over `pair: true`, which leaves the second agent and cost unclear.

Compile it into two independent task steps followed by a comparison step. Both receive the same brief, source snapshot and acceptance criteria. Give each its own directory or code worktree and prevent access to the other's output until both finish. Neither gets publish, merge or purchase rights. Independent attempts may run sequentially when account capacity is tight without seeing each other's answers.

The comparison receives anonymous A/B outputs and the rubric. It reports agreements, disagreements, evidence, failed checks and a recommended synthesis. It does not count agreement as proof. The chief can select a low-risk draft; the user approves consequential actions. Applying code changes is a separate checked step.

One missing result is labelled an incomplete pair. Do not rerun the successful half automatically. Cap rounds, concurrency, elapsed time and account usage. Two attempts **plus comparison** cost more than twice one attempt; token estimates may be unavailable for subscription CLIs, so also enforce task/turn/time limits. Multi-round design work remains an explicit new run.

## 5. Vault and purchases

Use a `SecretStoreDriver` with `check`, service-only retrieval, put and delete. Agents get named broker operations, never a general `get_secret` tool. Scope a grant by workspace, project, agent, machine, operation and destination. Audit each attempted use with principal, purpose, secret reference and outcome, never its value. Redact responses as well as requests. A keychain under the agent's own unrestricted OS identity is not sufficient separation.

Purchases should be a later `PaymentDriver`, not arbitrary browser typing:

1. A merchant adapter creates a quote containing merchant, items, quantity, total including shipping/tax, currency, delivery destination, card alias/last four and expiry.
2. The broker checks per-agent, daily and per-merchant limits, then atomically reserves budget. Use integer minor units and an explicit timezone; separate currencies or require an approved conversion policy.
3. Every purchase asks an authorized user in Slack. Approval binds to the exact quote hash and expires. Any changed item, destination, amount or currency needs fresh approval. Approval does not override spending limits.
4. A protected executor uses a payment token or vault-controlled checkout. The model cannot inspect card fields, DOM, screenshots, clipboard or network logs during payment entry. Generic desktop agents cannot reach this executor's authenticated browser session.
5. Commit with an idempotency key; record the receipt and settle the reservation. On an ambiguous timeout, mark outcome unknown and reconcile the merchant transaction. Never blindly purchase again.

Prefer tokenized or limited virtual cards. Do not store card verification codes. Start with one supported merchant flow; unsupported sites require human checkout. An encrypted vault alone cannot make arbitrary purchases safe.

## 6. Machines and computer use

The Herdr runtime already forwards `machine` to `hc`; the chat and task runners currently do not pass placement. More importantly, engine preparation writes local files and answer readers inspect local transcripts. Adding `--on` alone will not make this work.

Add a small machine worker with a contract for staging a scoped bundle, launching/reconnecting a task, streaming structured results and collecting artifacts. It runs the existing engine/Herdr code where the files actually live. Preserve the rule that all `hc` calls go through `hc.ts`. For inbound hosts, Herdr supplies terminal reachability; laptops collect leases through authenticated outbound connections. Keep the hub's private Unix socket private.

Resolve placement agent → workspace default. Stage only authorized files and pinned skills; validate artifact paths and hashes. Lease attempts with fencing so a disconnected worker cannot later commit stale results or duplicate actions. Do not silently move an existing conversation to another machine. The hub brokers integration credentials; model accounts on workers need separate provisioning and doctor checks.

Computer use is a **tool/integration driver**, normally used by an existing Claude Code or Codex engine. A new engine is needed only for a different agent program. Define `ComputerDriver` with health/capabilities, acquire/release a desktop lease, observe a frame, and perform an action against a frame ID. Report standard `DriverError` kinds; refuse stale observations and unsupported operations. Publish contract tests like the other drivers.

Run one agent at a time in a dedicated desktop VM. Route GUI actions through the broker; block direct display access and alternate shell/browser automation that would bypass it. Allowlist destinations/apps, retain bounded before/after screenshots with access controls and retention rules, and redact sensitive views. Login uses human takeover; payments are disabled. Irreversible actions need an approval tied to the observed target and action. If an adapter cannot reliably identify the action, require human takeover rather than pretend a generic click classifier is a guardrail.

## 7. Roadmap changes

Keep milestone numbers and daily-use gates. Add work inside them in this order; do not declare later scope complete because its schema exists.

| Milestone | Change and daily-use exit                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0–M2     | Preserve the foundation. The tree contains substantial M2 code despite the roadmap's older status paragraph. Finish real Slack/knowledge-loop use before expanding. Exit: yesterday's work is reliably found today.                                                                    |
| M3        | Keep approvals first. Add durable action IDs and scoped broker identity. Slack buttons are currently unsupported in the driver. Exit: one real action waits for a phone approval and survives a service restart.                                                                       |
| M4        | Split internally: first workspace enforcement and per-session folders/skill delivery; then project manifests, cards, scoped KBs, chiefs and Slack routing. Exit: two isolated workspaces operate daily, with two projects in one and no accidental routing or retrieval across scopes. |
| M5        | Generalize the existing task runner for delegation and developer/reviewer teams. Add fresh worker hand-offs and duplicate-role templates. Exit: a project chief delegates daily work and a second provider reviews it.                                                                 |
| M6        | Durable DAGs, agent steps, checked outputs and evals. Add pairs as a small DAG template after the runner is dependable. Exit: daily morning brief, an asked-for workflow, an eval regression caught, and an opt-in pair produces a useful comparison.                                  |
| M7        | Keep database drivers and CRM. Add scoped blueprint grants and KB pointer pages. Exit: agents maintain the CRM daily; a requested field change is approved and migrated. Keep rows out of KBs.                                                                                         |
| M8        | Keep GitHub rules and integrations; add OS secret-store backends and complete audit coverage. Exit: real credentials are used only through granted broker operations and release holds work across engines. No cards yet.                                                              |
| M9        | Keep always-on hub, Telegram/email and outbound laptops; add per-agent placement, staging and remote result recovery. Exit: a daily task runs remotely while the laptop sleeps, and a disconnected task reconnects without duplicate effects.                                          |
| M10       | Keep plugins, contract suites and stranger-install test. Include the new project/task contracts and migration docs. Exit: the daily install updates cleanly and another person can set it up unaided.                                                                                  |
| After V1  | Pilot desktop use for one daily reversible task, then a separate payment pilot for one recurring purchasing need with approval every time. Defer generic workflow steps, pgvector, extra blueprints, data web views and an install-wide executive until use demands them.              |

Do not move all integrations ahead of workflows: M3 supplies the minimal broker/approval foundation; M8 supplies production credentials and external enforcement. If M4 cannot demonstrate workspace isolation for an engine, refuse that configuration or require an OS boundary. Do not substitute instructions for its acceptance test.

## 8. Risks and unresolved checks

- **Cost and rate limits:** chiefs, filing, routing and comparison all consume account capacity. Use one account-wide queue with workspace budgets; reserve capacity for interactive chat. Surface delays rather than silently changing providers.
- **Provider terms:** the roadmap's reassurance about subscriptions is not a compliance finding. Verify the actual terms for unattended personal use, delegated workers and service for others before enabling those modes. Keep API-funded accounts available.
- **Context and security:** separate folders stop instruction collisions, not hostile reads. Test cross-workspace file, transcript, skill and broker access for every supported engine and permission mode, including `skip`. Project routing adds no OS boundary by itself.
- **Quality:** routing can choose the wrong project; two agents can share the same mistake. Eval ambiguous routing, stale citations and disagreement handling. Preserve provenance instead of manufacturing certainty.
- **Secrets and desktops:** current regex screening is useful but cannot detect every secret. Token custody, protected execution and restricted outputs must do the enforcement. Screenshots themselves can hold sensitive data.
- **Recovery:** test service death after launch, after approval and after an external write. Payments and remote leases must treat unknown outcomes explicitly.
- **Dependencies:** confirm Herdr core licensing/release delivery, remote file/result transport, Linux vault availability, engine skill loading and Slack limits before committing the relevant milestone. None requires speculative infrastructure now.
