import type { RuntimeDriver } from '../contracts/runtime.js';

/**
 * Stops and removes every runtime session labelled with a workspace: its chief's threads, its
 * ad-hoc sessions and its filer. For `wheems ws archive` and `ws remove`. Returns how many.
 */
export async function stopWorkspaceSessions(
  runtime: RuntimeDriver,
  workspace: string,
): Promise<number> {
  let stopped = 0;
  for (const session of await runtime.list({ labels: { workspace } })) {
    if (session.state === 'live') await runtime.stop(session.id).catch(() => undefined);
    await runtime.remove(session.id).catch(() => undefined);
    stopped++;
  }
  return stopped;
}
