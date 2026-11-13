# Wheems: the product

Wheems is an open-source, opinionated framework for running teams of AI agents, with
Herdr core (`hc`) as the runtime.

**A harness first, workflows when you want them.** You get a front-facing agent harness you can
simply talk to, and it can build fixed workflows (DAGs) when a job needs them or you ask for one.
Talking to a chief always works; nothing requires a workflow.

- **Hardening is a path, not a switch.** You ask for something in chat. When the chief notices a
  job repeating, it offers to save it as a routine or a workflow. That runs in shadow mode,
  proposing each outside action for your approval, and its steps graduate to acting on their own
  as their results earn it.
- **Both directions use the task.** A workflow step hands work to an agent as a task, and an agent
  can start a saved workflow and wait for its result.
- **Determinism is chosen per step:** fixed steps, gates and checks where the job is known, and an
  agent's judgement only where it's needed.

**It's for business work, not only code.** Watching an inbox and acting on each email, replying to
reviews pulled in from a reviews service, finding and following up sales leads, bookkeeping,
growing a website: coding is one case among many.

You install it once, create a workspace per business or area of life, and talk to each
workspace's chief of staff from Slack or Telegram. Each workspace has its own agents, projects,
skills, routines, workflows, rules and knowledge base, and none of them can see another workspace.

## The problem it solves

People don't know what to set up, or what fits. Existing agent harnesses leave those choices
open and assume one instance per business. That suits one company, but not someone with a
personal life, a business and several side projects. Wheems makes the choices for them, with
a clear place for everything, the way Laravel does for web apps.

## Who it's for

People who already use Claude Code or Codex and want agents working for them across several
areas at once: developers first, then small businesses.

Version one is built for one person's daily use and released as open source. The longer aim is
for businesses to adopt it as their way of working with agents. That brings several people per
workspace with their own roles, an audit trail, cost tracking and provider API keys, so the
contracts are designed to allow them later.

|                 | Typical agent harnesses                  | Wheems                                                                                  |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| The agent       | Their own agent loop calling a model     | Claude Code, Codex and opencode, unchanged, each in its own terminal                    |
| Improvements    | Come from the harness's own releases     | Every Claude Code or Codex update reaches every agent                                   |
| Seeing the work | Logs and chat replies                    | Every agent is live in Herdr, where you can step in                                     |
| Scope           | One instance per business, with profiles | One install, many isolated workspaces                                                   |
| Set-up          | Many choices left open                   | One way to do each thing                                                                |
| Cross-checking  | One provider                             | Agents from different providers check each other, such as Codex reviewing Claude's work |

The bet is that Herdr is a strong engine, and that the missing piece is a well-designed layer
that coordinates it.

## The building blocks

One **install** per person holds the shared parts: machines, connections, accounts, and a
library of agent templates, skills and workflow templates.

Each business or area of life is a **workspace** inside the install, cut off from the others.
A workspace is an entity with its own people, knowledge and confidentiality. A **project** is
any body of work inside one, such as "Customer support", "Reviews", "Sales leads" or a website,
with an optional lead you can talk to in its own channel and a knowledge base of its own.
Projects keep context clean; they aren't walls, because only workspaces are. Make something a
separate workspace when it has different people, should keep its knowledge private, or may be
handed to someone else one day.

How the pieces work, and which are built, is in [architecture.md](architecture.md).

## The opinions

Wheems decides these so users don't have to. Each can be renamed or tuned, but not removed.

**Built in, in every workspace**

- A chief of staff: the one entry point, aware of every project and agent in its workspace.
- The knowledge loop and its knowledge base.
- A chat channel with the chief of staff, plus an `approvals` channel and an `updates` channel.
- Built-in skills every agent gets: post to a channel, ask for approval, write a note, read
  the knowledge base. This is how agents learn to use the framework.

**Optional, switched on from templates.** Business roles such as support, reviews, sales,
bookkeeping, researcher, writer and marketer, and code roles such as developer and reviewer,
plus custom agents written in the same format. A workspace starts with the chief of staff alone
and adds roles when needed. Starter sets, such as "lead-generation site", "online shop" or
"software business", give a recommended team.

**The knowledge loop is the only way in**

- Every session ends with a note. This is built in, not a skill someone has to remember.
- Notes land in the workspace's inbox. Sessions never edit the knowledge base directly.
- A built-in filing job turns each note into knowledge-base pages and work-tracker entries,
  and keeps the note as the source. Users never see it as an agent.
- The chief of staff reads the knowledge base to answer questions and brief agents.
- The knowledge base is searched by meaning as well as by words. Turning text into
  embeddings and storing them are both drivers, the way Laravel's storage has disks: local by
  default, free and private, with hosted services as other drivers. `wheems kb reindex` rebuilds
  the index.
- Agents improve themselves the same way. An agent that learns how to do something proposes a
  skill. The proposal goes to the library and waits for approval, like any outside skill.

**Skills are scoped**

- The library holds every skill but is never loaded into an agent. A workspace picks its set
  from it, and each agent picks from the workspace's set.
- The library sits where Claude Code doesn't look, and the global `~/.claude/skills` is left
  empty or ignored, so nothing leaks into every workspace.
- Each workspace pins the version of each skill. Library edits never silently change a live
  workspace.
- `wheems doctor` warns when a workspace or agent goes past a budget, around 15 to 20 skills.
- Outside skills go into the library first, never straight into a workspace.

**Three tiers for a job that repeats, chosen per job.** An agent is who does the work, a skill
is how to do a task, and the tier is how firmly it's held:

- a **routine** is a trigger, one agent and one skill, run as a single task, such as a morning
  brief: you know when it runs, who runs it and what it may touch;
- a **skill procedure** is a routine whose skill lists steps; the steps the agent marks and the
  calls it makes are checked afterwards, which detects drift but can't prevent it;
- a **workflow** is a fixed outline in a readable file (a DAG), with agents doing the steps: the
  order, the approvals and the checks between steps never vary, and only the judgement inside a
  step does.

A single output for you to read is a routine. Several touchpoints, anything sent, published or
paid for, approvals in the middle, or hand-offs between agents make a workflow. Triggers include
a time, a message and an event in an outside service, such as a new email or a new review. A
**classify, then act** step sorts each item with a small, fast model and maps each label to an
action. To create a routine or a workflow, you ask the chief of staff, or it offers when it
notices a request coming back. It writes the file, explains it in plain English, and saves it
once you approve.

```yaml
# workflows/support-inbox.yaml (planned format)
trigger: { integration: { name: support-email, event: message.received } }
steps:
  - id: sort
    classify: { labels: [refund, how-to, complaint, spam] }
  - id: act
    needs: [sort]
    on:
      how-to: { task: { agent: support, skill: how-to-reply }, mode: shadow }
      complaint: { ask: { channel: approvals } }
      spam: { call: { integration: support-email, action: archive }, mode: auto }
```

**Every task is evaluated.** Each hand-off says what "done" means. Wheems checks what code can
(the shape, allowed labels, sources, that the CRM row exists, the tests), a judge from another
provider grades what code can't (tone, accuracy, policy), and your feedback, edits and approvals
are recorded with it. Anything new that acts on the outside world starts in **shadow mode**,
proposing each action for your approval, until its approval rate earns acting alone. **Evals**
re-run saved cases with known-good outcomes whenever an agent, skill, model or prompt changes, and
say when quality drops.

**Blueprints: headless apps an agent can adapt.** A blueprint is a small app with no screens,
such as a CRM: tables in the workspace's database, tools that let agents use them, and skills
that explain the data. `wheems blueprint add crm` installs one into a workspace. The database is
a driver, SQLite by default and Postgres for larger installs. Wheems ships a handful of
blueprints, the CRM first. A blueprint is defined in code with a documented shape, so the chief
of staff can adapt one (add a field, a table or a tool) or build a new one with
`wheems make:blueprint`, and the change is applied once you approve it. Like skills, each
workspace pins the blueprint versions it uses.

**Isolation, stated per workspace**

| Level              | How                                                                                                                                       | When                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Enforced (default) | Its own folder, its own Claude Code config folder, permission rules that deny other workspaces, its own secrets, its own provider account | Your own work                               |
| Hard               | A separate machine, VM or user account                                                                                                    | Client data, or installs at another company |

Projects inside a workspace aren't walls: they keep context clean, and only workspaces keep
secrets apart.

Isolation by instructions alone isn't offered. On one machine every agent runs as the same
user with shell access, so instructions don't enforce anything.

**One page about you crosses workspaces.** `about-you.md`, at the top of the install, holds
your preferences and how you like to work. Every agent in every workspace reads it, and none can
change it: the filing job suggests changes and you approve them with `wheems review`.

**The overseer sees summaries, not knowledge bases.** Each workspace publishes a short
status: its work-tracker summary and what's waiting on you. A read-only overseer reads only
those, which is all a morning brief across workspaces needs.

**Agents run where they're reached.** Agents run on always-on machines by default. Machines
that can't be reached from outside, like a laptop, connect out to the hub and collect their
work. The hub never connects in to them.
