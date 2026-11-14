import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every test's temporary folders go in the repository's own `.tmp/vitest/`, never in the
 * machine's shared temp folder: a test that deletes too much can only reach its own kind.
 * `os.tmpdir()` reads TMPDIR each time, so setting it here covers every test and the processes
 * they start.
 */
export const TEST_TMP = fileURLToPath(new URL('../../.tmp/vitest/', import.meta.url));

/** Vitest's global setup: a fresh folder for the run. */
export default function setup(): void {
  rmSync(TEST_TMP, { recursive: true, force: true });
  mkdirSync(TEST_TMP, { recursive: true });
  process.env.TMPDIR = TEST_TMP;
}
