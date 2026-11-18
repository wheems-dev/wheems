import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { TEST_TMP } from './setup/tmpdir.js';

describe('the tests', () => {
  it("make their temporary folders in the repository's own .tmp/, not the shared temp folder", () => {
    expect(resolve(tmpdir())).toBe(resolve(TEST_TMP));
    expect(resolve(tmpdir())).toContain(resolve('.tmp'));
  });
});
