import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_TMP } from './tmpdir.js';

// Loaded before any test (bunfig.toml); bun test runs every file in one process. The 20-second
// timeout is set by `bun run test` (package.json): Bun takes it only on the command line.

// Temporary folders go in the repository, in a fresh folder for the run, not the shared one.
rmSync(TEST_TMP, { recursive: true, force: true });
mkdirSync(TEST_TMP, { recursive: true });
process.env.TMPDIR = TEST_TMP;
// The engines' own records too: no test may read or write this Mac's ~/.claude.json or
// ~/.codex/config.toml, so their default paths point into the repository as well.
const engines = join(TEST_TMP, 'engine-config');
mkdirSync(engines, { recursive: true });
// Kept for the one contract test that asks the real Claude Code whether it's signed in, which
// only reads (see test/claude-code.test.ts). Set once, before it's changed.
process.env.WHEEMS_TEST_REAL_CLAUDE_CONFIG_DIR ??= process.env.CLAUDE_CONFIG_DIR ?? '';
process.env.CLAUDE_CONFIG_DIR = engines;
process.env.CODEX_HOME = engines;
// Services started by tests serve the web app on a free port, never the real one.
process.env.WHEEMS_WEB_PORT = '0';
