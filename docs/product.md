# Opinr: the product

Opinr is an open-source, opinionated framework for running teams of AI agents, with
Herdr core (`hc`) as the runtime. The name means "one who opines", and
its dropped vowel pairs it with Herdr.

You install it once, create a workspace per business or area of life, and talk to each
workspace's chief of staff from Slack or Telegram. Each workspace has its own agents, skills,
workflows, rules and knowledge base, and none of them can see another workspace.

## The problem it solves

People don't know what to set up, or what fits. Existing agent harnesses leave those choices
open and assume one instance per business. That suits one company, but not someone with a
personal life, a business and several side projects. Opinr makes the choices for them, with
a clear place for everything, the way Laravel does for web apps.

## Who it's for

People who already use Claude Code or Codex and want agents working for them across several
areas at once: developers first, then small businesses.

|                 | Typical agent harnesses                  | Opinr                                                                                   |
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
a body of work inside one. Make something a separate workspace when it has different people,
should keep its knowledge private, or may be handed to someone else one day.

## The opinions

Opinr decides these so users don't have to. Each can be renamed or tuned, but not removed.

**Built in, in every workspace**

- A chief of staff: the one entry point, aware of every project and agent in its workspace.
- The knowledge loop and its knowledge base.
- A chat channel with the chief of staff, plus an `approvals` channel and an `updates` channel.
- Built-in skills every agent gets: post to a channel, ask for approval, write a note, read
  the knowledge base. This is how agents learn to use the framework.

**Optional, switched on from templates.** Roles such as reviewer, developer, servers
engineer, DNS specialist, site lead and marketer, plus custom agents written in the same
format. A workspace starts with the chief of staff alone and adds roles when needed. Starter
sets, such as "software business" or "content site", give a recommended team.

**The knowledge loop is the only way in**

- Every session ends with a note. This is built in, not a skill someone has to remember.
- Notes land in the workspace's inbox. Sessions never edit the knowledge base directly.
- A built-in filing job turns each note into knowledge-base pages and work-tracker entries,
  and keeps the note as the source. Users never see it as an agent.
- The chief of staff reads the knowledge base to answer questions and brief agents.

**Skills are scoped**

- The library holds every skill but is never loaded into an agent. A workspace picks its set
  from it, and each agent picks from the workspace's set.
- The library sits where Claude Code doesn't look, and the global `~/.claude/skills` is left
  empty or ignored, so nothing leaks into every workspace.
- Each workspace pins the version of each skill. Library edits never silently change a live
  workspace.
- `opinr doctor` warns when a workspace or agent goes past a budget, around 15 to 20 skills.
- Outside skills go into the library first, never straight into a workspace.

**Workflows: a fixed outline, with agents doing the steps.** An agent is who does the work,
a skill is how to do a task, and a workflow is what happens when: a trigger, then steps. The
sequence is a readable file, so it runs the same way every time and can be checked afterwards.
Each step can be fully agentic. Schedules are simply workflows triggered by a time. To create
one, you ask the chief of staff. It writes the file, explains it in plain English, and saves
it once you approve.

```yaml
# workflows/morning-brief.yaml
trigger: { schedule: '0 7 * * 1-5' }
steps:
  - agent: chief-of-staff
    task: Summarise yesterday's notes, open work and anything waiting on me.
  - post: { channel: briefs }
```

**Isolation, stated per workspace**

| Level              | How                                                                                                                                       | When                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Enforced (default) | Its own folder, its own Claude Code config folder, permission rules that deny other workspaces, its own secrets, its own provider account | Your own projects                           |
| Hard               | A separate machine, VM or user account                                                                                                    | Client data, or installs at another company |

Isolation by instructions alone isn't offered. On one machine every agent runs as the same
user with shell access, so instructions don't enforce anything.

**The overseer sees summaries, not knowledge bases.** Each workspace publishes a short
status: its work-tracker summary and what's waiting on you. A read-only overseer reads only
those, which is all a morning brief across workspaces needs.

**Agents run where they're reached.** Agents run on always-on machines by default. Machines
that can't be reached from outside, like a laptop, connect out to the hub and collect their
work. The hub never connects in to them.
