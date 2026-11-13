/**
 * Marks the package's commands (`bin` in package.json) executable, as npm does on install. A
 * build runs this after tsc, which writes files without the bit, so a command linked with
 * `npm link` runs rather than failing with "Permission denied".
 */
import { chmod, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function makeBinsExecutable(root: string): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
  const done: string[] = [];
  for (const bin of bins) {
    const file = join(root, bin);
    const { mode } = await stat(file);
    await chmod(file, mode | 0o111);
    done.push(bin);
  }
  return done;
}
