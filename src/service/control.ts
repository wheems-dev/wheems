/**
 * The service's control socket: a Unix socket in the install's `.wheems/` folder
 * that the `wheems` command talks to. One JSON request per line, one JSON
 * response per line. Only this user can open it (mode 600).
 */
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { IndexStatus } from '../knowledge/search.js';
import type { MessageRecord, SessionRecord } from '../state/store.js';
import type { OpenConversation, RestartOutcome } from './conversations.js';
import type { SessionDetails } from './sessions.js';

/**
 * Who's calling: the ids Wheems put in a session's environment (`WHEEMS_SESSION`, and
 * `WHEEMS_CONVERSATION` for thread sessions), or neither for the person at a terminal, who may
 * name the workspace. That's convenience, not proof, on a machine with one person.
 */
const callerSchema = z.object({
  session: z.string().min(1).optional(),
  conversation: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
});

const sessionStates = z.enum(['starting', 'working', 'idle', 'stopped', 'ended']);

export const requestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ping') }),
  z.object({ op: z.literal('status') }),
  z.object({
    op: z.literal('reply'),
    conversation: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    text: z.string().min(1),
  }),
  z.object({
    op: z.literal('note'),
    conversation: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    text: z.string().min(1),
  }),
  z.object({ op: z.literal('reindex'), workspace: z.string().min(1) }),
  z.object({
    op: z.literal('propose-skill'),
    conversation: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    name: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    op: z.literal('session-new'),
    caller: callerSchema,
    agent: z.string().min(1).optional(),
    title: z.string(),
    purpose: z.string(),
    project: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal('session-list'),
    caller: callerSchema,
    mine: z.boolean().optional(),
    agent: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    state: sessionStates.optional(),
    kind: z.enum(['thread', 'adhoc', 'task']).optional(),
    all: z.boolean().optional(),
  }),
  z.object({ op: z.literal('session-search'), caller: callerSchema, words: z.string() }),
  z.object({ op: z.literal('session-show'), caller: callerSchema, id: z.string().min(1) }),
  z.object({ op: z.literal('session-end'), caller: callerSchema, id: z.string().min(1) }),
  /**
   * Stops serving a workspace: unbinds it and stops its sessions; with `forget`, also forgets
   * its records in the session store. `wheems workspace archive` and `workspace remove` ask it first.
   */
  z.object({ op: z.literal('workspace-retire'), id: z.string().min(1), forget: z.boolean() }),
  /** A thread's agent saves its handover, when Wheems asked for one (`wheems session handover`). */
  z.object({
    op: z.literal('handover'),
    conversation: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    text: z.string().min(1),
  }),
  /**
   * A workspace's chat threads, newest first, for choosing how each restarts. For the person
   * only: an agent's session is refused.
   */
  z.object({ op: z.literal('conversations'), caller: callerSchema }),
  /**
   * Restarts chat threads as chosen: carry on, hand over or start fresh (see
   * ConversationManager.restart). Each is named by its session's id. For the person only, in
   * the caller's workspace: an agent's session is refused.
   */
  z.object({
    op: z.literal('conversations-restart'),
    caller: callerSchema,
    /**
     * Then restart the service, once every conversation is set up: for a change to the chief,
     * whose new settings only a restart brings in. Until then, the old service starts no session
     * for a conversation set to start afresh.
     */
    restart: z.boolean().optional(),
    /**
     * With `restart`: the fingerprint of the workspace's settings (workspace.yaml and the chief's
     * agent file) the choices were made for. If they've changed since, nothing restarts: the
     * choices may no longer fit them.
     */
    settings: z.string().min(1).optional(),
    choices: z
      .array(
        z.object({
          session: z.string().min(1),
          choice: z.enum(['carry-on', 'hand-over', 'fresh']),
        }),
      )
      // None, with a restart: every conversation is set up already, or there are none.
      .max(200),
  }),
  /** Restarts the service with the latest config, once it has answered (the web app's Restart). */
  z.object({ op: z.literal('restart') }),
  /** The first chief greets the person in chat; with `once`, only if it never has. */
  z.object({ op: z.literal('greet'), once: z.boolean().optional() }),
  z.object({
    op: z.literal('session-send'),
    caller: callerSchema,
    id: z.string().min(1),
    text: z.string(),
    wait: z.boolean().optional(),
    wait_seconds: z.number().int().positive().max(3600).optional(),
  }),
]);

export type ControlRequest = z.infer<typeof requestSchema>;
export type ControlResponse =
  | {
      ok: true;
      version?: string;
      path?: string;
      index?: IndexStatus;
      message?: string;
      status?: ServiceReport;
      session?: SessionRecord;
      sessions?: SessionRecord[];
      details?: SessionDetails;
      /** For `greet` with `once`: true when it had greeted before, so it didn't again. */
      skipped?: boolean;
      /** For `conversations`: the workspace's chat threads. */
      conversations?: OpenConversation[];
      /** For `conversations-restart`: how each went. */
      restarted?: RestartOutcome[];
      /** For `conversations-restart` with `restart`: whether the service is restarting. */
      restarting?: boolean;
      /**
       * For `conversations-restart` with `restart`: the workspace's conversations changed since
       * the choices were made (one opened, or one set up started), so nothing was done.
       */
      stale?: boolean;
      /** The answer to a `session send --wait`. */
      answer?: string;
      sent?: MessageRecord;
    }
  | { ok: false; error: string };

/** What the running service says about itself, for `wheems status`. */
export interface ServiceReport {
  version: string;
  pid: number;
  startedAt: string;
  home: string;
  /** The chat connections it connected to when it started. */
  connections: string[];
  /** Where each workspace's chat comes from, and why it doesn't, if it doesn't. */
  workspaces: { id: string; chat: string | null; problem?: string }[];
  /** The port the web app is served on, or null when it isn't (its port was taken). */
  web?: { port: number } | null;
}

export type ControlHandler = (request: ControlRequest) => Promise<ControlResponse>;

const MAX_REQUEST = 1024 * 1024;

export async function listen(socketPath: string, handler: ControlHandler): Promise<Server> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  // A socket left by a service that did not stop cleanly would block listening.
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST) {
        socket.end(`${JSON.stringify({ ok: false, error: 'Request too large' })}\n`);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      void respond(line, handler).then((response) => socket.end(`${JSON.stringify(response)}\n`));
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return server;
}

async function respond(line: string, handler: ControlHandler): Promise<ControlResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: 'Not JSON' };
  }
  const request = requestSchema.safeParse(parsed);
  if (!request.success)
    return { ok: false, error: `Not a request Wheems knows: ${z.prettifyError(request.error)}` };
  try {
    return await handler(request.data);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Sends one request to the service. Rejects when the service is not running. */
export function request(
  socketPath: string,
  body: ControlRequest,
  timeoutMs = 30_000,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('The Wheems service did not answer in time'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on('data', (chunk: string) => (buffer += chunk));
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.trim()) as ControlResponse);
      } catch {
        reject(new Error('The Wheems service gave an answer that is not JSON'));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new Error('The Wheems service is not running: start it with wheems start')
          : error,
      );
    });
  });
}
