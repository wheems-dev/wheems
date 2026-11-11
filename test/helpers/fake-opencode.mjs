#!/usr/bin/env node
// A stand-in for opencode's CLI: `--version`, `session list --format json` and
// `export <id>`, answering from a JSON file (FAKE_OPENCODE_DATA) shaped like real output.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('1.19.5\n');
  process.exit(0);
}
const data = JSON.parse(readFileSync(process.env.FAKE_OPENCODE_DATA ?? '', 'utf8'));
if (args[0] === 'session' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(data.sessions, null, 2));
  process.exit(0);
}
if (args[0] === 'export') {
  const exported = data.exports[args[1]];
  if (!exported) {
    process.stderr.write(`Session not found: ${args[1]}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(exported));
  process.exit(0);
}
process.stderr.write(`fake opencode: unknown command ${args.join(' ')}\n`);
process.exit(2);
