# Wheems architecture: ideas and open questions

From an architecture sketch and notes, 13 November 2026. These are ideas to shape later milestones, not decisions.

## The picture

Wheems is a tree of chiefs: one top chief you can always talk to, a chief officer per project below it, and a team of agents under each chief. Every level keeps its own knowledge base, and shared services (vault, skills, workflows, search, small data apps) sit beside the tree rather than inside any one box.

| In the sketch        | What it means                                                                 | Wheems today                                        |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Wheems (top box)     | The top chief: answers anything, routes questions and jobs down               | The workspace chief of staff                        |
| KB under Wheems      | An index of the project knowledge bases, not a copy of them                   | One knowledge base per workspace                    |
| Dotted boxes         | A project: its own chief, knowledge base and team, walled off from the others | Projects inside a workspace, planned but not built  |
| Chief Officer 1 to 3 | A project's lead, reachable directly in Slack as well as through Wheems       | Not built yet                                       |
| Agents 1 to 3        | The team each user builds: marketing, Cloudflare, AWS and so on               | Agent Markdown files with engine, model and account |
| Right-hand boxes     | Services every level can use, with access granted per workspace or agent      | Drivers with contracts                              |

One thing the sketch leaves open: a workspace can hold several projects, so there may be three levels (install, workspace, project), not two. See the open questions at the end.

## Knowledge: an index of indexes

The top knowledge base should hold a short card per project, never the projects' content. Each card says where the project's knowledge base lives, what the project is, who its chief is, and what kinds of questions it can answer. Wheems reads the cards, picks the project, and asks that project's chief to search; the answer comes back up with its sources.

How a question flows:

1. You ask Wheems in Slack.
2. Wheems matches the question against the project cards (keyword and meaning search, which already exists).
3. It hands the question to that project's chief, or searches that project's knowledge base itself if it has read access.
4. The answer goes back up to Wheems with links to the pages it used, and Wheems replies.
5. A question that spans projects goes to each in turn, and Wheems combines the answers.

Registering a project should be one command, for example `wheems project new <name>`. It creates the project folder and its knowledge base, writes the project card into the top knowledge base, adds the project's chief, and updates Wheems' own instructions so it knows the project exists. Removing or renaming a project updates the card the same way, so the index never drifts.

Worth deciding: should the top level search project knowledge bases directly (fast, but it sees everything), or always ask the project's chief (slower, but respects the walls between projects)? I'd default to asking the chief, with direct search as a setting.

## Chief officers, teams and clean context

Every chief and every agent should be its own Herdr session with its own folder, instructions and memory. That is what stops context bleeding: an agent only ever sees its own session, its project's knowledge base and the skills it was given. Work moves between agents as short, written hand-offs (a task in, a result out), never as a shared conversation.

- **Talking to any chief:** each project chief gets its own Slack channel (or a thread prefix), and Wheems stays reachable everywhere. A message to a project chief can be copied up to Wheems as a one-line note, so the top level still knows what's happening.
- **Teams are the user's own:** an agent is a Markdown file (role, engine, model, account, skills, tools). Wheems should ship a few templates (marketing, research, Cloudflare, AWS) that users copy and edit.
- **Long-running agents and fresh ones:** a chief stays alive in its Herdr session; a worker can be started fresh for each task so its context starts clean, then report back and end. That choice can be a setting per agent.
- **Several agents for the same role** (two marketers) is just two agent files with the same role. Wheems can ask both and compare, which leads to pairs.

## Pairs: two minds on the same task

Make "ask two and compare" a first-class feature, not a trick. A task can be sent to a pair, for example one Claude session and one Codex session given the same brief, each working in its own folder. When both finish, a third step compares them: a short report of where they agree, where they differ, and a recommended merge, which the chief or the user picks from.

- Good uses: naming, design, plans, research, code reviews, marketing copy.
- Costs double, so it should be opt-in per task or per agent (`pair: true`), and off for routine work.
- This is exactly how the Wheems brand was made today: two design sessions, four rounds, side by side.

## Vault

Secrets should live in the device keychain (macOS Keychain, the Linux secret service), never in files, prompts or logs. Agents never see a secret's value; they ask a Wheems tool to use it ("call the Cloudflare API with the key named cloudflare-token"), and the tool injects it outside the model. Wheems already keeps secrets outside the config folders, so this extends what exists.

Cards and purchases need stricter rules than keys:

- every purchase asks the user first, in Slack, showing the item, the amount and the card's last four digits;
- spending limits per agent, per day and per merchant;
- a log of every use of every secret;
- card numbers are only ever passed to a payment page by the vault itself, never typed by an agent.

## Skills library

One library per install, with every skill the user has. Nothing is on by default: a workspace lists the skills it can use, and an agent can narrow that further. An agent then sees only the names and one-line descriptions of its own skills, and loads a skill's full text only when it needs it, so hundreds of skills cost nothing until used. Wheems already has a skills.yaml per workspace, so this is the next step from there.

## DAG engine: workflows that can't wander

A DAG workflow is a YAML file of steps and the order between them: fetch, transform, ask an agent, wait for approval, send. The engine runs the steps in order, retries failures, records every run, and never improvises. An agent can write the workflow, but the engine runs it.

The agent-step problem has a neat answer: an agent step doesn't need a raw LLM call. It can start a Herdr session with a brief and wait for it to finish, exactly like `hc run` does today, then read its result. So an agent step is a full Claude Code or Codex session with tools, on the user's own subscription. A plain LLM call can still be offered as a cheaper, faster step type for small jobs such as classifying or summarising text.

Step types to start with: shell command, HTTP call, agent session, plain LLM call, human approval (in Slack), and wait or schedule.

## RAG and storage

Search already exists: keyword and meaning search over each knowledge base, with SQLite files in `.wheems/index/`. That is the batteries-included default: zero setup, one file per workspace. Postgres with pgvector becomes a storage driver for people who want a shared server or bigger data. Both sit behind the same contract, so switching is a setting, not a rewrite.

## Headless systems

A headless system is a small data app with no screens: a CRM, a lead list, an inventory, a content calendar. The user (or an agent) writes a blueprint: the tables, the fields, and the actions allowed. Wheems turns it into a database (SQLite by default) plus tools that agents can call: add a lead, update a status, search, export. The knowledge base holds a short page that points to the system and says what it's for, never the rows themselves.

Why it matters: it replaces a paid HubSpot or Airtable subscription for small jobs, keeps data structured and queryable, and stops agents stuffing thousands of rows into Markdown. Blueprints can ship as templates (CRM, leads, content calendar), and a simple read-only web view could come later.

## Many machines and computer use

Herdr already runs terminals on other machines over SSH (`hc run --on <machine>`), so a project's team doesn't have to live on one computer. An agent's file can name its machine: the marketing team on the laptop, a scraper on a home-lab server, a heavy job on a cloud box. Wheems reaches them all through Herdr, and the vault decides which secrets each machine may use.

Computer use is the next step: an agent on an Ubuntu desktop in the home lab (or a cloud VM) that can see and click a screen, for jobs with no API. That is a new engine driver on a GUI machine, and it needs the strictest guardrails: no payments and no passwords typed by the agent, screenshots kept for review, and a human to approve anything that can't be undone.

## Open questions and a suggested order

Questions to settle first:

1. **Levels:** is it install → workspace → project (three levels), or is a project just a workspace with a parent (two levels)? This shapes everything else.
2. **Who searches:** does Wheems search project knowledge bases directly, or always ask the project's chief?
3. **Where chiefs live:** one Slack channel per project chief, or threads in one channel?
4. **Long-lived or fresh:** which agents stay alive, and which start clean for each task?

A sensible order to build in, each step useful on its own:

1. Projects inside workspaces, with `wheems project new` and the index cards.
2. Routing questions from Wheems to project chiefs, and project chiefs in Slack.
3. The skills library with per-workspace and per-agent opt-in.
4. The DAG engine, with agent steps as Herdr sessions.
5. Pairs (ask two and compare).
6. The vault for keys; cards and purchases later, with their limits.
7. Headless systems from blueprints.
8. Agents on other machines, then computer use.
