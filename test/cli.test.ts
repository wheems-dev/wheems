import { describe, expect, it } from 'vitest';
import { defaultIo, packageVersion, run } from '../src/cli/program.js';

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

describe('opinr CLI', () => {
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
});
