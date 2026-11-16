import { slackError } from './slack-channel.js';
import { quickClient, unreachable } from './transport.js';

/** The Slack app manifest: Socket Mode, so no public URL is needed. One app serves every workspace. */
export function slackManifest(name = 'Wheems'): string {
  return `display_information:
  name: ${name}
  description: Your agents' chief of staff, from Wheems.
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
      - member_joined_channel
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
    const auth = await quickClient(botToken).auth.test();
    identity = { team: String(auth.team), botUser: String(auth.user) };
  } catch (error) {
    offline(error);
    throw new Error(`Slack refused the bot token: ${slackError(error)}`, { cause: error });
  }
  try {
    await quickClient(appToken).apps.connections.open();
  } catch (error) {
    offline(error);
    throw new Error(
      `Slack refused the app-level token: ${slackError(error)}. It needs the connections:write scope.`,
      { cause: error },
    );
  }
  return identity;
}

/**
 * The display name of a Slack member, or null when Slack says there is no such member.
 * Any other failure (network, rate limit, permissions) throws: it says nothing about the member.
 */
export async function slackMemberName(botToken: string, userId: string): Promise<string | null> {
  try {
    const info = await quickClient(botToken).users.info({ user: userId });
    const user = info.user;
    return user?.real_name ?? user?.name ?? userId;
  } catch (error) {
    if (slackError(error) === 'user_not_found') return null;
    offline(error);
    throw new Error(`Couldn't look up ${userId} in Slack: ${slackError(error)}`, { cause: error });
  }
}

/** Throws a plain error when Slack couldn't be reached, so a token isn't blamed for the network. */
function offline(error: unknown): void {
  const reason = unreachable(error);
  if (reason !== null) {
    throw new Error(`Couldn't reach Slack (${reason}). Check this Mac's internet connection.`, {
      cause: error,
    });
  }
}
