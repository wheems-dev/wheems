import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { renderSchemas } from '../scripts/render-schemas.js';

describe('published JSON Schemas', () => {
  it('match the config schemas (run npm run schemas after changing them)', () => {
    for (const [file, content] of Object.entries(renderSchemas())) {
      const committed = readFileSync(new URL(`../schemas/${file}`, import.meta.url), 'utf8');
      expect(committed, file).toBe(content);
    }
  });
});
