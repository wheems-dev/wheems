import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadInstall } from '../config/load.js';
import { paths, tilde } from '../home.js';
import { listAboutYou } from '../review/review.js';
import { request } from '../service/control.js';
import { listProposals } from '../skills/proposals.js';

/**
 * The cloud: the mascot's outline (the brand kit's mascot.svg), traced in Unicode half blocks,
 * with its eye and smile placed by hand so they read at this size. Half blocks are in every
 * monospace font and most terminals draw them as exact rectangles, so it looks the same
 * everywhere; an outline also reads on light and dark backgrounds alike. It has no colour of
 * its own: it's drawn in the terminal's text colour, like the brand's ink app icon, so it's white
 * on a dark terminal and near-black on a light one.
 */
// Every character is one UTF-16 unit, so .length is the width in columns.
export const CLOUD = [
  '           ▄█████▄▄',
  '         ▄█▀     ▀▀█▄',
  '    ▄█████▀        ▀█▄',
  '   ██               ██',
  '  ▄██               █▀',
  ' ██▀  ██           ▀█▄▄',
  '██                   ▀█▄',
  '██   ▀▄▄▀             ██',
  ' ██▄                 ▄█▀',
  '  ▀▀█████████████████▀',
];

/** The brand line under the name. */
export const TAGLINE = 'Your crew, ready for work.';

const CLOUD_WIDTH = Math.max(...CLOUD.map((line) => line.length));

/** The columns the cloud and the words beside it need. */
export const WELCOME_WIDTH = CLOUD_WIDTH + 3 + TAGLINE.length;

/**
 * Whether to draw the cloud: only in a terminal wide enough for it and the words beside it.
 * Piped into a file or another program, or read out by a screen reader, it would only be
 * noise. `columns` is undefined when the output isn't a terminal.
 */
export function showCloud(columns: number | undefined): boolean {
  return columns !== undefined && columns >= WELCOME_WIDTH;
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export interface WelcomeStatus {
  mark: '✓' | '!' | '-';
  text: string;
}

interface WelcomeOptions {
  version: string;
  status: WelcomeStatus[];
  color: boolean;
  /** Ends with the commands to try next. On by default. */
  hints?: boolean;
  /** Draws the cloud. On by default; see showCloud for when to leave it out. */
  cloud?: boolean;
}

/** The welcome screen: the cloud with the name and tagline beside it, then the install's status. */
export function renderWelcome(options: WelcomeOptions): string {
  return renderWelcomeHead(options) + renderWelcomeTail(options);
}

/** The row of the cloud with the eye in it, and the eye's columns. */
const EYE = { row: 5, from: 6, to: 8 } as const;

function cloudRow(options: Pick<WelcomeOptions, 'version' | 'color'>, row: number, line: string) {
  const paint = (code: string, text: string) => (options.color ? `${code}${text}${RESET}` : text);
  const beside: Record<number, string> = {
    4: paint(BOLD, 'wheems') + ' ' + paint(DIM, options.version),
    5: TAGLINE,
  };
  const text = beside[row];
  return text === undefined ? line : `${line.padEnd(CLOUD_WIDTH)}   ${text}`;
}

/** The top of the welcome screen: the cloud and the words beside it, or just the words. */
export function renderWelcomeHead(options: Omit<WelcomeOptions, 'status'>): string {
  const paint = (code: string, text: string) => (options.color ? `${code}${text}${RESET}` : text);
  const lines =
    options.cloud === false
      ? [paint(BOLD, 'wheems') + ' ' + paint(DIM, options.version), TAGLINE]
      : CLOUD.map((line, row) => cloudRow(options, row, line));
  return ['', ...lines].join('\n') + '\n';
}

/** The rest of the welcome screen: the install's status and the commands to try. */
export function renderWelcomeTail(options: Omit<WelcomeOptions, 'version' | 'cloud'>): string {
  const paint = (code: string, text: string) => (options.color ? `${code}${text}${RESET}` : text);
  const marks = { '✓': '\x1b[32m', '!': '\x1b[33m', '-': DIM } as const;
  return [
    '',
    ...options.status.map((s) => `${paint(marks[s.mark], s.mark)} ${s.text}`),
    ...(options.status.length > 0 ? [''] : []),
    ...(options.hints === false
      ? []
      : [paint(DIM, 'wheems setup · wheems doctor · wheems --help'), '']),
  ].join('\n');
}

/**
 * Whether the cloud may wink: only when it's drawn, so in a wide enough terminal, and not in
 * CI, a dumb terminal, or for someone who has set WHEEMS_NO_ANIMATION.
 */
export function canWink(columns: number | undefined, env: NodeJS.ProcessEnv): boolean {
  return (
    showCloud(columns) &&
    env.TERM !== 'dumb' &&
    (env.CI ?? '') === '' &&
    (env.WHEEMS_NO_ANIMATION ?? '') === ''
  );
}

/** How long the eye stays open before the wink, and how long it stays shut. */
export const WINK_TIMING = { before: 400, shut: 150 } as const;

/**
 * The cloud winks once: run straight after renderWelcomeHead is written, with the cursor on the
 * line under the cloud. It redraws only the eye's row, hides the cursor meanwhile and always
 * shows it again.
 */
export async function wink(options: {
  version: string;
  color: boolean;
  write: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const up = CLOUD.length - EYE.row;
  const open = CLOUD[EYE.row] ?? '';
  const shut = open.slice(0, EYE.from) + '▄▄' + open.slice(EYE.to);
  // Up to the eye's row, clear it, draw it again, and back down to where the cursor was.
  const redraw = (line: string) => {
    options.write(
      `\x1b[${String(up)}A\r\x1b[2K${cloudRow(options, EYE.row, line)}\x1b[${String(up)}B\r`,
    );
  };
  options.write(HIDE_CURSOR);
  try {
    await sleep(WINK_TIMING.before);
    redraw(shut);
    await sleep(WINK_TIMING.shut);
    redraw(open);
  } finally {
    options.write(SHOW_CURSOR);
  }
}

export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';

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
      : { mark: '!', text: "The service isn't running: wheems start" },
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
