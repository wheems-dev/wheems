/**
 * Runs short commands that are not hc, such as `claude --version` or `launchctl`.
 * Every hc call goes through src/drivers/runtime/herdr/hc.ts instead; a test checks
 * that no other module names hc.
 */
import { execFile, spawn } from 'node:child_process';

export interface RunResult {
  /** The exit code, or null when the program could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program was not found. */
  missing: boolean;
}

export function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        env: options.env ?? process.env,
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, missing: false });
          return;
        }
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        resolve({
          code: typeof error.code === 'number' ? error.code : null,
          stdout,
          stderr: stderr || error.message,
          missing,
        });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Runs a program on this terminal, for a person to use, and resolves with its exit code. */
export function runInteractive(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...(options.cwd !== undefined && { cwd: options.cwd }),
    });
    child.on('error', () => {
      resolve(null);
    });
    child.on('exit', (code) => {
      resolve(code);
    });
  });
}
