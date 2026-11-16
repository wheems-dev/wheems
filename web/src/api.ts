import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Flash } from '../../src/web/actions.js';

/**
 * Talking to the Wheems service. The token arrives once, after the # in the address
 * `wheems web open` gives (which no browser sends to a server), and is kept in this origin's
 * own storage: no other site, and no other port on this computer, can read it. Every request
 * sends it in a header, which a link or a form on another site can't.
 */
const KEY = 'wheems-token';

function takeTokenFromAddress(): void {
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (!match?.[1]) return;
  try {
    localStorage.setItem(KEY, decodeURIComponent(match[1]));
  } catch {
    // Storage can be blocked; the token is then kept for this page only.
    memory = decodeURIComponent(match[1]);
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

let memory: string | null = null;
takeTokenFromAddress();

export function token(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token() ?? ''}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? response.statusText);
  return body;
}

/** A view from the API, kept fresh: `every` reloads it, for what changes while you watch. */
export function useView<T>(path: string | null, every?: number) {
  return useQuery<T, ApiError>({
    queryKey: [path],
    queryFn: () => call<T>(path ?? ''),
    enabled: path !== null,
    ...(every !== undefined && { refetchInterval: every }),
    retry: (count, error) => error.status >= 500 && count < 2,
  });
}

/** An action: posts, then reloads every view, since an action can change several. */
export function useAction(path: string) {
  const client = useQueryClient();
  return useMutation<Flash, ApiError, Record<string, string | string[]>>({
    mutationFn: (fields) => call<Flash>(path, { method: 'POST', body: JSON.stringify(fields) }),
    onSettled: () => client.invalidateQueries(),
  });
}
