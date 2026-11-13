# Wheems architecture: decisions from the design round (13 November 2026)

Two independent proposals, [one from Claude](proposal-claude.md) and [one from Codex](proposal-codex.md), answered [the architecture ideas](architecture.md). These are the decisions taken from them, and the requirements added since. The rest of `docs/` has been updated to match; this page keeps the reasons.

## Agreed by both proposals, and adopted

1. **Three levels: install, workspace, project.** A project is a scoped unit inside a workspace with its own chief (optional), knowledge base, team list, Slack channel and session folders. It shares the workspace's accounts, secrets, integrations, rules and skills (narrowing allowed). **Only workspaces are confidentiality walls**; projects keep context clean, not secrets. Doctor, the README and `project new` must say so. No chief above workspaces; the cross-workspace overseer stays read-only (Later).
2. **The task is the one hand-off primitive.** A written brief to an agent in a fresh Herdr session, and a written result back, built on the existing `TaskRunner` (`src/service/runner.ts`). Delegation to a project chief, a workflow's agent step, and pairs are all tasks. Adopt Codex's robustness requirements: durable states (queued, running, waiting for approval, succeeded, failed, cancelled, outcome unknown), recovery after a service restart without relaunching, a unique identity per attempt, a short-lived task credential bound to scope and grants, and no blind retry of an uncertain external write.
3. **Lifetimes.** Chiefs: one session per Slack thread, resumable (as today). Workers, pair members, judges and workflow steps: fresh per task. Agent front matter gains `lifetime: thread | task`. Each agent session gets its own folder, which also delivers only its pinned skills.
4. **Generated project cards**, never written by agents, plus `wheems project new | list | rename | archive`. Wheems' instructions get a generated Projects section at each launch.
5. **Slack:** one app; a channel per project (`<workspace>-<project>`); approvals and updates stay one per workspace, tagged with the project.
6. **Pairs:** two independent task members, then an anonymised A/B judge with a fixed rubric; you pick (Take A, Take B, Merge, Neither). Opt-in, with daily limits and caps on rounds and time.
7. **Vault:** Keychain on macOS, secret service on Linux desktops, encrypted file for headless servers; never silently plaintext. Agents never get secret values; every use is logged.
8. **Computer use** is a tool/driver given to an existing engine (`desktop` / `ComputerDriver`), on a dedicated resettable GUI machine. Deferred to after version one.
9. **Other machines** need a small worker (`wheems node`) per machine for plan files, the CLI relay and results; `hc --on` alone isn't enough. Belongs with the always-on milestone.
10. **Deferred:** shell, HTTP and plain-LLM workflow steps; Postgres/pgvector search; read-only blueprint web views; single-use cards.

## Three decisions the proposals left open

1. **Routing: search first, ask for jobs.** The workspace chief searches its own pages, the project cards and every project with `routing: search` (the default), with results labelled by project. A project set to `routing: ask` is left out and must be sent a task. Work and live state always go to the project's chief as a task. Multi-project questions send tasks in parallel.
2. **Roadmap order: projects and tasks before the second workspace.** After M3 (approvals, unchanged and first): new M4 Projects and leads; M5 Tasks and a team (task format and runner, lifetimes, per-agent session folders, per-account `max_sessions`, developer and reviewer templates, pairs); M6 A second workspace, kept apart (was M4); then workflows and evals, data and blueprints, integrations and the vault, always on and more machines, plugins and release, renumbered. Version one's goal becomes: two workspaces every day, one with at least three projects that have leads.
3. **Purchases: "the agent prepares, you pay", or through an integration's own billing API.** No agent ever types a card number. Limits (per purchase, day, month, per agent) and a merchant allowlist are checked in code before asking; over a limit is refused, not offered. Every purchase asks every time, with no auto-approve. **An approval binds to the exact quote** (merchant, items, amount, currency, destination) and expires; any change needs a fresh approval. Unknown outcomes are reconciled, never blindly retried. A low-limit card at the bank is the backstop. Single-use cards come later.

## New requirement: evaluating tasks

The owner: "we need a way to evaluate that task in terms of whether it's doing what it needs to do." Design this into the task primitive from the start. The starting point below was refined in [architecture.md](../architecture.md#evaluating-tasks):

- **Acceptance criteria in every task.** `task.md` carries what "done" means: required sections, an output schema, and checkable criteria (for example "tests pass", "every claim has a source", "the CRM row exists").
- **Checks in code first.** The service validates the result: shape and schema, citations resolve to authorised files, no credentials, artifacts exist, and for code tasks the project's own checks run on the branch. A failed check returns the result to the agent with the reason (bounded retries), or fails the task.
- **A judge where code can't check.** For judgement criteria, a separate fresh judge task (ideally another provider) grades the result against the task's rubric and returns a score and reasons. The judge sees only the brief, the criteria and the result.
- **Human signal.** Results posted to Slack get quick feedback buttons (good, not right); pair picks and approvals count too. These are recorded with the task.
- **Recorded outcomes.** Every task keeps its brief, result, checks, judge score and feedback in its run record, so quality can be tracked per agent, task kind and engine over time.
- **Evals for regression.** Saved tasks with known-good outcomes (a golden set) re-run when an agent's instructions, skills, model or engine change, and alert when scores drop. This connects to the evals already planned for workflows.

## Addendum: business problems first, not a coding orchestrator

The owner: "I feel like you're understanding this project as just being a coding orchestrator, whereas I'm not. I'm trying to use it to solve business problems outside of coding as well. It doesn't necessarily need to be a coding project. It could be: email monitoring; email classification and then performing an action depending on the classification; responding to reviews from a certain service that's being pulled in; anything."

What it changes:

- **A project is any body of work**, not a code repository: "Customer support", "Reviews", "Sales leads", "Bookkeeping". `folder` and worktrees are optional and only for projects that have code. Examples in the docs should lead with business cases, with coding as one case among many.
- **Event triggers belong in version one.** Business automations start from events in outside systems: a new email, a new review, a new form entry, a new row. Add an integration-event trigger (polling first, webhooks where the service offers them) alongside time, channel message and file landing. This depends on integrations and the always-on server, so say how the milestones handle that (for example, the first email and reviews integrations arriving with workflows, running on the laptop until the always-on milestone).
- **Revisit the plain-LLM step.** High-volume, small judgements (classify this email, extract these fields, score this review's sentiment) don't need a full Claude Code or Codex session each; a fresh agent session per email is slow and burns subscription limits. Propose a lightweight model step (through an API-key account such as OpenRouter or Anthropic's API) for classification and extraction, with full agent tasks kept for work that needs tools and judgement. Its output must still be checked in code (an allowed label, a schema).
- **Classify, then act** is a core pattern: a classification step whose labels map to actions (reply with a template, forward, create a CRM row, open a task for a project chief, ask a person). Rules about which actions need approval live in config, enforced by the broker.
- **Evaluation for business tasks**, not just code checks:
  - classification accuracy against a labelled sample of real items (a confusion table per label), re-run when a prompt, model or label set changes;
  - **shadow mode first**: a new automation proposes actions for approval; once its approval rate over a stated number of items is high enough, the person can switch individual labels to act automatically, and sampling audits continue;
  - a judge with a rubric for written outputs (review replies: tone, accuracy, policy), and the person's edits before sending count as signal;
  - outcome measures where they exist (reply sent, ticket closed, customer answered).
- Role templates should include business roles (support, reviews, sales, bookkeeping), not only developer and reviewer.

## Reference use case: running and growing a lead-generation website

The first real use will be running websites the owner already has and turning them into lead generators, for example a directory site that connects people who need a specialist service with local providers who offer it. It's the worked example in the docs, because it exercises everything at once:

- **One workspace, several projects:** the site itself (a code repo), SEO and content, outreach to lead buyers, and the leads pipeline.
- **A weekly SEO workflow (a DAG):** pull Search Console and analytics data (integration step) → an analyst task finds opportunities against acceptance criteria → a person approves a shortlist → a developer task makes the changes on a branch → a reviewer task (or a pair) checks them → the project's checks and a preview build pass → a person approves the merge → next week's run measures the effect of last week's changes.
- **An outreach workflow:** a research task finds candidate lead buyers → a lightweight model step enriches and scores them → rows go into the CRM blueprint (data in a database, not Markdown) → drafts are written per prospect → shadow mode: each send is approved until the approval rate earns automatic sends → sends go through the email integration → replies are classified and routed (interested, not now, unsubscribe) → follow-ups are scheduled. Unsubscribes and suppression are enforced in code, and outreach must follow the relevant e-mail marketing rules (for example PECR in the UK).
- **Why a DAG:** the order, the gates and the checks are fixed in YAML; only the judgement inside each agent step varies, and every step's output is checked before the next runs. That's the determinism wanted.

[The roadmap](../roadmap.md#the-reference-use-case) says which milestone first runs each for real, as its daily-use test.

## Positioning (13 November)

The owner: "You get the best of both worlds: a front-facing agentic harness, which can create DAGs if it needs to or if you want it to, but you can also just use it as the harness itself."

It leads `docs/product.md` and the README: **a harness first, workflows when you want them.** Talking to a chief always works; nothing requires a workflow. What follows from it:

- **Hardening is a path, not a switch:** an ad-hoc request in chat → the chief notices a repeated job and offers to save it as a workflow → the workflow runs in shadow mode → steps graduate to automatic. "Creating workflows by asking" (already planned) is the bridge.
- **Both directions use the task:** a workflow step can hand work to an agent as a task, and an agent can start a saved workflow (as a tool through the broker) and wait for its result.
- **Determinism is chosen per step:** fixed steps, gates and checks where the job is known; an agent's judgement only where it's needed.

## Routines, skill procedures and workflows; learning what repeats (13 November)

The owner: not every repeated job needs a workflow. A daily morning brief can be a skill run on a schedule. And a multi-step procedure written as a skill can't be guaranteed to run the same way every time.

Three tiers, chosen per job:

| Tier                | What it is                                                                 | What's guaranteed                                                  | How it's evaluated                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Routine**         | A schedule (or event) + one agent + one skill, run as a single task        | When it runs, who runs it, what it may touch                       | Its output: acceptance criteria checked in code, a rubric judge, the person's feedback, and consistency between runs                                                                                                    |
| **Skill procedure** | A routine whose skill lists steps for the agent to follow                  | Nothing about order or completeness; only what the broker enforces | Its trace: the agent marks each step with `wheems step <name>`, and the broker records every tool and integration call, so expected steps can be checked against what happened. This detects drift; it can't prevent it |
| **Workflow (DAG)**  | Steps, order, gates and checks run by the engine; agents only inside steps | Order, approvals, checks between steps, recorded runs              | Per step and end to end, plus evals on a golden set                                                                                                                                                                     |

Rule of thumb: a single output for a person to read → a routine. Several touchpoints, outside side effects (sending, publishing, money, customers), approvals in the middle, or hand-offs between agents → a workflow. Promote a skill procedure to a workflow when its trace checks show drift, or as soon as it acts on the outside world.

**Learning what repeats.** The knowledge loop already sees every request and task. Add detection to the nightly tidy: cluster similar requests (by meaning), and when one recurs (for example three times in two weeks, or at a regular time), the chief proposes "Shall I make this a routine?" with a suggested schedule, the skill it would use (drafted as a skill proposal, which already exists), and the tier. The owner approves; it starts in shadow mode where it acts on the outside world; it graduates as its evaluation earns it. The same detector can propose promoting a routine to a workflow.
