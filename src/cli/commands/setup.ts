import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  slackManifest,
  slackMemberName,
  verifySlackTokens,
  type SlackIdentity,
} from '../../drivers/channel/slack/setup.js';
import { paths } from '../../home.js';
import { readSecrets, writeSecret } from '../../secrets.js';
import { runCommand } from '../../util/process.js';
import type { Prompter } from '../prompt.js';
import { INSTALL_GITIGNORE, installYaml } from '../templates.js';

export interface SetupOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  prompter: Prompter;
  out: (text: string) => void;
  /** Slack checks, replaceable in tests. */
  verifyTokens?: (botToken: string, appToken: string) => Promise<SlackIdentity>;
  memberName?: (botToken: string, userId: string) => Promise<string>;
}

/**
 * Creates the install folder if needed, connects the Slack app and records who may
 * talk to agents. Tokens are typed in here by the person, saved to a private file,
 * and never pass through an agent.
 */
export async function setup(options: SetupOptions): Promise<void> {
  const { home, prompter, out } = options;
  const where = paths(home, options.env);
  const verify = options.verifyTokens ?? verifySlackTokens;
  const memberName = options.memberName ?? slackMemberName;

  if (!(await exists(where.install))) {
    await mkdir(home, { recursive: true });
    await writeFile(where.install, installYaml());
    await writeFile(join(home, '.gitignore'), INSTALL_GITIGNORE);
    if (!(await exists(join(home, '.git')))) await runCommand('git', ['init', '--quiet', home]);
    out(`Created the install at ${home}\n`);
  } else {
    out(`Using the install at ${home}\n`);
  }

  const secrets = await readSecrets(where.secrets);
  let botToken = secrets.slack?.bot_token;
  let appToken = secrets.slack?.app_token;
  let identity: SlackIdentity | undefined;
  if (botToken !== undefined && appToken !== undefined) {
    try {
      identity = await verify(botToken, appToken);
      const keep = await prompter.ask(
        `Slack is connected as ${identity.botUser} in ${identity.team}. Keep it? [Y/n] `,
      );
      if (/^n/i.test(keep)) identity = undefined;
    } catch (error) {
      out(`The saved Slack tokens no longer work: ${(error as Error).message}\n`);
      identity = undefined;
    }
  }

  if (!identity) {
    const manifestFile = join(where.state, 'slack-app-manifest.yaml');
    await mkdir(where.state, { recursive: true });
    await writeFile(manifestFile, slackManifest());
    out(
      [
        '',
        'Connect Slack: one app serves every workspace.',
        '  1. Open https://api.slack.com/apps?new_app=1, choose "From a manifest", pick your Slack workspace,',
        `     and paste the manifest from ${manifestFile} (or run: opinr slack manifest).`,
        '  2. Install the app to the workspace. Copy the "Bot User OAuth Token" (xoxb-…).',
        '  3. Under Basic Information, App-Level Tokens, generate a token with the connections:write scope (xapp-…).',
        '',
      ].join('\n') + '\n',
    );
    for (;;) {
      botToken = await prompter.ask('Bot token (xoxb-…): ', { secret: true });
      appToken = await prompter.ask('App-level token (xapp-…): ', { secret: true });
      try {
        identity = await verify(botToken, appToken);
        break;
      } catch (error) {
        out(`${(error as Error).message}\nTry again, or press Ctrl+C to stop.\n`);
      }
    }
    await writeSecret(where.secrets, 'slack', { bot_token: botToken, app_token: appToken });
    out(
      `Slack connected as ${identity.botUser} in ${identity.team}. Tokens saved to ${where.secrets}\n`,
    );
  }
  if (botToken === undefined) throw new Error('No Slack bot token');

  const doc = parseDocument(await readFile(where.install, 'utf8'));
  const current = doc.getIn(['connections', 'slack', 'allowed_users']) as
    { toJSON(): unknown } | undefined;
  const allowed = (current?.toJSON() as string[] | undefined) ?? [];
  if (allowed.length === 0) {
    out(
      '\nOnly people on the allowed list can talk to your agents. In Slack, open your profile, choose ⋯, then "Copy member ID".\n',
    );
    for (;;) {
      const id = await prompter.ask('Your Slack member ID (U…): ');
      try {
        const name = await memberName(botToken, id);
        doc.setIn(['connections', 'slack', 'allowed_users'], [id]);
        await writeFile(where.install, doc.toString());
        out(`Allowed: ${name} (${id})\n`);
        break;
      } catch (error) {
        out(`${(error as Error).message}\n`);
      }
    }
  } else {
    out(`Allowed Slack members: ${allowed.join(', ')}\n`);
  }

  out(
    [
      '',
      'Next:',
      "  opinr init personal        create the Personal workspace, chatting in the bot's direct messages",
      '  opinr service install      run the service in the background, now and at login',
      '  opinr doctor               check everything',
      '',
    ].join('\n') + '\n',
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
