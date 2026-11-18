import { fileURLToPath } from 'node:url';

/**
 * Every test's temporary folders go in the repository's own `.tmp/test/`, never in the machine's
 * shared temp folder: a test that deletes too much can only reach its own kind. `os.tmpdir()`
 * reads TMPDIR each time, so setting it (test/setup/preload.ts) covers every test and the
 * processes they start.
 */
export const TEST_TMP = fileURLToPath(new URL('../../.tmp/test/', import.meta.url));
