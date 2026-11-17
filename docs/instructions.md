# What a session loads

**Status: built, in 0.1.11.** This is how a Wheems agent session gets its instructions: which files
you write, which Wheems writes, and which of Wheems's own behaviours are loaded every time and
which only when they're needed. Decided by the owner on 17 November 2026
([ideas/decisions.md](ideas/decisions.md)).

## In a workspace's folder

Two files are yours to write, and Wheems writes the other two:

| File        | Who writes it          | What's in it                                                                                                                        |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WHEEMS.md` | you                    | The chief of staff: its settings in front matter (engine, model, account, permissions) and who it is, in your words.                |
| `GOAL.md`   | you                    | What this workspace is working towards. Every session in it reads this, the chief's and its team's.                                 |
| `AGENTS.md` | Wheems, at every start | Everything the session needs, in one file: your files, Wheems's rules, the team, what it knows. Edits here are replaced.            |
| `CLAUDE.md` | Wheems                 | Just `@AGENTS.md`, which Claude Code follows. Codex and opencode read `AGENTS.md` themselves, so every engine reads the same thing. |

Team agents stay in `agents/<name>.md`, so `agents/` is the team. `WHEEMS.md` replaces
`agents/chief-of-staff.md`. The chief keeps its name (`chief_of_staff` in `workspace.yaml`,
`chief-of-staff` by default), so its sessions and records don't change.

`AGENTS.md` has to hold everything rather than point at your files, because Codex and opencode
can't follow a pointer. Claude Code can, which is why `CLAUDE.md` is one line.

An ad-hoc session gets the same two files in its own folder,
`.wheems/sessions/<workspace>/adhoc/<id>/`. Its `AGENTS.md` has `GOAL.md`, but not `WHEEMS.md`,
which describes the chief: a worker that read it would think it was the chief. An agent from the
team gets its own `agents/<name>.md` instead; an unnamed session gets a short built-in "member of
the team" role.

### Moving over

When the service starts, each workspace that still has `agents/<chief>.md` and no `WHEEMS.md`
is moved over: the file becomes `WHEEMS.md`, and a "What we're working towards" section in it, if
there is one, moves to `GOAL.md`. If the workspace already has a `GOAL.md`, the section stays in
`WHEEMS.md` for you to move. The goal is saved before the old file is removed, so nothing is lost
if a step fails. A workspace without `GOAL.md` gets an empty one to fill in.
The install's `.gitignore` gets the generated files. Until the service has started, the CLI reads
`agents/<chief>.md` where `WHEEMS.md` is missing, and doctor says so.

## What's always loaded, and what's a skill

Until 0.1.11 every built-in behaviour was written out in full in every session's instructions:
about 2,800 tokens for a chief and 2,200 for a worker, most of it how to use `wheems` commands,
which is needed only now and then. So Wheems's behaviours are split in two, which brings a chief
to about 1,700 tokens and a worker to about 1,050, before your own files:

- **Rules, always in `AGENTS.md`.** What must apply on every turn, whether or not the agent
  thinks of it: the chief's role (manage, never do the work), how to talk to the person, a
  worker's job with its finish line and the evidence to hand back, and never putting secrets in
  anything. Plus a short map: each Wheems skill and when to use it.
- **How-to, as built-in skills.** The steps and commands for each behaviour, loaded by the
  engine only when the agent needs them. Rules don't go in skills: an agent can skip a skill.

| Skill                    | What it covers                                                                                                        | Who gets it                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `wheems-sessions`        | Finding, starting, briefing (`--done-when`), messaging, waiting on and ending sessions; sending work back; the limits | The chief, and sessions that may start more |
| `wheems-notes`           | Writing a note: when, what goes in it, the format, and answering Wheems's note requests                               | Everyone                                    |
| `wheems-knowledge`       | Searching the knowledge base, and reading what it finds                                                               | Everyone                                    |
| `wheems-skill-proposals` | Proposing a new or changed skill for review                                                                           | Everyone                                    |

New behaviours go in as skills the same way: creating team agents, approvals and reporting back
when they come. Agents never drive Herdr directly; sessions are always started and messaged
through `wheems session`, and the `wheems-sessions` skill says so.

Skills are written at every start into the folder each engine reads: `.claude/skills/` for Claude
Code, `.agents/skills/` for Codex and opencode. Each is a `SKILL.md` named `wheems-…`, written by
Wheems, and replaced at every start; Wheems removes its own skills that are no longer given, and
never touches any other skill there. They come with Wheems's version, like today's built-in
sections, and aren't edited in the library. Checked on 17 November 2026: Claude Code follows
`@AGENTS.md` and finds `.claude/skills/`, and Codex 0.169 finds `.agents/skills/`. opencode's
documentation says it reads `.agents/skills/`; not yet tried here.

Your own skills, from the library and `skills.yaml`, are still delivered in milestone 5, by the
same mechanism.

## What the engines add by themselves

Left alone, Claude Code would also load your own `~/.claude/CLAUDE.md` and your own skills
(`~/.claude/skills/`) into every Wheems session on it. Those are written for your own work, not
for a chief: they can tell it to write notes somewhere else, or run your own review steps. So
Wheems starts Claude Code with `--settings` that leave them out:

- **`claudeMdExcludes`** lists your `~/.claude/CLAUDE.md`, and every `CLAUDE.md`,
  `CLAUDE.local.md` and `.claude/CLAUDE.md` in a folder above the session's, as absolute paths.
  The `CLAUDE.md` Wheems writes in the session's folder is never on the list.
- **`skillOverrides`** turns off each skill in `~/.claude/skills/`, by its folder name and its
  `name`, read at every start. Never a `wheems-…` one, since those names are Wheems's.

Your plugins, MCP servers, claude.ai connectors (such as Gmail and Calendar), hooks and other
settings stay, so a chief can still read an email. Checked on 17 November 2026 with Claude Code
2.1.326. Ruled out: `--bare`, which stops Claude Code reading the keychain and so breaks a
subscription sign-in; and `--setting-sources project,local`, which also drops your connectors,
MCP servers and auto mode's settings. A wildcard in `claudeMdExcludes` didn't match in a test,
so the paths are listed in full.

Codex reads `~/.codex/AGENTS.md` and `~/.codex/skills/`; opencode has no global file.
