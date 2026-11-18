/**
 * Builds Wheems as one executable (`bun run compile`), with Bun and the web app inside: nothing
 * else to install. Into dist/bin/: `wheems` for this computer, or `wheems-<target>` for each
 * target given, such as bun-darwin-arm64 or bun-linux-x64.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist/`;
const targets = process.argv.slice(2);

// The web app, then an entry point that hands its files to the server before Wheems starts.
await import('./build-web.js');
const app = `${dist}web/app/`;
const files = readdirSync(app, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => `${entry.parentPath}/${entry.name}`.slice(app.length).replace(/^\/+/, ''))
  .sort();
const entry = `${dist}compile/entry.ts`;
rmSync(`${dist}compile`, { recursive: true, force: true });
mkdirSync(`${dist}compile`, { recursive: true });
writeFileSync(
  entry,
  [
    "import { embedApp } from '../../src/util/standalone.ts';",
    ...files.map(
      (file, i) => `import f${String(i)} from '../web/app/${file}' with { type: 'file' };`,
    ),
    `embedApp({ ${files.map((file, i) => `${JSON.stringify(file)}: f${String(i)}`).join(', ')} });`,
    "await import('../../src/cli/main.ts');",
    '',
  ].join('\n'),
);

mkdirSync(`${dist}bin`, { recursive: true });
for (const target of targets.length > 0 ? targets : [undefined]) {
  const outfile = `${dist}bin/${target === undefined ? 'wheems' : `wheems-${target.replace(/^bun-/, '')}`}`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      'build',
      '--compile',
      '--minify',
      ...(target === undefined ? [] : ['--target', target]),
      entry,
      '--outfile',
      outfile,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode);
  // A Mac executable built for the other kind of Mac keeps Bun's signature, which no longer
  // matches: sign it again (ad hoc), as the Mac's own build is. Only a Mac has codesign.
  const forMac = target === undefined ? process.platform === 'darwin' : target.includes('darwin');
  if (forMac && process.platform === 'darwin') {
    const signed = Bun.spawnSync(['codesign', '--force', '--sign', '-', outfile], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (signed.exitCode !== 0) process.exit(signed.exitCode);
  }
}
