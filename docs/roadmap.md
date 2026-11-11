# Roadmap

Version one is done when one person runs two workspaces on it every day, from Slack and
Telegram, across a laptop and an always-on server, with no hand-built setup.

## Version one

**In**

- `init`, `setup` and `doctor`, including installing the pinned Herdr core version
- Install-level machines, connections and accounts, and the library of agent templates and skills
- Workspaces with their own chief of staff, knowledge loop, knowledge base and enforced isolation
- Projects inside workspaces, each shown as a Herdr space
- Driver contracts with contract tests for every driver type, and the built-in drivers listed in
  [drivers.md](drivers.md)
- Engine drivers for Claude Code, Codex and opencode, with OpenRouter as an account
- Channel drivers for Slack and Telegram, with chat, approvals and updates channels
- Integrations: connect and grant, the secret store, and GitHub as the first integration
- Approvals with buttons, answered back to the waiting agent
- One session per chat thread, so conversations carry on
- The broker, as a CLI and an MCP server: rules written once and enforced through GitHub, the
  broker and git hooks, with granted integrations reached through it
- Skill scoping, version pinning and the skill budget warning
- Workflows with three triggers (a time, a channel message, a file landing) and three steps (run
  an agent, ask for approval, post to a channel)
- Creating workflows, adding skills and building plugins by asking the chief of staff, with the
  framework skill and `make:` commands
- Plugins installed from npm, with manifests
- At least two role templates, reviewer and developer

**Later**

- The read-only overseer
- A Teams channel
- A web interface: a set-up screen first, then approval history
- Hard isolation through separate machines or user accounts
- Workflow branches, loops and parallel steps
- Runtimes other than Herdr

## Milestones

Milestone 0 is done. Milestone 1 is built and being tried out day to day.

Each milestone ends with something used every day, and what's learned from using it shapes the
next.

| #   | Milestone                        | What it builds                                                                                                                                            | Done when                                                                                                 |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 0   | Skeleton                         | Repository, TypeScript project, CLI, config formats, driver contracts for runtime, engine and channel, the Herdr driver                                   | `opinr doctor` passes on a Mac, and CI is green on macOS and Linux                                        |
| 1   | Talk to one chief of staff       | `init`, a personal workspace, its chief of staff on Claude Code in Herdr, the Slack channel driver with one session per thread, the service under launchd | You chat with it from Slack on your phone, and a conversation carries on across replies                   |
| 2   | The knowledge loop               | Notes at session end, the inbox, the filing job, the knowledge base, built-in skills for posting and writing notes                                        | A day's work reaches the knowledge base without anyone doing anything                                     |
| 3   | Approvals and updates            | The approvals and updates channels, buttons, the `ask` command, the first version of the broker                                                           | An agent waits for a tap on your phone before acting                                                      |
| 4   | A second workspace, kept apart   | A second workspace with projects, a Claude Code config folder per workspace, permission rules, the skill library with scoping and pinning                 | Both workspaces run side by side and neither can read the other                                           |
| 5   | A team of agents on more engines | Agent templates (developer and reviewer), the Codex and opencode engines, and accounts, including OpenRouter                                              | A Claude Code developer's work is reviewed by a Codex reviewer inside Opinr                               |
| 6   | Workflows                        | Triggers and steps, a morning-brief workflow, and creating workflows by asking                                                                            | The morning brief runs as a workflow, and a second one was created just by asking                         |
| 7   | Integrations and guardrails      | `connect` and `grant`, the secret store, GitHub, integrations through the broker, rules applied as GitHub rulesets and git hooks                          | A release hold is one rule in config, enforced on GitHub for every engine                                 |
| 8   | Always on, more channels         | Running on an always-on server, `setup` installing Herdr core, laptops connecting out to collect work, Telegram                                           | Agents answer while the laptop is asleep, and a fresh machine is set up with two commands                 |
| 9   | Plugins and release              | The framework skill, `make:` commands, npm plugins with manifests, published contract tests, docs, the open-source release                                | A chief of staff builds a working plugin on request, and a stranger can install Opinr from the docs alone |

Until milestone 8 the service runs on the laptop, so it only answers while the laptop is awake.

## Open questions and risks

| Question or risk             | What we know                                                                                                                      | What to do                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Herdr core's licence         | The Herdr desktop app is Apache 2.0. Herdr core's licence isn't confirmed                                                         | Confirm it, and match it with Apache 2.0                          |
| Herdr's maturity             | Herdr core is young (0.1.x) and will change                                                                                       | Keep every `hc` call in one module, pin a minimum version         |
| How Herdr publishes releases | Unknown: download links per version, an install script or Homebrew                                                                | Find out before building `setup`                                  |
| Provider terms               | Running Claude Code and Codex on your own subscription is fine for yourself. Running them unattended for others may need API keys | Check Anthropic's and OpenAI's terms before offering it to others |
| Usage limits                 | Several workspaces on one subscription will hit rate limits                                                                       | Each workspace can use its own account or API key                 |
| Teams                        | Needs an Azure bot, a Microsoft 365 tenant, admin consent and a public address                                                    | Leave until after version one                                     |
| Codex and skills             | Codex reads skills from its own folders. That the same library works for it is unconfirmed                                        | Test early                                                        |
| Slack's free plan            | 10 apps and 90 days of history                                                                                                    | Fine for version one. Note it in the docs                         |
