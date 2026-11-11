import { WebClient } from '@slack/web-api';
import { slackError } from './slack-channel.js';

/** The Slack app manifest: Socket Mode, so no public URL is needed. One app serves every workspace. */
export function slackManifest(name = 'Opinr'): string {
  return `display_information:
  name: ${name}
  description: Your agents' chief of staff, from Opinr.
  background_color: "#2c2d30"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: ${name}
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize
      - im:history
      - im:read
      - im:write
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
      - message.channels
      - message.groups
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;
}

export interface SlackIdentity {
  team: string;
  botUser: string;
}

/** Checks both tokens against Slack. Throws a readable error for a bad one. */
export async function verifySlackTokens(
  botToken: string,
  appToken: string,
): Promise<SlackIdentity> {
  let identity: SlackIdentity;
  try {
    const auth = await new WebClient(botToken).auth.test();
    identity = { team: String(auth.team), botUser: String(auth.user) };
  } catch (error) {
    throw new Error(`Slack refused the bot token: ${slackError(error)}`, { cause: error });
  }
  try {
    await new WebClient(appToken).apps.connections.open();
  } catch (error) {
    throw new Error(
      `Slack refused the app-level token: ${slackError(error)}. It needs the connections:write scope.`,
      { cause: error },
    );
  }
  return identity;
}

/** The display name of a Slack member, to confirm the member id is right. */
export async function slackMemberName(botToken: string, userId: string): Promise<string> {
  try {
    const info = await new WebClient(botToken).users.info({ user: userId });
    const user = info.user;
    return user?.real_name ?? user?.name ?? userId;
  } catch (error) {
    throw new Error(`Slack has no member ${userId}: ${slackError(error)}`, { cause: error });
  }
}
