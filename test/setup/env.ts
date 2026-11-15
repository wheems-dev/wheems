import { mkdirSync } from 'node:fs';
import { TEST_TMP } from './tmpdir.js';

// In each test worker, too: temporary folders go in the repository, not the shared temp folder.
mkdirSync(TEST_TMP, { recursive: true });
process.env.TMPDIR = TEST_TMP;
