#!/usr/bin/env bun
// Check the runtime before loading anything else, so Node.js or an old Bun gets a plain message
// rather than a stack trace. Node.js can't load Wheems's other files at all, so it's turned away
// before importing any.
if (!('bun' in process.versions)) {
  process.stderr.write(
    `Wheems runs on Bun, not Node.js. Install Bun: curl -fsSL https://bun.sh/install | bash\nThis is ${process.execPath}.\n`,
  );
  process.exit(1);
}
const { bunVersionProblem } = await import('../util/bun-support.js');
const problem = bunVersionProblem(process.versions.bun);
if (problem !== null) {
  process.stderr.write(`${problem}\nThis is ${process.execPath}.\n`);
  process.exit(1);
}

const { defaultIo, run } = await import('./program.js');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
  color,
  columns: process.stdout.isTTY ? process.stdout.columns : undefined,
  ...defaultIo(),
});
