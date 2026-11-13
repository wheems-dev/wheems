# Changelog

Wheems follows [semantic versioning](https://semver.org). While it's 0.0.x, any release may
change anything, including commands and config formats, without a migration path.

## Unreleased

**Added**

- `wheems` on its own shows a welcome screen: the cloud from the brand kit, in blue, beside the
  name and "Your crew, ready for work.", then how the install is doing (workspaces and agents,
  the service, search, and anything waiting for review). `wheems setup` opens with the cloud too.

**Fixed**

- Search needs SQLite full-text search (FTS5), which Node only bundles from 22.16 in the 22
  line and from 24; no Node 23 release has it. `engines` is now `^22.16.0 || >=24`, the CLI and
  `wheems service install` refuse other versions with a plain message, `wheems doctor` checks
  that this Node's SQLite has full-text search, and search says so instead of failing with
  "no such module: fts5".
- `npm run build` now marks `dist/cli/main.js` executable, so a `wheems` linked with `npm link`
  runs instead of failing with "Permission denied".

## 0.0.1

The first preview: milestones 0 to 2 of the [roadmap](docs/roadmap.md). Not ready for real use.

**Set up and check**

- `wheems setup`: a menu to install and sign in the engines (Claude Code, Codex, opencode),
  connect Slack, create workspaces, turn on search by meaning, and install the service.
- `wheems init`, `wheems doctor` and `wheems validate`, with JSON Schemas for every config file.

**Talking to agents**

- A chief of staff per workspace, reached from Slack, with one conversation and one engine
  session per thread, resumed when you reply.
- The service under launchd: `wheems service install | status | logs | restart | uninstall`.
- Agents reply with `wheems reply`, running in Herdr core where you can watch or take over.

**The knowledge loop**

- Notes with `wheems note`, asked for when a conversation goes quiet, and filed into a knowledge
  base of pages by a built-in filer whose work is checked in code before it's committed.
- `about-you.md` and a brief per workspace, loaded by every agent.
- Search by keyword and, with Ollama, by meaning: `wheems kb search` and `wheems kb reindex`.
- A nightly tidy that reports contradictions and stale pages and refreshes the brief.
- Skills proposed by agents (`wheems skill propose`), with a near-duplicate check, reviewed with
  `wheems review` into a versioned library.

**For driver authors**

- Contracts for runtime, engine, channel, embeddings and vector store drivers, with contract test
  suites and in-memory drivers in `wheems/testing`.
