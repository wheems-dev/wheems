/** Run after the build (npm run build): makes the package's commands executable. */
import { fileURLToPath } from 'node:url';
import { makeBinsExecutable } from './executable.js';

for (const bin of await makeBinsExecutable(fileURLToPath(new URL('..', import.meta.url)))) {
  console.log(`${bin} is executable`);
}
