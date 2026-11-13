import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_HC = fileURLToPath(new URL('./fake-hc.mjs', import.meta.url));

export interface FakeHc {
  binary: string;
  env: NodeJS.ProcessEnv;
  dir: string;
  cleanup: () => void;
}

/** A fresh fake hc with its own state file. */
export function fakeHc(extraEnv: Record<string, string> = {}): FakeHc {
  const dir = mkdtempSync(join(tmpdir(), 'wheems-fake-hc-'));
  return {
    binary: FAKE_HC,
    dir,
    env: { ...process.env, FAKE_HC_STATE: join(dir, 'state.json'), ...extraEnv },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Whether a real hc is installed here. WHEEMS_TEST_HC=0 turns the live tests off. */
export function realHcAvailable(): boolean {
  if (process.env.WHEEMS_TEST_HC === '0') return false;
  try {
    execFileSync('hc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment for a real hc core of its own, so tests never touch the person's
 * terminals. The folder is kept short: hc's socket path must fit in 103 bytes.
 */
export function isolatedHcEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oh-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HC_SESSION: 'ot',
    XDG_CONFIG_HOME: join(dir, 'c'),
    XDG_DATA_HOME: join(dir, 'd'),
    XDG_STATE_HOME: join(dir, 's'),
    XDG_RUNTIME_DIR: join(dir, 'r'),
  };
  delete env.HC_TERMINAL_ID;
  for (const sub of ['c', 'd', 's', 'r']) mkdirSync(join(dir, sub), { mode: 0o700 });
  return { env, dir };
}
