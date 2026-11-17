# The chief of staff and its team

**Status: proposal, not built.** This is how a workspace's chief of staff works with a team of
agents. The person talks only to the chief, and the chief delegates and manages the work rather
than doing it. Decided by the owner on 17 November 2026 ([ideas/decisions.md](ideas/decisions.md)).

## The idea

- **One relationship, not many.** The person talks to the chief of staff and nobody else. They
  never manage sessions, agents or leads.
- **The chief manages and never does the work.** It understands what's asked, decides who should
  do it, hands it over, follows it, checks the result and reports back. It writes no code, edits
  no files and doesn't do the research itself, not even for a quick hotfix.
- **It has a team.** The team is made of defined agents, such as a web developer, a marketer or a
  Cloudflare specialist, each on the engine and model that suits it. For one-off work it starts
  ad-hoc sessions instead.
- **The team can grow.** When the same kind of work keeps coming up, the chief proposes a new
  agent for it ("we do a lot of SEO now, so let's have an SEO agent"). The person can also build
  the team themselves in the web app.
- **Teams can be pre-built.** A starter set gives a workspace a chief and a recommended team from
  the start, such as "lead-generation site" or "online shop" ([product.md](product.md)).

## How a chief's behaviour is made today

A chief isn't a script. It's an agent session (Claude Code, Codex or opencode) running in
Herdr, and its behaviour comes from text Wheems writes into the engine's instructions file
(`CLAUDE.md` or `AGENTS.md`) in its session folder at every launch. That text has three parts:

1. **The agent file**, `workspaces/<id>/agents/chief-of-staff.md`. Its front matter sets the engine,
   model, account and permissions, and its body is the role. `wheems init` writes it from
   `chiefOfStaffMd` in `src/cli/templates.ts`. It's the person's to edit, and the web app's
   Settings page edits its front matter.
2. **Wheems's built-in instructions**, appended by `withBuiltins` in `src/agents/builtin.ts`:
   - talking to the person;
   - notes;
   - searching the knowledge base;
   - proposing skills;
   - starting and talking to sessions, with a list of its open ones.

   These teach the agent the `wheems` commands, and every agent gets them.

3. **What it knows**: `about-you.md` and the workspace's brief.

Everything around the chief is code in the service, and deterministic: routing messages,
following sessions, the session store, hand-backs and, soon, approvals. What the chief decides to
do comes from that text.

**Today's text says the opposite of the idea.** The template tells the chief to "do what you're
asked, end to end", and the sessions instructions say to "answer simple things yourself". Both
need rewriting, which is the first step below.

## The chief's role, in its instructions

Chiefs get a built-in section of their own, **Your role**, which every chief receives whatever its
agent file says. The agent file keeps the workspace's own goal and the chief's character. The
section says:

- **You manage; your team does the work.** You talk to the person, search the knowledge base,
  plan, choose who does what, follow the work, check results and report. You don't edit files,
  write code, run a project's commands or do research at length. That includes small fixes: a
  small fix is a small job for a developer.
- **Choose who does it:**
  - a defined agent on your team, when the work matches its role;
  - otherwise an ad-hoc session, with a clear purpose and what to hand back.
- **Brief well.** Say what's wanted, what done looks like, what to hand back and what not to touch.
- **Check before reporting.** Read the result, and send it back if it isn't right.
- **Decisions.** Answer your team's approval requests within your authority, and bring the person
  only what's theirs to decide ([approvals.md](approvals.md)).
- **Notice what repeats.** When you've started ad-hoc sessions for the same kind of work several
  times, propose an agent for it.

### Enforcing it, not only asking

Instructions are guidance, not a guardrail
([architecture.md](architecture.md#guardrails-that-work-with-any-engine)), so where an engine
allows it, a chief also **can't** do the work:

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

- **The chief proposes an agent** with `wheems agent create`, which is planned for milestone 5.
  It gives the name, the role, the engine, and why it's needed (for example "five ad-hoc SEO
  sessions in two weeks").
- **The person approves it** with one tap. An agent's file sets the engine, the account and the
  permissions, which means what it costs and what it can reach, so that decision is the person's
  only ([approvals.md](approvals.md)).
- **The nightly tidy notices repeats** as well. It's already planned to spot repeated requests and
  offer a routine, and it can offer an agent in the same way.
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
   and **Your team**, and remove "answer simple things yourself". This is a small change, and it
   changes behaviour at once.
2. **Approvals** ([approvals.md](approvals.md)), built for the chief only.
3. **Narrowing the chief's tools,** engine by engine, with doctor's view of it.
4. **Team, read-only, in the web app,** and sub-agents made read-only on Sessions.
5. **Creating and editing agents:** `wheems agent create`, the Team page's editing, the chief's
   proposals and starter sets. The roadmap has these in milestone 5, and they could move earlier.

## Open questions

1. **May the chief create an agent without asking?** This design says no: it proposes and the
   person taps. A looser option lets it create agents from the library's templates, on the
   workspace's own accounts, with permissions no wider than its own.
2. **How strictly is the chief kept from doing work?** The suggestion is to narrow its tools on
   Claude Code first, the engine most chiefs run on, and warn elsewhere.
3. **Gemini.** Use it through opencode for now, or write a Gemini CLI engine driver?
