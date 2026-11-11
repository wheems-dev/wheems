import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConnectContext,
  ConnectFlow,
  ConnectResult,
  SetupUi,
} from '../../../contracts/setup.js';
import { slackManifest, slackMemberName, verifySlackTokens, type SlackIdentity } from './setup.js';

const NEW_APP_URL = 'https://api.slack.com/apps?new_app=1';

export interface SlackConnectOptions {
  /** Slack checks, replaceable in tests. */
  verifyTokens?: (botToken: string, appToken: string) => Promise<SlackIdentity>;
  memberName?: (botToken: string, userId: string) => Promise<string>;
}

/**
 * Connects the one Slack app every workspace shares: create it from a manifest, paste
 * its two tokens (checked with Slack), and say who may talk to agents.
 */
export function slackConnectFlow(options: SlackConnectOptions = {}): ConnectFlow {
  const verify = options.verifyTokens ?? verifySlackTokens;
  const memberName = options.memberName ?? slackMemberName;

  return {
    async connect(ui: SetupUi, context: ConnectContext): Promise<ConnectResult> {
      let secret = context.existing;
      if (secret?.bot_token !== undefined && secret.app_token !== undefined) {
        const { bot_token: bot, app_token: app } = secret;
        try {
          const identity = await ui.task(
            'Checking the saved Slack app',
            () => verify(bot, app),
            (id) => `Connected as ${id.botUser} in ${id.team}`,
          );
          if (!(await ui.confirm(`Keep using ${identity.botUser} in ${identity.team}?`, true))) {
            secret = undefined;
          }
        } catch (error) {
          ui.warn(`The saved tokens no longer work: ${(error as Error).message}`);
          secret = undefined;
        }
      } else {
        secret = undefined;
      }

      const replaced = secret === undefined;
      if (secret === undefined) secret = await newTokens(ui, context, verify);
      const botToken = secret.bot_token ?? '';

      let allowedUsers = context.allowedUsers;
      if (replaced && allowedUsers.length > 0) {
        // New tokens may be for another Slack workspace, where these member ids mean nothing.
        const still = await ui.task(
          'Checking who may talk to agents in this Slack workspace',
          async () => {
            const found: string[] = [];
            for (const id of allowedUsers) {
              if (
                await memberName(botToken, id).then(
                  () => true,
                  () => false,
                )
              )
                found.push(id);
            }
            return found;
          },
          (found) =>
            found.length === allowedUsers.length
              ? 'Everyone allowed before is in this Slack workspace'
              : `${String(allowedUsers.length - found.length)} allowed member(s) aren't in this Slack workspace`,
        );
        allowedUsers = still;
      }
      if (allowedUsers.length === 0) {
        ui.note(
          [
            'Only people on the allowed list can talk to your agents; everyone else is ignored.',
            'In Slack, open your profile, choose ⋯ (More), then "Copy member ID".',
          ].join('\n'),
          'Who may talk to your agents',
        );
        for (;;) {
          const id = await ui.text({
            message: 'Your Slack member ID',
            placeholder: 'U012ABCDEF',
            validate: (value) =>
              /^[UW][A-Z0-9]{6,}$/.test(value.trim())
                ? undefined
                : 'A member ID starts with U or W, then letters and digits',
          });
          try {
            await ui.task(
              'Looking you up in Slack',
              () => memberName(botToken, id.trim()),
              (found) => `Allowed: ${found}`,
            );
            allowedUsers = [id.trim()];
            break;
          } catch (error) {
            ui.warn((error as Error).message);
          }
        }
      } else {
        ui.info(`Allowed to talk to agents: ${allowedUsers.join(', ')}`);
      }
      return { secret, allowedUsers };
    },
  };
}

async function newTokens(
  ui: SetupUi,
  context: ConnectContext,
  verify: (botToken: string, appToken: string) => Promise<SlackIdentity>,
): Promise<Record<string, string>> {
  await mkdir(context.stateDir, { recursive: true });
  const manifestFile = join(context.stateDir, 'slack-app-manifest.yaml');
  await writeFile(manifestFile, slackManifest());
  const copied = await context.copy(slackManifest());
  ui.note(
    [
      'One Slack app serves every workspace, so you do this once.',
      '',
      `1. At ${NEW_APP_URL}, choose "From a manifest" and pick your Slack workspace.`,
      copied
        ? '2. Paste the manifest: it is on your clipboard.'
        : `2. Paste the manifest from ${manifestFile}`,
      '3. Install the app to the workspace, then copy the Bot User OAuth Token (xoxb-…).',
      '4. Under Basic Information → App-Level Tokens, generate a token with the',
      '   connections:write scope (xapp-…).',
      '',
      'It uses Socket Mode, so it needs no public address.',
    ].join('\n'),
    'Create the Slack app',
  );
  if (await ui.confirm('Open the Slack app page in your browser?', true)) {
    if (!(await context.openUrl(NEW_APP_URL))) ui.info(`Open ${NEW_APP_URL} in your browser.`);
  }
  for (;;) {
    const botToken = await ui.secret({
      message: 'Bot User OAuth Token',
      validate: (value) =>
        value.trim().startsWith('xoxb-') ? undefined : 'The bot token starts with xoxb-',
    });
    const appToken = await ui.secret({
      message: 'App-Level Token',
      validate: (value) =>
        value.trim().startsWith('xapp-') ? undefined : 'The app-level token starts with xapp-',
    });
    try {
      await ui.task(
        'Checking the tokens with Slack',
        () => verify(botToken.trim(), appToken.trim()),
        (id) => `Connected as ${id.botUser} in ${id.team}`,
      );
      return { bot_token: botToken.trim(), app_token: appToken.trim() };
    } catch (error) {
      ui.warn((error as Error).message);
      if (!(await ui.confirm('Try the tokens again?', true))) throw error;
    }
  }
}
