# Opinr

An opinionated framework for running teams of AI agents, with Herdr core as the runtime.

One install per person holds machines, connections, accounts and a library of agent
templates, skills and workflows. Isolated workspaces, one per business or area of life, each
have a chief of staff, agents, scoped skills, workflows, rules, a knowledge base and channels.
Agents are Claude Code, Codex and opencode, unchanged, each live in its own Herdr terminal.
Everything that extends Opinr is a driver with a contract, as in Laravel.

> **Status: milestone 0, skeleton.** The CLI, the config formats, the driver contracts with
> their contract tests, and the Herdr runtime driver. Nothing talks to Slack or runs agents
> yet. See the [roadmap](docs/roadmap.md).

## Try it

Requires Node.js 22.12 or later, and Herdr core 0.1.20 or later (`hc`) for the runtime checks.

```bash
npm install
npm run build
node dist/cli/main.js doctor                          # checks Node, Herdr core and ~/opinr
node dist/cli/main.js validate examples/install       # checks an install folder
node dist/cli/main.js doctor --home examples/install  # both
```

`doctor` starts a tiny test session in Herdr core and removes it again; `--quick` skips that.

## Docs

- [The product](docs/product.md): what Opinr is, and the opinions it holds
- [Architecture](docs/architecture.md): the service, the CLI, engines, integrations and guardrails
- [Config formats](docs/config.md): `install.yaml`, `workspace.yaml`, agents, `skills.yaml`, workflows
- [Drivers and plugins](docs/drivers.md): the contracts and their contract tests
- [The Herdr runtime driver](docs/herdr.md)
- [Roadmap](docs/roadmap.md): version one, the milestones, and open questions

## Developing

```bash
npm run check      # lint, typecheck, test and build, as CI does
npm test           # tests only
npm run schemas    # regenerate schemas/*.schema.json after changing src/config/schemas.ts
npm run opinr -- doctor   # run the CLI from source
```

The tests run the runtime contract suite against the real `hc` when it is installed, in a Herdr
core of their own so your terminals are never touched; `OPINR_TEST_HC=0` turns that off. They
also run it against a fake `hc`, which is what CI uses.

| Folder                       | What is in it                                                            |
| ---------------------------- | ------------------------------------------------------------------------ |
| `src/cli/`                   | The `opinr` command                                                      |
| `src/config/`                | Config schemas, loading with line numbers, and checks across files       |
| `src/contracts/`             | Driver contracts: runtime, engine, channel, and the registry             |
| `src/drivers/runtime/herdr/` | The Herdr runtime driver; `hc.ts` is the only module that calls `hc`     |
| `src/doctor/`                | `opinr doctor`                                                           |
| `src/testing/`               | Contract test suites and in-memory drivers, published as `opinr/testing` |
| `schemas/`                   | JSON Schemas for the config formats                                      |
| `examples/install/`          | A complete example install                                               |

## Licence

[Apache 2.0](LICENSE)
