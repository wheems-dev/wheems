import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_TMP } from './tmpdir.js';

// In each test worker, too: temporary folders go in the repository, not the shared temp folder.
mkdirSync(TEST_TMP, { recursive: true });
process.env.TMPDIR = TEST_TMP;
// The engines' own records too: no test may read or write this Mac's ~/.claude.json or
// ~/.codex/config.toml, so their default paths point into the repository as well.
const engines = join(TEST_TMP, 'engine-config');
mkdirSync(engines, { recursive: true });
// Kept for the one contract test that asks the real Claude Code whether it's signed in, which
// only reads (see test/claude-code.test.ts). Set once, before this worker changes it.
process.env.WHEEMS_TEST_REAL_CLAUDE_CONFIG_DIR ??= process.env.CLAUDE_CONFIG_DIR ?? '';
process.env.CLAUDE_CONFIG_DIR = engines;
process.env.CODEX_HOME = engines;
// Services started by tests serve the web app on a free port, never the real one.
process.env.WHEEMS_WEB_PORT = '0';
