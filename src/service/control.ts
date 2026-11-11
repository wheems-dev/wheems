/**
 * The service's control socket: a Unix socket in the install's `.opinr/` folder
 * that the `opinr` command talks to. One JSON request per line, one JSON
 * response per line. Only this user can open it (mode 600).
 */
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { dirname } from 'node:path';
import { z } from 'zod';

export const requestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ping') }),
  z.object({ op: z.literal('reply'), conversation: z.string().min(1), text: z.string().min(1) }),
  z.object({ op: z.literal('note'), conversation: z.string().min(1), text: z.string().min(1) }),
]);

export type ControlRequest = z.infer<typeof requestSchema>;
export type ControlResponse =
  { ok: true; version?: string; path?: string } | { ok: false; error: string };

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
    return { ok: false, error: `Not a request Opinr knows: ${z.prettifyError(request.error)}` };
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
      reject(new Error('The Opinr service did not answer in time'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on('data', (chunk: string) => (buffer += chunk));
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.trim()) as ControlResponse);
      } catch {
        reject(new Error('The Opinr service gave an answer that is not JSON'));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new Error('The Opinr service is not running (opinr service status)')
          : error,
      );
    });
  });
}
