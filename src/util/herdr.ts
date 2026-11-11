/**
 * Herdr's agent integrations: small hooks, installed by the Herdr app's `herdr` command,
 * that make each agent CLI report its status (working, done, blocked) to Herdr core. Opinr
 * follows turns by that status, so an engine without its integration can't be followed.
 */
import { runCommand } from './process.js';

export type IntegrationStatus = 'current' | 'outdated' | 'missing' | 'unknown';

/** The status of each Herdr integration, by name, from `herdr integration status`. */
export async function herdrIntegrations(): Promise<Map<string, IntegrationStatus> | null> {
  const result = await runCommand('herdr', ['integration', 'status'], { timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  return parseIntegrationStatus(result.stdout);
}

export function parseIntegrationStatus(text: string): Map<string, IntegrationStatus> {
  const statuses = new Map<string, IntegrationStatus>();
  for (const line of text.split('\n')) {
    const match = /^([a-z0-9-]+)(?: \([^)]*\))?: (.+)$/.exec(line.trim());
    if (!match) continue;
    const [, name = '', state = ''] = match;
    statuses.set(
      name,
      state.startsWith('current')
        ? 'current'
        : state.startsWith('not installed')
          ? 'missing'
          : /outdated|old|update/.test(state)
            ? 'outdated'
            : 'unknown',
    );
  }
  return statuses;
}
