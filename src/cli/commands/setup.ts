import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadInstall, type LoadedInstall } from '../../config/load.js';
import { nameSchema } from '../../config/schemas.js';
import type { DriverRegistry } from '../../contracts/registry.js';
import { SetupCancelled, type Choice, type SetupUi } from '../../contracts/setup.js';
import { paths, type Paths } from '../../home.js';
import { readSecrets, writeSecret } from '../../secrets.js';
import { runCommand } from '../../util/process.js';
import { INSTALL_GITIGNORE, installYaml } from '../templates.js';
import { initWorkspace } from './init.js';

/** Things setup does that reach outside the install folder, replaceable in tests. */
export interface SetupActions {
  /** Opens Claude Code in a folder so the person can answer its trust question. */
  trustFolder(dir: string): Promise<void>;
  /** Installs the background service and says whether it answers. */
  installService(): Promise<boolean>;
  /** Whether the background service is answering. */
  serviceRunning(): Promise<boolean>;
  /** Runs doctor and returns its report as text, and whether it passed. */
  doctor(): Promise<{ ok: boolean; report: string }>;
  /** Puts text on the clipboard; false where there is none. */
  copy(text: string): Promise<boolean>;
  /** Opens a web page in the browser; false where it can't. */
  openUrl(url: string): Promise<boolean>;
}

export interface SetupOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  ui: SetupUi;
  registry: DriverRegistry;
  actions: SetupActions;
}

type Section = 'channels' | 'workspaces' | 'service' | 'doctor' | 'done';

/**
 * Interactive setup: makes the install folder if there is none, then offers what can be
 * set up (channels, workspaces, the service) until the person is done. Each channel
 * driver brings its own connect flow.
 */
export async function setup(options: SetupOptions): Promise<void> {
  const { ui, home } = options;
  const where = paths(home, options.env);
  if (await ensureInstall(where)) ui.success(`Created your install at ${home}`);
  else ui.info(`Install: ${home}`);

  let next: Section = (await connectedChannels(options)).length === 0 ? 'channels' : 'workspaces';
  for (;;) {
    const install = await loadInstall(home);
    const connected = await connectedChannels(options);
    const running = await options.actions.serviceRunning();
    const section = await ui.select<Section>({
      message: 'What do you want to set up?',
      initial: next,
      choices: [
        {
          value: 'channels',
          label: 'Channels',
          hint:
            connected.length > 0
              ? `${connected.join(', ')} connected`
              : 'connect Slack to chat with your agents',
        },
        {
          value: 'workspaces',
          label: 'Workspaces',
          hint:
            install.workspaces.length > 0
              ? install.workspaces.map((w) => w.id).join(', ')
              : 'create one with its chief of staff',
        },
        {
          value: 'service',
          label: 'Service',
          hint: running ? 'running' : 'run Opinr in the background',
        },
        { value: 'doctor', label: 'Check everything', hint: 'opinr doctor' },
        { value: 'done', label: 'Done' },
      ],
    });
    if (section === 'done') return;
    try {
      if (section === 'channels')
        next = (await channels(options, where)) ? 'workspaces' : 'channels';
      if (section === 'workspaces')
        next = (await workspaces(options, install)) ? 'service' : 'workspaces';
      if (section === 'service') next = (await service(options)) ? 'doctor' : 'service';
      if (section === 'doctor') {
        const { ok, report } = await ui.task(
          'Checking everything',
          () => options.actions.doctor(),
          (r) => (r.ok ? 'Everything checks out' : 'Some checks need attention'),
        );
        ui.note(report.trimEnd(), 'opinr doctor');
        next = ok ? 'done' : 'doctor';
      }
    } catch (error) {
      if (error instanceof SetupCancelled) {
        ui.warn('Left that step; nothing from it was saved.');
        continue;
      }
      ui.warn(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Creates the install folder (a git folder) if there is none. Returns whether it did. */
export async function ensureInstall(where: Paths): Promise<boolean> {
  if (await exists(where.install)) return false;
  await mkdir(where.home, { recursive: true });
  await writeFile(where.install, installYaml());
  await writeFile(join(where.home, '.gitignore'), INSTALL_GITIGNORE);
  if (!(await exists(join(where.home, '.git'))))
    await runCommand('git', ['init', '--quiet', where.home]);
  return true;
}

async function channels(options: SetupOptions, where: Paths): Promise<boolean> {
  const { ui, registry } = options;
  const catalog = registry.catalog('channel');
  const secrets = await readSecrets(where.secrets);
  const driver = await ui.select({
    message: 'Which channel?',
    choices: catalog.map((entry): Choice<string> => ({
      value: entry.name,
      label: entry.label,
      hint: entry.available
        ? secrets[entry.name] !== undefined
          ? 'connected'
          : entry.description
        : 'coming in a later version',
      ...(!entry.available && { disabled: true }),
    })),
  });
  const entry = catalog.find((e) => e.name === driver);
  if (!entry?.connect) {
    ui.warn(`${entry?.label ?? driver} has nothing to set up yet.`);
    return false;
  }
  // One connection per channel driver, named after it: one Slack app serves every workspace.
  const connection = driver;
  const doc = parseDocument(await readFile(where.install, 'utf8'));
  const allowed = (
    doc.getIn(['connections', connection, 'allowed_users']) as { toJSON(): unknown } | undefined
  )?.toJSON();
  const result = await entry.connect.connect(ui, {
    existing: secrets[connection],
    allowedUsers: Array.isArray(allowed) ? (allowed as string[]) : [],
    stateDir: where.state,
    copy: (text) => options.actions.copy(text),
    openUrl: (url) => options.actions.openUrl(url),
  });
  await writeSecret(where.secrets, connection, result.secret);
  if (!doc.hasIn(['connections', connection])) {
    doc.setIn(
      ['connections', connection],
      doc.createNode({ driver, secret: connection, allowed_users: [] }),
    );
  }
  doc.setIn(
    ['connections', connection, 'allowed_users'],
    doc.createNode(result.allowedUsers, { flow: true }),
  );
  await writeFile(where.install, doc.toString());
  ui.success(`${entry.label} is connected. Its tokens are saved privately in ${where.secrets}`);
  return true;
}

async function workspaces(options: SetupOptions, install: LoadedInstall): Promise<boolean> {
  const { ui } = options;
  // Channels that are connected: a channel driver, with credentials saved.
  const secrets = await readSecrets(paths(options.home, options.env).secrets);
  const chatConnections = Object.entries(install.config?.connections ?? {})
    .filter(([, c]) =>
      options.registry.catalog('channel').some((e) => e.name === c.driver && e.available),
    )
    .filter(([name, c]) => secrets[c.secret ?? name] !== undefined)
    .map(([name]) => name);
  if (chatConnections.length === 0) {
    ui.warn('Connect a channel first, so you can talk to the workspace.');
    return false;
  }
  if (install.workspaces.length > 0) {
    ui.info(
      `Workspaces: ${install.workspaces.map((w) => `${w.id} (${w.config?.name ?? 'config problems'})`).join(', ')}`,
    );
  }
  const taken = new Set(install.workspaces.map((w) => w.id));
  const id = await ui.text({
    message: 'Workspace id',
    placeholder: taken.has('personal') ? 'acme' : 'personal',
    initial: taken.has('personal') ? '' : 'personal',
    validate: (value) =>
      !nameSchema.safeParse(value).success
        ? 'Use lowercase letters, digits and dashes'
        : taken.has(value)
          ? `${value} already exists`
          : undefined,
  });
  const name = await ui.text({
    message: 'Its name',
    initial: id.charAt(0).toUpperCase() + id.slice(1).replaceAll('-', ' '),
    validate: (value) => (value.trim() === '' ? 'Give it a name' : undefined),
  });
  const directTaken = install.workspaces.some((w) => {
    const chat = w.config?.channels.chat;
    return chat !== undefined && 'direct' in chat;
  });
  const place = directTaken
    ? 'channel'
    : await ui.select({
        message: 'Where will you chat with it?',
        choices: [
          {
            value: 'direct',
            label: "The app's direct messages",
            hint: 'private; one workspace can have them',
          },
          { value: 'channel', label: 'A channel', hint: 'invite the app to it' },
        ],
      });
  const channel =
    place === 'channel'
      ? await ui.text({
          message: 'Channel name',
          placeholder: `${id}-chat`,
          validate: (value) =>
            value.replace(/^#/, '').trim() === '' ? 'Give a channel name' : undefined,
        })
      : undefined;
  const dir = await initWorkspace({
    home: options.home,
    id,
    name: name.trim(),
    env: options.env,
    ...(channel !== undefined && { channel }),
  });
  ui.success(`Created ${dir}, with its chief of staff on Claude Code`);
  if (channel !== undefined) ui.info(`Invite the app to #${channel.replace(/^#/, '')} in Slack.`);
  ui.note(
    [
      'Claude Code asks once whether to trust a new folder, and nobody can answer that from Slack.',
      'Choose "Yes, I trust this folder", then press Ctrl+C twice to come back here.',
    ].join('\n'),
    'Trust the folder',
  );
  try {
    if (await ui.confirm('Open Claude Code there now?', true))
      await options.actions.trustFolder(dir);
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    // The workspace is made; only the trust step was skipped.
    ui.info(`The workspace is saved. Trust its folder later: cd ${dir} && claude`);
  }
  return true;
}

async function service(options: SetupOptions): Promise<boolean> {
  const { ui } = options;
  const running = await options.actions.serviceRunning();
  if (
    running &&
    !(await ui.confirm('The service is running. Restart it with the latest config?', true))
  ) {
    return true;
  }
  const answering = await ui.task(
    running ? 'Restarting the service' : 'Installing the service under launchd',
    () => options.actions.installService(),
    (ok) =>
      ok ? 'The service is running, now and at every login' : 'The service has not answered yet',
  );
  if (!answering) ui.warn('See what it says with: opinr service logs');
  return answering;
}

async function connectedChannels(options: SetupOptions): Promise<string[]> {
  const secrets = await readSecrets(paths(options.home, options.env).secrets);
  return options.registry
    .catalog('channel')
    .filter((entry) => entry.available && secrets[entry.name] !== undefined)
    .map((entry) => entry.label);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
