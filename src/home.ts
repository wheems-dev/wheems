import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Opinr keeps things. Config lives in the install folder (`~/opinr`, a git
 * folder). Running state lives in its `.opinr/` folder, which is never committed.
 * Secrets live outside both, in `~/.config/opinr/`.
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
  /** Holds the `opinr` command that agents run, pinned to this Node.js. */
  bin: string;
  secrets: string;
  /** The page about the person, which every agent in every workspace reads. */
  aboutYou: string;
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPINR_HOME && env.OPINR_HOME.length > 0 ? env.OPINR_HOME : join(homedir(), 'opinr');
}

export function paths(home: string, env: NodeJS.ProcessEnv = process.env): Paths {
  const state = join(home, '.opinr');
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
    socket: join(state, 'opinr.sock'),
    logs: join(state, 'logs'),
    bin: join(state, 'bin'),
    secrets:
      env.OPINR_SECRETS && env.OPINR_SECRETS.length > 0
        ? env.OPINR_SECRETS
        : join(configHome, 'opinr', 'secrets.json'),
  };
}
