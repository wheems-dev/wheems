#!/usr/bin/env node
// Check the Node.js version before loading anything that needs a newer one, so an old
// Node.js gets a plain message rather than a stack trace from a dependency.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(
    `Opinr needs Node.js 22.12 or later, and this is ${process.versions.node} (${process.execPath}).\n`,
  );
  process.exit(1);
}

const { defaultIo, run } = await import('./program.js');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
  color,
  ...defaultIo(),
});
