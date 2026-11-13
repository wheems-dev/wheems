import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadInstall } from '../../config/load.js';
import { nameSchema } from '../../config/schemas.js';
import { paths } from '../../home.js';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { knowledgePaths } from '../../knowledge/notes.js';
import {
  BRIEF_MD,
  chiefOfStaffMd,
  DEFAULT_ENGINE,
  SKILLS_YAML,
  workspaceYaml,
  type EngineChoice,
} from '../templates.js';

export interface InitOptions {
  home: string;
  id: string;
  name?: string;
  /** A channel to chat in, instead of the bot's direct messages. */
  channel?: string;
  /** The engine the chief of staff runs in. Defaults to Claude Code. */
  engine?: EngineChoice;
  /** The install account's driver, added to install.yaml if the account isn't there. */
  accountDriver?: string;
  env?: NodeJS.ProcessEnv;
}

/** Creates a workspace with its chief of staff. Returns the workspace folder. */
export async function initWorkspace(options: InitOptions): Promise<string> {
  const where = paths(options.home, options.env);
  if (!nameSchema.safeParse(options.id).success) {
    throw new Error(
      `"${options.id}" is not a workspace name: use lowercase letters, digits and dashes`,
    );
  }
  try {
    await stat(where.install);
  } catch {
    throw new Error(`No install at ${options.home}. Run wheems setup first.`);
  }
  const dir = join(where.workspaces, options.id);
  try {
    await stat(dir);
    throw new Error(`Workspace ${options.id} already exists at ${dir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (options.channel === undefined) {
    const install = await loadInstall(options.home);
    const claimed = install.workspaces.find((w) => {
      const chat = w.config?.channels.chat;
      return chat !== undefined && chat.connection === 'slack' && 'direct' in chat;
    });
    if (claimed) {
      throw new Error(
        `Workspace ${claimed.id} already chats in the bot's direct messages. Give this one a channel with --channel <name>.`,
      );
    }
  }
  const channel = options.channel?.replace(/^#/, '').trim();
  if (channel === '') throw new Error('Give --channel a channel name or id');
  const name = options.name?.trim();
  if (name === '') throw new Error('Give --name a display name');
  const template = {
    id: options.id,
    name: name ?? options.id.charAt(0).toUpperCase() + options.id.slice(1).replaceAll('-', ' '),
    channel: channel ?? null,
    engine: options.engine ?? DEFAULT_ENGINE,
  };
  await ensureAccount(where.install, template.engine.account, options.accountDriver ?? 'claude');
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(join(dir, 'workspace.yaml'), workspaceYaml(template));
  await writeFile(join(dir, 'skills.yaml'), SKILLS_YAML);
  await writeFile(join(dir, 'agents', 'chief-of-staff.md'), chiefOfStaffMd(template));
  const knowledge = knowledgePaths(dir);
  for (const folder of [knowledge.inbox, knowledge.notes, knowledge.pages, knowledge.reports])
    await mkdir(folder, { recursive: true });
  await writeFile(knowledge.brief, BRIEF_MD);
  return dir;
}

/** Adds an account to install.yaml, keeping its comments, when it isn't there yet. */
async function ensureAccount(installFile: string, name: string, driver: string): Promise<void> {
  const doc = parseDocument(await readFile(installFile, 'utf8'));
  if (doc.hasIn(['accounts', name])) return;
  if (!doc.has('accounts')) doc.set('accounts', doc.createNode({}));
  doc.setIn(['accounts', name], doc.createNode({ driver }));
  await writeFile(installFile, doc.toString());
}
