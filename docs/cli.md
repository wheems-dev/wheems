# The `wheems` command

How the commands are organised, and the rules for adding one. Decided on 14 November 2026 (see
[decisions](ideas/decisions.md)).

## The shape: `wheems <area> <action> [name] [--options]`

Commands are grouped by area, the way Laravel's `php artisan` groups them by namespace, but with
spaces rather than colons: `wheems workspace create acme`, not `wheems workspace:create acme`.
An area is one of the things Wheems is made of: workspaces, sessions, the knowledge base, skills,
channels, engines, the service, config, and later projects, tasks, routines and workflows.
`wheems list` prints every command by area, and `wheems <area> --help` one area's.

### Actions

One set of verbs, so the next command can be guessed:

| Verb                        | For                                           | Example                               |
| --------------------------- | --------------------------------------------- | ------------------------------------- |
| `list`                      | Every one, one per line; `--json` for scripts | `wheems workspace list`               |
| `show <name>`               | One, in detail; `--json` for scripts          | `wheems workspace show acme`          |
| `create <name>`             | A new one, made in config                     | `wheems workspace create acme`        |
| `rename <name> <new>`       | Its display name; ids and folders stay        | `wheems workspace rename acme "Acme"` |
| `archive <name>`, `restore` | Put away, keeping everything; and bring back  | `wheems workspace archive acme`       |
| `remove <name>`             | Delete for good, after asking                 | `wheems workspace remove acme`        |
| `add <name>`                | Install from the library into a workspace     | `wheems blueprint add crm`            |
| `run <name>`                | Run something once, now                       | `wheems workflow run leads`           |
| `start`, `stop`, `restart`  | Processes                                     | `wheems service restart`              |

A few areas have a verb of their own where none of these says what happens: a session is
`end`ed (it stays as a record), a message is `send`, a knowledge base is `search`ed, a channel is
`connect`ed, an engine is `install`ed, `login`, or told to `trust` a folder.

### Options

- `--home <dir>`: the install folder, on every command that uses it (default `$WHEEMS_HOME`, then
  `~/wheems`).
- `--json`: on every `list` and `show`.
- `--workspace <id>`: on everything scoped to a workspace that isn't named as the argument.
- `--yes`: skips the question on commands that ask first (`archive`, `remove`). Without a
  terminal they refuse rather than act unasked.

### The top level

Only install-wide commands, and the ones used every day:

- **Start here:** `setup`, `doctor`, `list`.
- **Every day:** `review`, and `status`, `start`, `stop`, `restart`, `logs` as shortcuts for
  `wheems service …`.

`COMMAND_GROUPS` in `src/cli/program.ts` lists them, and a test fails when a new top-level command
appears without being added there on purpose. Everything else goes under an area.

## The areas

✓ built, ○ planned (with the milestone that brings it).

| Area                         | Actions                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `workspace` (`ws` for short) | ✓ `list [--archived]`, `show`, `create`, `rename`, `archive`, `restore`, `remove` |
| `session`                    | ✓ `list`, `search`, `show`, `create`, `send`, `end`                               |
| `kb`                         | ✓ `search`, `note`, `reindex`                                                     |
| `chat`                       | ✓ `reply`; ○ `post <channel>`, `ask <channel>` (M3)                               |
| `skill`                      | ✓ `list`, `show`, `propose`; ○ `add`, `remove`                                    |
| `channel`                    | ✓ `list`, `connect <driver>`, `manifest <driver>`                                 |
| `engine`                     | ✓ `list`, `install`, `login`, `trust`                                             |
| `service`                    | ✓ `start`, `stop`, `restart`, `status`, `logs`, `run`, `uninstall`                |
| `config`                     | ✓ `validate`; ○ `show`                                                            |
| `agent`                      | ○ `list`, `show`, `create [--from <template>]`, `remove` (M5)                     |
| `project`                    | ○ `list`, `show`, `create`, `rename`, `archive` (M4)                              |
| `task`                       | ○ `list`, `show`, `create`, `done`, `step` (M5)                                   |
| `routine`                    | ○ `list`, `show`, `create`, `run`, `pause` (M5)                                   |
| `pair`                       | ○ `run` (M5)                                                                      |
| `workflow`                   | ○ `list`, `show`, `run` (M7)                                                      |
| `eval`                       | ○ `run`, `report` (M7)                                                            |
| `blueprint`                  | ○ `list`, `add`, `create` (M8)                                                    |
| `integration`                | ○ `list`, `connect <name>`, `grant <name> <workspace>` (M9)                       |
| `action`                     | ○ `run <action>`, through the broker (M9)                                         |
| `purchase`                   | ○ `request` (M9)                                                                  |
| `machine`                    | ○ `list`, `run` (the worker on each machine) (M10)                                |
| `plugin`                     | ○ `add`, `list`, `remove` (M11)                                                   |

Laravel's `make:` generators become each area's `create`. Older documents named some commands
differently; the docs now use these names:

| Before                  | Now                                 |
| ----------------------- | ----------------------------------- |
| `wheems project new`    | `wheems project create`             |
| `wheems task new`       | `wheems task create`                |
| `wheems step`           | `wheems task step`                  |
| `wheems post updates`   | `wheems chat post updates`          |
| `wheems ask approvals`  | `wheems chat ask approvals`         |
| `wheems connect github` | `wheems integration connect github` |
| `wheems grant github`   | `wheems integration grant github`   |
| `wheems do deploy`      | `wheems action run deploy`          |
| `wheems buy`            | `wheems purchase request`           |
| `wheems node`           | `wheems machine run`                |
| `wheems make:blueprint` | `wheems blueprint create`           |

### Workspaces: archive and remove

- **`workspace archive <id>`** stops serving a workspace and keeps everything:
  - a running service unbinds it and stops its sessions in Herdr (through the `workspace-retire`
    control request); with no service running, the command stops them itself;
  - the folder moves to `archive/<id>/` (dated if that's taken), marked with `.archived.json`;
  - its search index is dropped, since it's rebuilt from the files.

  `workspace restore <id>` moves it back; restart the service for its chief to answer again.

- **`workspace remove <id>`** deletes it for good, after you type its id (or with `--yes`):
  - its folder, with its agents and knowledge base;
  - its state under `.wheems/`: search index, session folders, messages, tidy and quarantine;
  - its records in the session store.

  It works on an archived workspace too. Accounts in `install.yaml` and the chat app are left as
  they are.

## Old names

Renamed commands keep working for a release, hidden from help, and say what they're called now on
standard error:

| Old                      | Now                             |
| ------------------------ | ------------------------------- |
| `wheems init`            | `wheems workspace create`       |
| `wheems validate`        | `wheems config validate`        |
| `wheems slack manifest`  | `wheems channel manifest slack` |
| `wheems service install` | `wheems service start`          |
| `wheems reply`           | `wheems chat reply`             |
| `wheems note`            | `wheems kb note`                |
| `wheems session new`     | `wheems session create`         |

The agents' built-in instructions use the new names; a session started before them keeps working
through the old ones until the release after.

## The workspace from the folder you're in

In a workspace's folder (`~/wheems/workspaces/acme/` or anywhere below it), commands that take
`--workspace` default to that workspace, the way Artisan finds the project it's run in:
`wheems kb search …` and the `wheems session …` commands. Inside a session started by Wheems they
always act in the session's own workspace, so this never applies there. `--workspace` still wins
when it's given.
