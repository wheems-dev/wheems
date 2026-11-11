import { z } from 'zod';
import { configSchemas } from '../src/config/schemas.js';

const TITLES: Record<keyof typeof configSchemas, string> = {
  install: 'Opinr install.yaml',
  workspace: 'Opinr workspace.yaml',
  agent: 'Opinr agent front matter (agents/<name>.md)',
  skills: 'Opinr skills.yaml',
  workflow: 'Opinr workflow (workflows/<name>.yaml)',
};

/** The JSON Schema file for each config format, keyed by file name. */
export function renderSchemas(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [kind, schema] of Object.entries(configSchemas) as [
    keyof typeof configSchemas,
    z.ZodType,
  ][]) {
    const json = {
      ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
      $id: `https://opinr.dev/schemas/${kind}.schema.json`,
      title: TITLES[kind],
    };
    files[`${kind}.schema.json`] = `${JSON.stringify(json, null, 2)}\n`;
  }
  return files;
}
