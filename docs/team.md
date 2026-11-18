# The chief of staff and its team

**Status: steps 1 and 1a built** (the chief's role and its team in its instructions, in 0.1.9;
finish lines, evidence and the send-back limit, in 0.1.10);
**the rest is a proposal.** This is how a workspace's chief of staff works with a team of
agents. The person talks only to the chief, and the chief delegates and manages the work rather
than doing it. Decided by the owner on 17 November 2026 ([ideas/decisions.md](ideas/decisions.md)).

## The idea

- **One relationship, not many.** The person talks to the chief of staff and nobody else. They
  never manage sessions, agents or leads.
- **The chief manages and never does the work.** It understands what's asked, decides who should
  do it, hands it over, follows it, checks the result and reports back. It reads and answers, but
  writes no code, edits no files and does no long research itself, not even for a quick hotfix.
- **It has a team.** The team is made of defined agents, such as a web developer, a marketer or a
  Cloudflare specialist, each on the engine and model that suits it. For one-off work it starts
  ad-hoc sessions instead.
- **The team can grow.** When the same kind of work keeps coming up, the chief creates a new
  agent for it, without asking ("we do a lot of SEO now, so let's have an SEO agent"). The person can also build
  the team themselves in the web app.
- **Teams can be pre-built.** A starter set gives a workspace a chief and a recommended team from
  the start, such as "lead-generation site" or "online shop" ([product.md](product.md)).

## How a chief's behaviour is made today

A chief isn't a script. It's an agent session (Claude Code, Codex or opencode) running in
Herdr, and its behaviour comes from text Wheems writes into `AGENTS.md` (which `CLAUDE.md`
points to) in its session folder at every launch ([instructions.md](instructions.md)). That text
has three parts:

1. **`WHEEMS.md`** in the workspace's folder, and **`GOAL.md`** beside it. `WHEEMS.md`'s front
   matter sets the engine, model, account and permissions, and its body is who the chief is.
   `wheems init` writes both from `wheemsMd` and `goalMd` in `src/cli/templates.ts`. They're the
   person's to edit, and the web app's Settings page edits `WHEEMS.md`'s front matter.
2. **Wheems's built-in instructions**, appended by `withBuiltins` in `src/agents/builtin.ts`:
   talking to the person, the chief's role and team, its open sessions, and a short map of
   Wheems's skills (`wheems-sessions`, `wheems-knowledge`, `wheems-notes`,
   `wheems-skill-proposals`, and `wheems-herdr` from Herdr's own manual). The skills, written beside it at every start by `builtinSkills`,
   teach the `wheems` commands, and are loaded only when they're needed.

3. **What it knows**: `about-you.md` and the workspace's brief.

Everything around the chief is code in the service, and deterministic: routing messages,
following sessions, the session store, hand-backs and approvals. What the chief decides to
do comes from that text.

**Today's text says the opposite of the idea.** The template tells the chief to "do what you're
asked, end to end", and the sessions instructions say to "answer simple things yourself". Both
need rewriting, which is the first step below.

## The chief's role, in its instructions

Chiefs get a built-in section of their own, **Your role**, which every chief receives whatever its
agent file says. The agent file keeps the workspace's own goal and the chief's character. The
section says:

- **You manage; your team does the work.** See [What counts as work](#what-counts-as-work).
  That includes small fixes: a small fix is a small job for a developer.
- **Choose who does it:**
  - a defined agent on your team, when the work matches its role;
  - otherwise an ad-hoc session, with a clear purpose and what to hand back.
- **Brief with a finish line.** The purpose says what's wanted, what to hand back and what not to
  touch. `--done-when` says what must be true when it's finished, in things that can be checked.
  Wheems refuses a chief's session without one.
- **Check the evidence, not the claim.** Workers hand back what they ran and what it showed,
  links, files and commits. Each answer comes back with the finish line and a count.
- **Send back at most twice.** Say what was expected, what came instead and what's been tried. If
  it still isn't done, or comes back the same, bring it to the person. From the third answer,
  Wheems's hand-back says so too.
- **Decisions.** Answer your team's approval requests within your authority, and bring the person
  only what's theirs to decide ([approvals.md](approvals.md)). A section of its own, **Decisions**,
  lists the five kinds that are the person's, less any `approvals.chief_decides` leaves to it.
- **Notice what repeats.** When you've started ad-hoc sessions for the same kind of work several
  times, create an agent for it.

### What counts as work

The line is simple, so the chief can apply it and Wheems can enforce it: **the chief reads and
answers; its team makes and changes things.**

| The chief does it                                                                                  | The team does it                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Talking with the person, answering questions                                                       | Anything that creates or changes files, code, sites, data or settings                |
| Reading what it's given or can reach: an email, a document, a page, a result                       | Development of any size, including a one-line fix                                    |
| Quick lookups: the knowledge base, a session's answer, one web page                                | Research beyond a quick lookup, and anything that takes more than a few minutes      |
| Planning, choosing who does what, briefing, checking results, deciding what to bring to the person | Acting in the outside world: sending, publishing, deploying, buying (with approvals) |
| Its own notes, through `wheems knowledgebase note`                                                 | Writing anything longer than a reply: reports, articles, drafts to send              |

"Look at this email and tell me what you think" is the chief's. "Reply to it" is a job for an
agent. When in doubt, it delegates.

### Enforcing it, not only asking

Strictly. Instructions are guidance, not a guardrail
([architecture.md](architecture.md#guardrails-that-work-with-any-engine)), so a chief also
**can't** do the work. In effect it's **read-only, plus `wheems`**:

- **The chief's session gets no project folders.** It starts in its own session folder, and only
  the agents doing the work are given a project's folder.
- **Its tools are narrowed** where the engine supports it:
  - **Claude Code:** permission rules that deny editing files, and allow shell commands only for
    `wheems` and reading.
  - **Codex and opencode:** their own permission and sandbox settings.

  This needs checking per engine. The chief must still reach Wheems's socket, and must still be
  able to write its notes through `wheems knowledgebase note`.

- **Doctor shows it per engine.** Where the rule only rests on the instructions, doctor shows a
  warning.

This would be a new setting, such as `role: chief` in the agent file, applied by each engine
driver. It's only allowed on the workspace's chief.

## The team

**Defined agents already exist.** Any file in `workspaces/<id>/agents/` is one, in the same format
as the chief: a description, engine, model, account, permissions, skills and a role.
`wheems session create <agent> …` already starts one by name. So a team is mostly a matter of:

- telling the chief who's on it;
- giving each agent a good description;
- making them easy to create.

**Each agent picks its own engine.** Claude Code, Codex and opencode are built in. Gemini can be
used today through opencode with a Gemini model. A Gemini CLI engine would be a new driver
behind the existing engine contract, the same size of job as the opencode one.

**The chief is told its team.** Its built-ins gain a generated **Your team** section, written from
the agent files at each launch: each agent's name, its description ("use when…") and its engine.
Each agent's description becomes the routing rule, so it should say when to use the agent, as a
skill's description does.

**Delegating.** Today the chief uses `wheems session create <agent>`. From milestone 5 it hands
over work as a [task](architecture.md#tasks), with acceptance criteria and a checked result.

**Projects (milestone 4).** A project may have a lead, but the lead is part of the team: an agent
the chief delegates to, with no channel of its own. The person asks the chief about the
storefront, and the chief asks the storefront's lead. A project's team list says which agents
work on it.

## Growing the team

**The chief creates agents itself, without asking** (decided 17 November). Making it easy is the
point. With `wheems agent create`, it gives the name, the role (the agent's instructions), a
description saying when to use it, and the engine and model. Wheems writes the agent file,
validates it, commits it, and from then on lists the agent in **Your team**.

The limits are in code, not in asking:

- **No new spending or reach.** It can only use accounts and integrations the workspace already
  has, and skills from the workspace's `skills.yaml`.
- **No wider permissions** than `auto`: never `skip`.
- **No changes to the chief itself.** Its own agent file, the workspace's settings and the rules
  are the person's.
- **A cap**, such as twelve agents per workspace, so a confused chief can't multiply them.

**The person is told, not asked.** One line in the thread, "I've added an SEO agent to the team",
and the agent shows on the Team page as made by the chief. The person can edit or remove it there.
The chief may also edit or retire agents it made. The person's own agents are the person's.

- **The nightly tidy notices repeats** as well, as it's already planned to for routines, and
  suggests to the chief that it create an agent.
- **Starter sets** are workspace templates that ship a chief and a team, chosen at `wheems setup`
  or when a chief is set up by inviting the app to a channel.

## The web app: Team

A new **Team** page shows each workspace's team as a tree: the chief at the top, and its agents
beneath it, grouped by project once projects arrive. Each agent shows its role, engine, model,
account, permissions and skills, and what it's working on now.

From the page the person can:

- **create an agent,** from a template or from scratch;
- **edit an agent,** including its engine. That's the same editing as the chief's Settings, with
  the same handover choices when one of its sessions is open;
- **remove an agent;**
- **choose which agents a project uses.**

Every change writes the agent's file and is validated and committed, as the Settings page does
now. The chief sees the new team at its next launch.

**Sessions become read-only for sub-agents.** The Sessions page keeps showing every session, so
the person can see what the team is doing. Sending a message to a sub-agent goes, and **End**
stays as an emergency stop. To change what a sub-agent is doing, the person tells the chief.
`wheems session send` stays in the terminal for debugging.

## In order

1. **The chief's role and its team in its instructions.** Rewrite the template, add **Your role**
   and **Your team**, and remove "answer simple things yourself". Built: `CHIEF_ROLE`,
   `teamInstructions` and `workerInstructions` in `src/agents/builtin.ts`, and `src/agents/team.ts`.
   1a. **Finish lines and evidence,** so delegated work can be checked. A session has a
   `--done-when` line, which a chief must give. Workers hand back evidence, not "should work".
   Answers, handed back or waited for, show the finish line and a count, and the chief sends a
   job back at most twice before bringing it to the person. Built: the `done_when` column
   (schema 6), and `finishLine` in
   `src/service/sessions.ts`. The limit is an instruction, not a block, because a chief may also
   send a session follow-up work. If chiefs ignore it, Wheems could count send-backs per job.
2. **Approvals** ([approvals.md](approvals.md)), built for the chief only. Built:
   `src/service/approvals.ts`, the `approvals` table (schema 7), the `approval` commands, Slack's
   buttons, the chief's **Decisions** section and the `wheems-approvals` skill.
3. **Narrowing the chief's tools,** engine by engine, starting with Claude Code, with doctor's
   view of it.
4. **Team, read-only, in the web app,** and sub-agents made read-only on Sessions.
5. **Creating and editing agents:** `wheems agent create` for the chief and the person, the Team
   page's editing, and starter sets. The roadmap has these in milestone 5, and they could move earlier.

## Open questions

Answered on 17 November:

- **The chief creates agents without asking,** within the limits above.
- **It's kept strictly from doing work:** it reads and answers, and its tools are narrowed to
  match, starting with Claude Code.
- **Gemini isn't needed now.** Any agent can use a Gemini model through opencode if wanted.

Still open:

1. **The agent cap.** Twelve per workspace is a guess. It should be set by how many agents a chief
   can still choose between well.
