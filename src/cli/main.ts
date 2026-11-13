#!/usr/bin/env node
// Check the Node.js version before loading anything that needs a newer one, so an
// unsupported Node.js gets a plain message rather than a stack trace from a dependency.
import { nodeVersionProblem } from '../util/node-support.js';

const problem = nodeVersionProblem(process.versions.node);
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
  ...defaultIo(),
});
