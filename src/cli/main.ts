#!/usr/bin/env node
import { defaultIo, run } from './program.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
  color,
  ...defaultIo(),
});
