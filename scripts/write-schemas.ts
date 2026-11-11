/** Writes schemas/<kind>.schema.json from the zod config schemas. Run with npm run schemas. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderSchemas } from './render-schemas.js';

const dir = new URL('../schemas/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [file, content] of Object.entries(renderSchemas())) {
  writeFileSync(new URL(file, dir), content);
  console.log(`schemas/${file}`);
}
