import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Wheems keeps things. Config lives in the install folder (`~/wheems`, a git
 * folder). Running state lives in its `.wheems/` folder, which is never committed.
 * Secrets live outside both, in `~/.config/wheems/`.
 */
export interface Paths {
  home: string;
  install: string;
  workspaces: string;
  /** Running state: conversations, the control socket, logs. Git-ignored. */
  state: string;
  conversations: string;
  socket: string;
  logs: string;
  /** The knowledge bases' search indexes, rebuildable from the files. */
  index: string;
  /** Holds the `wheems` command that agents run, pinned to this Node.js. */
  bin: string;
  secrets: string;
  /** The page about the person, which every agent in every workspace reads. */
  aboutYou: string;
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.WHEEMS_HOME && env.WHEEMS_HOME.length > 0
    ? env.WHEEMS_HOME
    : join(homedir(), 'wheems');
}

export function paths(home: string, env: NodeJS.ProcessEnv = process.env): Paths {
  const state = join(home, '.wheems');
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), '.config');
  return {
    home,
    install: join(home, 'install.yaml'),
    workspaces: join(home, 'workspaces'),
    aboutYou: join(home, 'about-you.md'),
    state,
    conversations: join(state, 'conversations.json'),
    socket: join(state, 'wheems.sock'),
    logs: join(state, 'logs'),
    index: join(state, 'index'),
    bin: join(state, 'bin'),
    secrets:
      env.WHEEMS_SECRETS && env.WHEEMS_SECRETS.length > 0
        ? env.WHEEMS_SECRETS
        : join(configHome, 'wheems', 'secrets.json'),
  };
}

/** A path under the person's home folder written with ~, as they'd type it. */
export function tilde(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME;
  return home !== undefined && home !== '' && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}
