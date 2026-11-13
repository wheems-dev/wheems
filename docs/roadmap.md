# Roadmap

Version one is done when one person runs two workspaces on it every day, one of them with at least
three projects that have leads, from Slack and Telegram, across a laptop and an always-on server,
with no hand-built setup. [The reference use case](#the-reference-use-case) is the daily-use test
along the way.

Wheems is a harness first, with workflows when you want them (see [the product](product.md)), and
it's for business work generally, not only code. The milestones follow that: talking to a chief
works from milestone 1, projects and tasks come before workflows, and workflows arrive with the
first business integrations.

The order was set in the architecture design round of 13 November 2026; the reasons are in
[ideas/decisions.md](ideas/decisions.md).

## Version one

**In**

- `init`, `setup` and `doctor`, including installing the pinned Herdr core version
- Install-level machines, connections and accounts, and the library of agent templates and skills
- Workspaces with their own chief of staff, knowledge loop, knowledge base and enforced isolation
- **Projects** inside workspaces: any body of work (customer support, reviews, sales leads, a
  website), each with an optional lead, its own knowledge base, team list and Slack channel,
  shown as a Herdr space. Projects keep context clean; only workspaces are confidentiality walls
- Generated project cards, `wheems project new | list | rename | archive`, and routing: the
  workspace chief searches first and sends jobs as tasks
- **The task**: the one hand-off between agents, with durable states, recovery after a restart,
  and **evaluation** built in: acceptance criteria, checks in code, a judge where code can't
  check, your feedback, and recorded outcomes
- Agent lifetimes (`thread` or `task`), a session folder per agent that delivers only its pinned
  skills, and session limits per account
- **Pairs**: two independent attempts at one task, compared by an anonymised judge, and you pick
- **Routines**: a schedule or an event, one agent and one skill, run as a single task, such as a
  morning brief. A skill that lists steps is checked by its trace (`wheems step` marks, and the
  broker's record of every call)
- **Learning what repeats**: the nightly tidy notices requests that recur and the chief offers to
  make them a routine, or a routine a workflow
- Driver contracts with contract tests for every driver type, and the built-in drivers listed in
  [drivers.md](drivers.md)
- Engine drivers for Claude Code, Codex and opencode, with OpenRouter and other API-key accounts
- Channel drivers for Slack, Telegram and email, with chat, approvals and updates channels
- Approvals with buttons, answered back to the waiting agent
- One session per chat thread, so conversations carry on
- The broker, as a CLI and an MCP server: rules written once and enforced through GitHub, the
  broker and git hooks, with granted integrations reached through it
- Integrations: connect and grant, the vault, GitHub, and the first business integrations (email,
  a reviews service, search analytics)
- The vault: the macOS Keychain, the Linux secret service, or an encrypted file on headless
  servers; agents never see secret values, and every use is logged
- Purchases: the agent prepares and you pay, or an integration's own billing API, with limits
  checked in code and an approval bound to the exact quote
- Skill scoping, version pinning and the skill budget warning
- Search over the knowledge base, with local embeddings and vector store drivers
- Skills proposed by agents, approved into the library
- **Workflows**: a DAG in YAML, with four triggers (a time, a channel message, a file landing, an
  event in an integration), steps (run an agent task, a lightweight model step, classify then
  act, call an integration, ask for approval, post), steps that depend on others and run in
  parallel, shadow mode, recorded runs and evals
- Creating workflows by asking the chief, and agents starting saved workflows
- The database driver (SQLite, Postgres) and blueprints, with the CRM blueprint first
- `wheems node` on other machines, and choosing the machine per agent
- Creating skills and building plugins by asking the chief of staff, with the framework skill and
  `make:` commands
- Plugins installed from npm, with manifests
- Role templates for business and code: support, reviews, sales, bookkeeping, researcher, writer,
  developer and reviewer

**Later**

- Computer use: desktop tools given to an agent, on a dedicated, resettable GUI machine (first
  after version one)
- Single-use payment cards
- Shell and HTTP workflow steps (outside calls go through integrations and the broker instead)
- Postgres with pgvector, and other hosted vector stores, for search
- Read-only web views of blueprint data, folded into the web interface
- The read-only overseer across workspaces (summaries only; no chief above workspaces)
- A Teams channel
- A web interface: a set-up screen first, then approval history
- Hard isolation through separate machines or user accounts
- Workflow branches and loops
- Voice: phone calls with an agent
- Hosted embeddings, such as OpenAI or Voyage
- More blueprints, up to a set of about five
- Several people per workspace, with roles, for businesses
- Runtimes other than Herdr

## Milestones

Milestone 0 is done. Milestones 1 and 2 are built and waiting for their tests in daily use. The
Codex and opencode engines were built early.

Each milestone ends with something used every day, and what's learned from using it shapes the
next.

| #   | Milestone                               | What it builds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Done when                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Skeleton                                | Repository, TypeScript project, CLI, config formats, driver contracts for runtime, engine and channel, the Herdr driver                                                                                                                                                                                                                                                                                                                                                                                                       | `wheems doctor` passes on a Mac, and CI is green on macOS and Linux                                                                                                                                                                                                                                  |
| 1   | Talk to one chief of staff              | `init`, a personal workspace, its chief of staff on Claude Code in Herdr, the Slack channel driver with one session per thread, the service under launchd                                                                                                                                                                                                                                                                                                                                                                     | You chat with it from Slack on your phone, and a conversation carries on across replies                                                                                                                                                                                                              |
| 2   | The knowledge loop                      | Notes, the inbox, the filer, the knowledge base, search with local embeddings and `kb reindex`, skills proposed by agents and `wheems review`, the nightly tidy                                                                                                                                                                                                                                                                                                                                                               | A day's work reaches the knowledge base without anyone doing anything, and the chief of staff finds it by meaning the next day                                                                                                                                                                       |
| 3   | Approvals and updates                   | The approvals and updates channels, buttons, the `ask` command, the first version of the broker                                                                                                                                                                                                                                                                                                                                                                                                                               | An agent waits for a tap on your phone before acting                                                                                                                                                                                                                                                 |
| 4   | Projects and leads                      | Project folders and `project.yaml`, `wheems project new`, `list`, `rename` and `archive`, a knowledge base and search index per project, generated cards, activity lines, a lead per project in its own channel, routing (search first, ask for jobs), search across projects                                                                                                                                                                                                                                                 | You ask the workspace chief about a project and get an answer with sources from that project's knowledge base, and you chat with a project's lead in its channel every day                                                                                                                           |
| 5   | Tasks and a team                        | The task format and runner (durable states, recovery, a credential per task), evaluation (acceptance criteria, checks in code, judges, feedback buttons, recorded outcomes), `lifetime`, a session folder per agent that delivers its pinned skills, `max_sessions` per account, API-key accounts (OpenRouter, Anthropic's API), researcher, writer, developer and reviewer templates, routing jobs to leads, pairs, routines with `wheems step` trace checks, and the nightly tidy proposing routines from repeated requests | A lead hands a job to a worker, the result is checked in code and by a judge from another provider, your feedback is recorded with it, a pair answers a question with a comparison you pick from, and the morning brief runs every day as a routine the chief proposed after noticing you ask for it |
| 6   | A second workspace, kept apart          | A second workspace, a Claude Code config folder per workspace, permission rules that deny other workspaces, the skill budget                                                                                                                                                                                                                                                                                                                                                                                                  | Both workspaces run side by side every day and neither can read the other                                                                                                                                                                                                                            |
| 7   | Workflows and evals                     | DAG workflows (step ids, `needs`, timeouts, checked outputs, bounded retries), integration-event triggers (polling first, webhooks where offered), the lightweight model step, classify then act, shadow mode, recorded runs, evals (golden sets, labelled samples, confusion tables), creating workflows by asking, promoting a routine to a workflow, agents starting saved workflows, the first email, reviews and search-analytics integrations, support, reviews and sales templates                                     | The weekly SEO workflow runs on its schedule for a real site, an email or review triage runs in shadow mode on real items, a workflow was created just by asking, and an eval catches a change that breaks one                                                                                       |
| 8   | Data and blueprints                     | The database driver, the blueprint format, the CRM blueprint, `blueprint add` and `make:blueprint`, adapting a blueprint by asking, a bookkeeping template                                                                                                                                                                                                                                                                                                                                                                    | The CRM is installed and given a new field just by asking, agents keep it up to date, and the outreach workflow runs end to end in shadow mode                                                                                                                                                       |
| 9   | Integrations, guardrails and the vault  | `connect` and `grant`, the vault (Keychain, secret service, encrypted file) with a log of every use, GitHub, integrations through the broker, rules applied as GitHub rulesets and git hooks, purchases with limits                                                                                                                                                                                                                                                                                                           | A release hold is one rule in config, enforced on GitHub for every engine; an agent buys a domain after one tap, and an over-limit purchase is refused without asking                                                                                                                                |
| 10  | Always on, more channels, more machines | Running on an always-on server, `setup` installing Herdr core, laptops connecting out to collect work, `wheems node` and `machine:` per agent, Telegram, email                                                                                                                                                                                                                                                                                                                                                                | Agents answer while the laptop is asleep, a worker runs on another machine, an agent answers email at its own address, and a fresh machine is set up with two commands                                                                                                                               |
| 11  | Plugins and release                     | The framework skill, `make:` commands, npm plugins with manifests, published contract tests, docs, the open-source release                                                                                                                                                                                                                                                                                                                                                                                                    | A chief of staff builds a working plugin on request, and a stranger can install Wheems from the docs alone                                                                                                                                                                                           |

Until milestone 10 the service runs on the laptop, so it only answers, and workflows only run,
while the laptop is awake. Integration events are polled when it wakes.

If version one runs long, the cheapest cut is Telegram: projects, tasks and workflows are worth
more day to day.

## The reference use case

The first real use is running websites the owner already has and growing them into lead
generators: for example, a directory site that connects people who need a specialist service with
local providers, and sells the enquiries to those providers. It's the worked example in
[architecture.md](architecture.md#worked-example-a-lead-generation-site), because it uses nearly
everything: one workspace with several projects (the site, SEO and content, outreach to lead
buyers, the leads pipeline), tasks between agents, workflows with gates, a CRM and email.

| What                                | First runs for real | How                                                                                                                                                                                                      |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Talking to the chief about the site | 1 and 2             | One workspace, one chief, notes and search; you ask in Slack                                                                                                                                             |
| Projects with leads                 | 4                   | The site, SEO and content, outreach and leads as projects, each lead in its own channel                                                                                                                  |
| The SEO cycle, run by hand          | 5                   | You ask the SEO lead; it sends tasks to an analyst, a developer and a reviewer (or a pair), each checked against its acceptance criteria                                                                 |
| The weekly SEO workflow             | 7                   | The same steps as a scheduled DAG, with the search-analytics integration, your approvals as gates, and next week's run measuring last week's changes                                                     |
| The outreach workflow               | 8                   | Research, model-step scoring, CRM rows, drafts and reply triage, in shadow mode: every send is approved. Sends become automatic only for labels that have earned it, and suppression is enforced in code |
| Running while the laptop sleeps     | 10                  | Both workflows move to the always-on server                                                                                                                                                              |

## Open questions and risks

| Question or risk             | What we know                                                                                                                                                                | What to do                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Herdr core's licence         | The Herdr desktop app is Apache 2.0. Herdr core's licence isn't confirmed                                                                                                   | Confirm it, and match it with Apache 2.0                                                                |
| Herdr's maturity             | Herdr core is young (0.1.x) and will change                                                                                                                                 | Keep every `hc` call in one module, pin a minimum version                                               |
| How Herdr publishes releases | Unknown: download links per version, an install script or Homebrew                                                                                                          | Find out before building `setup`                                                                        |
| Provider terms               | Running Claude Code and Codex on your own subscription is fine for yourself. Tasks and workflows make it far more unattended, and running them for others may need API keys | Check Anthropic's and OpenAI's terms again before milestone 5, and before offering it to others         |
| Usage limits                 | Leads, workers, judges and pairs all draw on the same subscriptions                                                                                                         | `max_sessions` per account queues work; high-volume small jobs use the model step on an API-key account |
| Cost of pairs and judges     | A pair costs a bit more than twice one task; a judge adds a session                                                                                                         | Opt in per task or agent, with daily limits and caps on rounds and time                                 |
| Herdr on other machines      | Unknown whether `hc` can carry plan files and the CLI relay over its SSH link                                                                                               | Test before planning milestone 10 in detail                                                             |
| Outreach rules               | Email marketing has rules, such as PECR in the UK                                                                                                                           | Suppression and unsubscribes enforced in code; sends start in shadow mode                               |
| Teams                        | Needs an Azure bot, a Microsoft 365 tenant, admin consent and a public address                                                                                              | Leave until after version one                                                                           |
| Codex and skills             | Codex reads skills from its own folders. That the same library works for it is unconfirmed                                                                                  | Test in milestone 5, with session folders                                                               |
| Slack's free plan            | 10 apps and 90 days of history; more channels with a lead each                                                                                                              | Fine for version one: one app, and Wheems keeps the records. Note it in the docs                        |
