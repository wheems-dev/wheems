import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadInstall } from '../config/load.js';
import { paths } from '../home.js';
import { listAboutYou } from '../review/review.js';
import { request } from '../service/control.js';
import { listProposals } from '../skills/proposals.js';

/**
 * The cloud, from the brand kit's terminal mark (Unicode half blocks, drawn from the mascot's
 * silhouette). Its eye and smile are the gaps the half blocks leave.
 */
// Every character is one UTF-16 unit, so .length is the width in columns.
export const CLOUD = [
  '            ▄▄██▄▄▄',
  '          ██████████',
  '     ▄██▄████████████',
  '    █████████████████',
  '   ▄█████████████████',
  ' ▄████▀█████████████▄▄',
  '▄██████████████████████',
  '▀████▄▀▄████████████████',
  ' ██████████████████████',
  '  ▀▀▀███████████████▀▀',
];

/** The brand line under the name. */
export const TAGLINE = 'Your crew, ready for work.';

/**
 * A blue between the brand's cobalt (light backgrounds) and its dark-mode blue, from the
 * 256-colour palette, so the cloud reads on light and dark terminals alike.
 */
const CLOUD_COLOUR = '\x1b[38;5;69m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export interface WelcomeStatus {
  mark: '✓' | '!' | '-';
  text: string;
}

/** The welcome screen: the cloud with the name and tagline beside it, then the install's status. */
export function renderWelcome(options: {
  version: string;
  status: WelcomeStatus[];
  color: boolean;
  /** Ends with the commands to try next. On by default. */
  hints?: boolean;
}): string {
  const paint = (code: string, text: string) => (options.color ? `${code}${text}${RESET}` : text);
  const width = Math.max(...CLOUD.map((line) => line.length));
  const beside: Record<number, string> = {
    4: paint(BOLD, 'wheems') + ' ' + paint(DIM, options.version),
    5: TAGLINE,
  };
  const lines = CLOUD.map((line, row) => {
    const text = beside[row];
    const padded = line + ' '.repeat(width - line.length);
    return text === undefined
      ? paint(CLOUD_COLOUR, line)
      : `${paint(CLOUD_COLOUR, padded)}   ${text}`;
  });
  const marks = { '✓': '\x1b[32m', '!': '\x1b[33m', '-': DIM } as const;
  return [
    '',
    ...lines,
    '',
    ...options.status.map((s) => `${paint(marks[s.mark], s.mark)} ${s.text}`),
    ...(options.status.length > 0 ? [''] : []),
    ...(options.hints === false
      ? []
      : [paint(DIM, 'wheems setup · wheems doctor · wheems --help'), '']),
  ].join('\n');
}

/**
 * What the welcome screen says about this install: its workspaces and agents, the service,
 * search, and anything waiting for review. Quick: it reads files and pings the service, and
 * never starts a session.
 */
export async function welcomeStatus(
  home: string,
  env: NodeJS.ProcessEnv,
  ping: (socket: string) => Promise<boolean> = (socket) =>
    request(socket, { op: 'ping' }, 1000).then(
      (answer) => answer.ok,
      () => false,
    ),
): Promise<WelcomeStatus[]> {
  const where = paths(home, env);
  const hasInstall = await readFile(join(home, 'install.yaml')).then(
    () => true,
    () => false,
  );
  if (!hasInstall) {
    return [{ mark: '!', text: `No install at ${tilde(home, env)} yet: run wheems setup` }];
  }
  const install = await loadInstall(home);
  const workspaces = install.workspaces.filter((w) => w.config);
  const agents = workspaces.reduce((n, w) => n + w.agents.length, 0);
  const status: WelcomeStatus[] = [];
  status.push(
    workspaces.length > 0
      ? {
          mark: '✓',
          text: `${count(workspaces.length, 'workspace')}, ${count(agents, 'agent')} in ${tilde(home, env)}`,
        }
      : { mark: '!', text: 'No workspaces yet: run wheems setup' },
  );
  status.push(
    (await ping(where.socket))
      ? { mark: '✓', text: 'The service is running' }
      : { mark: '!', text: "The service isn't running: wheems service install" },
  );
  const embeddings = install.config?.knowledge.embeddings;
  status.push(
    embeddings
      ? { mark: '✓', text: `Search by meaning with ${embeddings.model ?? embeddings.driver}` }
      : { mark: '-', text: 'Search by keyword only (wheems setup → Knowledge for meaning)' },
  );
  const waiting =
    (await listProposals(where.state)).length + (await listAboutYou(where.state)).length;
  if (waiting > 0) {
    status.push({ mark: '!', text: `${count(waiting, 'thing')} waiting for you: wheems review` });
  }
  return status;
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

function tilde(path: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  return home !== undefined && home !== '' && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}
