import { isDriverError } from '../contracts/driver.js';
import type { RuntimeDriver } from '../contracts/runtime.js';

/**
 * Stops and removes every runtime session labelled with a workspace: its chief's threads, its
 * ad-hoc sessions and its filer. For `wheems workspace archive` and `workspace remove`. Throws if one can't be
 * stopped, or Herdr can't be asked, so nothing moves or is deleted while an agent may still run.
 * Returns how many it stopped.
 */
export async function stopWorkspaceSessions(
  runtime: RuntimeDriver,
  workspace: string,
): Promise<number> {
  let stopped = 0;
  for (const session of await runtime.list({ labels: { workspace } })) {
    try {
      if (session.state === 'live') await runtime.stop(session.id);
    } catch (error) {
      if (!isDriverError(error, 'not_found')) throw error;
    }
    await runtime.remove(session.id).catch(() => undefined);
    if ((await runtime.get(session.id))?.state === 'live') {
      throw new Error(
        `Couldn't stop ${session.name ?? session.id}, so ${workspace} was left as it is. Stop it with hc kill ${session.id}, then try again.`,
      );
    }
    stopped++;
  }
  return stopped;
}
