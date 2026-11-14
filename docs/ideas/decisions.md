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

## Sessions: standing agents and ad-hoc sessions (14 November)

The owner: "there are the chiefs of staff, which is a static row in the table, but then there are obviously also sessions that might just be used for a one-off or an on-the-fly session. We just need a way to keep track of them, and it also helps when we've got a chief of staff who wants to talk to another session. It's able to search those sessions to get the right one." The aim is to start soon: two or three chiefs in Slack, each with two or three sessions beneath it, to see how it works.

What it changes (designed in [architecture.md](../architecture.md#sessions)):

- **A session store**, `.wheems/state.sqlite`, one per install, built first in milestone 3 (now "Sessions, approvals and updates"), replacing `conversations.json`. Herdr says whether a session is alive; the store says what it's for. Only the service writes to it.
- **Standing agents** (chiefs, later leads) are rows written by code from config. **Ad-hoc sessions** are started on the fly by a chief or a person, with an owner, title, purpose and a summary written by code, and stay open until ended.
- **Chiefs find sessions by full-text search** and talk to them with `wheems session send`. Ad-hoc sessions have no channel and no thread of their own: they work behind their chief, which tells the person what they need to know. (A first draft gave each one a Slack thread in its chief's channel; the owner changed that, below.)
- **The task stays the one hand-off.** Until milestone 5 a send is a plain message and its answer; from milestone 5 it's a task aimed at an existing session instead of a fresh one.
- **Guardrails:** search and sends stay within one workspace; limits on open sessions per owner, on depth, and per account; no two sessions waiting on each other.
- **Several chiefs means several workspaces** in one install, which the service already runs side by side. They're kept apart only from milestone 6, so the first test uses workspaces that needn't be secret from each other.
- **Each ad-hoc session runs in its own folder**, `.wheems/sessions/<workspace>/adhoc/<id>/`, because engines write the agent's instructions file into the folder a session runs in. `adhoc/` keeps ids clear of milestone 5's per-agent folders beside it. A chief owns the sessions any of its threads start, with that thread's session as their parent. `max_sessions` is set per account in `install.yaml` and counts every running session on it.

**Chiefs are the only agents people talk to, and sessions know nothing about channels.** The owner's direction, replacing the per-session Slack threads:

- Only chiefs (and later leads) have a channel. People only ever chat to a chief. Ad-hoc sessions never post to any channel: they work behind their chief, and the chief passes on what the person needs to know. The person can still watch any session in Herdr (`hc attach`) or with `wheems session show`. Why: one point of contact keeps the person's chat simple, and the chief is the agent that knows the person and the workspace, so it is the right one to decide what's worth telling them.
- Comms stay channel-agnostic. Slack is the first of many channels (Telegram, email, Teams and more), so channels are drivers, like Laravel's mail drivers: sessions, sends and answers live in the core and know nothing about Slack. Anything a person sees goes through the chief's conversation and the `ChannelDriver` contract, never a channel-specific path, and no channel's names, ids or wording appear in the sessions code or the store. Why: a per-session thread would have tied the session layer to Slack's threads, and every new channel would have needed its own version of it.
- An answer to a send without `--wait` is typed into the sender's session; a chief's thread session then answers in its own conversation, on whatever channel that is.

## Onboarding: use the terminal once, then everything else in chat (14 November)

The owner: "we need to make this easy to onboard." He invited the app to a Slack channel and nothing happened, because no workspace used that channel and Wheems dropped its messages without a word.

- **Inviting the app to a channel is the whole setup of another chief.** Wheems offers a chief of staff there, to allowed users only and once per channel, and creates the workspace from the name given, answering at once with no restart. A workspace whose configured channel the app couldn't see is picked up as soon as the app is invited there.
- **The terminal is for the first setup only.** One `wheems setup`, then everything else in chat. This is a milestone 3 goal: a new user goes from `npm install` to talking to two chiefs in two channels with one `wheems setup`, and adds the second just by inviting the app.
- **It stays channel-agnostic.** The flow lives in the core. A driver only reports the app being added to a channel (an optional `joins` capability) and passes on messages from channels no workspace uses, so Telegram, email or Teams get onboarding by implementing the same two things.

## Commands by area, like `php artisan` (14 November)

The owner, looking at all the `wheems` commands: restructure them "to be a little more domain driven... like laravels php artisan commands", for example `wheems ws create` and `wheems ws remove`. The flat set had grown inconsistent: `init` against `session new`, the service commands twice over, a top-level `slack` named after one channel, and no way to list workspaces, channels or engines.

- **`wheems <area> <action>`, with spaces**, and one set of verbs (list, show, create, rename, archive, restore, remove, start, stop, restart), plus a few verbs of an area's own. Written up in [cli.md](../cli.md).
- **Archive and remove are different.** `ws archive` unbinds a workspace and moves it to an archive, keeping everything. `ws remove` deletes it: the workspace, its knowledge base, its state and its records.
- **The agents' commands move too** (`chat reply`, `kb note`), in a second step, with the old names kept for a release.
- **The top level stays small**, kept by a test: setup, doctor, list, review and the service shortcuts.
