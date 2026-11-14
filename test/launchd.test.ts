import { describe, expect, it } from 'vitest';
import { reloadJob, type Launchctl } from '../src/service/launchd.js';
import type { RunResult } from '../src/util/process.js';

const ok: RunResult = { code: 0, stdout: '', stderr: '', missing: false };
const absent: RunResult = {
  code: 113,
  stdout: '',
  stderr: 'Could not find service "dev.wheems.service" in domain for user gui: 501',
  missing: false,
};
const ioError: RunResult = {
  code: 5,
  stdout: '',
  stderr: 'Bootstrap failed: 5: Input/output error',
  missing: false,
};

/** A launchctl that answers each subcommand from a script of results, and records the calls. */
function fakeLaunchctl(script: Record<string, RunResult[]>): Launchctl & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (_command, args) => {
      const sub = args[0] ?? '';
      calls.push(sub);
      const queue = script[sub] ?? [];
      return Promise.resolve(queue.length > 1 ? (queue.shift() ?? ok) : (queue[0] ?? ok));
    },
    sleep: () => {
      calls.push('sleep');
      return Promise.resolve();
    },
  };
}

describe('reloading the launchd job', () => {
  it('waits for the old job to unload before loading it again', async () => {
    const launchctl = fakeLaunchctl({ print: [ok, ok, absent] });
    await reloadJob('gui/501', '/p.plist', launchctl);
    expect(launchctl.calls).toEqual([
      'bootout',
      'print',
      'sleep',
      'print',
      'sleep',
      'print',
      'enable',
      'bootstrap',
    ]);
  });

  it('tries the bootstrap again when launchd is still busy, as wheems restart once hit', async () => {
    const launchctl = fakeLaunchctl({ print: [absent], bootstrap: [ioError, ioError, ok] });
    await reloadJob('gui/501', '/p.plist', launchctl);
    expect(launchctl.calls.filter((c) => c === 'bootstrap')).toHaveLength(3);
  });

  it('says why when the bootstrap keeps failing', async () => {
    const launchctl = fakeLaunchctl({ print: [absent], bootstrap: [ioError] });
    await expect(reloadJob('gui/501', '/p.plist', launchctl)).rejects.toThrow(
      'launchctl bootstrap failed: Bootstrap failed: 5: Input/output error',
    );
    expect(launchctl.calls.filter((c) => c === 'bootstrap')).toHaveLength(6);
  });
});
