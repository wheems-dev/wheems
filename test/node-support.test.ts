import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { makeBinsExecutable } from '../scripts/executable.js';
import { nodeVersionProblem } from '../src/util/node-support.js';
import { fullTextSearchProblem, type SqlRunner } from '../src/util/sqlite.js';

describe('supported Node.js versions', () => {
  it('takes 22.16 and later in the 22 line, and 24 and later, but never 23', () => {
    for (const ok of ['22.16.0', '22.23.4', 'v22.16.1', '24.0.0', '25.2.0']) {
      expect(nodeVersionProblem(ok), ok).toBeNull();
    }
    for (const old of ['20.19.0', '21.7.3', '22.13.0', '22.15.1']) {
      expect(nodeVersionProblem(old), old).toMatch(/too old for Wheems/);
    }
    for (const node23 of ['23.0.0', '23.11.0']) {
      expect(nodeVersionProblem(node23), node23).toMatch(
        /no Node 23 release has SQLite full-text search/,
      );
    }
  });
});

describe("checking Node's SQLite for full-text search", () => {
  it('passes on the Node.js running the tests', async () => {
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
    expect(problem).toMatch(/22\.16 or later in the 22 line, or 24 or later/);
    expect(closed).toBe(true);
  });
});

describe('the build', () => {
  it("marks the package's commands executable", async () => {
    const root = mkdtempSync(join(tmpdir(), 'wheems-bin-'));
    try {
      mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
      const main = join(root, 'dist', 'cli', 'main.js');
      writeFileSync(main, '#!/usr/bin/env node\n');
      chmodSync(main, 0o644);
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ bin: { wheems: 'dist/cli/main.js' } }),
      );
      expect(await makeBinsExecutable(root)).toEqual(['dist/cli/main.js']);
      expect(statSync(main).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs as part of this package's build", async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      scripts: Record<string, string>;
      engines: Record<string, string>;
    };
    expect(pkg.scripts.build).toMatch(/tsx scripts\/make-executable\.ts$/);
    expect(pkg.engines.node).toBe('^22.16.0 || >=24');
  });
});
