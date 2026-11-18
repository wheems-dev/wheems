import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { BUN_MINIMUM, bunVersionProblem } from '../src/util/bun-support.js';
import { fullTextSearchProblem, type SqlRunner } from '../src/util/sqlite.js';

const root = new URL('../', import.meta.url);

describe('supported Bun versions', () => {
  it('takes the version Wheems is tested with and later', () => {
    for (const ok of [BUN_MINIMUM, '1.4.5', '1.5.0', '2.0.0', 'v1.4.4']) {
      expect(bunVersionProblem(ok)).toBeNull();
    }
    for (const old of ['1.4.3', '1.3.9', '1.0.0', '0.8.1']) {
      expect(bunVersionProblem(old)).toMatch(/too old for Wheems. Update it with bun upgrade/);
    }
  });

  it('turns Node.js away, saying how to install Bun', () => {
    expect(bunVersionProblem(undefined)).toMatch(
      /^Wheems runs on Bun, not Node.js. Install Bun 1\.4\.4 or later: curl -fsSL https:\/\/bun.sh\/install \| bash$/,
    );
  });

  it('is the version in .bun-version, which CI runs', () => {
    expect(readFileSync(new URL('.bun-version', root), 'utf8').trim()).toBe(BUN_MINIMUM);
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      engines: Record<string, string>;
    };
    expect(pkg.engines).toEqual({ bun: `>=${BUN_MINIMUM}` });
  });
});

describe('checking SQLite for full-text search', () => {
  it('passes on the Bun running the tests', async () => {
    expect(await fullTextSearchProblem()).toBeNull();
  });

  it('names the problem and the versions that work when FTS5 is missing', async () => {
    let closed = false;
    const withoutFts: SqlRunner = {
      exec: () => {
        throw new Error('no such module: fts5');
      },
      close: () => {
        closed = true;
      },
    };
    const problem = await fullTextSearchProblem(() => Promise.resolve(withoutFts));
    expect(problem).toMatch(/SQLite without full-text search \(FTS5\)/);
    expect(problem).toMatch(/no such module: fts5/);
    expect(problem).toMatch(/Bun 1\.4\.4 or later/);
    expect(closed).toBe(true);
  });
});

describe('the package', () => {
  it('runs its command from source, with Bun', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin).toEqual({ wheems: 'src/cli/main.ts' });
    const main = new URL('src/cli/main.ts', root);
    expect(readFileSync(main, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env bun');
    expect(statSync(main).mode & 0o111).toBe(0o111);
  });
});
