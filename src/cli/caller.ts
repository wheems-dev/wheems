import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Who's running a `wheems` command, from the ids Wheems put in a session's environment:
 * `WHEEMS_SESSION`, and `WHEEMS_CONVERSATION` for a chat thread's session.
 */

/** The conversation or session a reply, note or skill proposal comes from. Throws outside one. */
export function speakerFrom(
  env: NodeJS.ProcessEnv,
  command: string,
  advice = '',
): { conversation: string } | { session: string } {
  const conversation = env.WHEEMS_CONVERSATION;
  if (conversation !== undefined && conversation !== '') return { conversation };
  const session = env.WHEEMS_SESSION;
  if (session !== undefined && session !== '') return { session };
  throw new Error(
    `${command} works inside a session started by Wheems (WHEEMS_SESSION is not set).${advice}`,
  );
}

/**
 * The workspace whose folder the person is in, so `--workspace` needn't be typed there; inside
 * a session started by Wheems, none (a session always acts in its own workspace).
 */
export function workspaceHere(
  io: { env: NodeJS.ProcessEnv; cwd?: () => string },
  home: string,
): string | undefined {
  const inSession = [io.env.WHEEMS_SESSION, io.env.WHEEMS_CONVERSATION].some(
    (id) => id !== undefined && id !== '',
  );
  if (inSession) return undefined;
  const rel = relative(join(resolve(home), 'workspaces'), resolve((io.cwd ?? process.cwd)()));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  const id = rel.split(sep)[0];
  return id !== undefined && /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : undefined;
}

/**
 * The caller of a `wheems session` command: the calling session, or the person at a terminal,
 * who isn't one and may name the workspace.
 */
export function callerFrom(
  env: NodeJS.ProcessEnv,
  workspace: string | undefined,
): { session?: string; conversation?: string; workspace?: string } {
  const session = env.WHEEMS_SESSION;
  const conversation = env.WHEEMS_CONVERSATION;
  return {
    ...(session !== undefined && session !== '' && { session }),
    ...(conversation !== undefined && conversation !== '' && { conversation }),
    ...(workspace !== undefined && { workspace }),
  };
}
