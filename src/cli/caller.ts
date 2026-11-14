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
