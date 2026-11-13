import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/cli/commands/init.js';
import { defaultIo, packageVersion, run } from '../src/cli/program.js';
import { installYaml } from '../src/cli/templates.js';

const EXAMPLE = new URL('../examples/install/', import.meta.url).pathname;

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await run(args, {
      out: (text) => (out += text),
      err: (text) => (err += text),
      env: {},
      color: false,
      ...defaultIo(),
    });
    return { code, out, err };
  } finally {
    process.exitCode = previous;
  }
}

describe('wheems CLI', () => {
  it('prints its version', async () => {
    const result = await cli('--version');
    expect(result.out.trim()).toBe(packageVersion());
    expect(result.code).toBe(0);
  });

  it('lists its commands in help', async () => {
    const result = await cli('--help');
    expect(result.out).toMatch(/doctor/);
    expect(result.out).toMatch(/validate/);
  });

  it('validates an install folder', async () => {
    const result = await cli('validate', EXAMPLE);
    expect(result).toMatchObject({ code: 0, out: 'Valid\n' });
  });

  it('validates single files and reports problems with their line', async () => {
    const result = await cli('validate', `${EXAMPLE}install.yaml`, `${EXAMPLE}library/README.md`);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/README\.md: error Not a config file/);
    expect(result.out).toMatch(/1 error\n$/);
  });

  it('refuses unknown commands', async () => {
    const result = await cli('fly');
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/unknown command 'fly'/);
  });

  it('rebuilds and searches the knowledge base itself when the service is not running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wheems-kb-'));
    try {
      writeFileSync(join(home, 'install.yaml'), installYaml());
      await initWorkspace({ home, id: 'personal' });
      await initWorkspace({ home, id: 'work', channel: 'work-chat' });
      const pages = join(home, 'workspaces', 'work', 'knowledge', 'pages');
      writeFileSync(join(pages, 'crm.md'), '---\ntitle: CRM\n---\n\nThe CRM starts on SQLite.\n');

      const before = await cli('kb', 'search', 'CRM', '--workspace', 'work', '--home', home);
      expect(before.code).toBe(1);
      expect(before.err).toMatch(/no search index yet/);
      expect(await cli('kb', 'reindex', '--home', home)).toMatchObject({
        code: 0,
        out: 'personal: indexed 0 files, keyword search only\nwork: indexed 1 file, keyword search only\n',
      });
      const found = await cli(
        'kb',
        'search',
        'sqlite',
        '--workspace',
        'work',
        '--home',
        home,
        '--json',
      );
      expect(found.code).toBe(0);
      expect(JSON.parse(found.out)).toMatchObject({
        mode: 'keyword',
        results: [{ file: 'pages/crm.md', title: 'CRM', matched: ['keyword'] }],
      });
      const which = await cli('kb', 'search', 'sqlite', '--home', home);
      expect(which.err).toMatch(/Say which workspace with --workspace: personal, work/);
      expect((await cli('kb', 'search', 'x', '--limit', '0', '--home', home)).code).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
