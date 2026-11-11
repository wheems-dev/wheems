import { z } from 'zod';
import { DriverError } from '../contracts/driver.js';
import { DriverRegistry } from '../contracts/registry.js';
import { SlackChannel } from './channel/slack/slack-channel.js';
import { SocketModeTransport } from './channel/slack/transport.js';
import { ClaudeCodeEngine } from './engine/claude-code.js';
import { HerdrRuntime } from './runtime/herdr/herdr-runtime.js';

const herdrOptions = z.strictObject({
  binary: z.string().min(1).optional(),
  minimumVersion: z.string().optional(),
});

const slackOptions = z.object({
  bot_token: z.string().startsWith('xoxb-', 'The bot token starts with xoxb-'),
  app_token: z.string().startsWith('xapp-', 'The app-level token starts with xapp-'),
});

function parse<T>(driver: string, schema: z.ZodType<T>, options: Record<string, unknown>): T {
  const parsed = schema.safeParse(options);
  if (!parsed.success) {
    throw new DriverError(
      driver,
      'invalid',
      `Invalid ${driver} options: ${z.prettifyError(parsed.error)}`,
      {
        hint: driver === 'slack' ? 'Run opinr setup to enter the Slack tokens.' : undefined,
      },
    );
  }
  return parsed.data;
}

/** A registry with every built-in driver. */
export function createDriverRegistry(): DriverRegistry {
  return new DriverRegistry()
    .register('runtime', 'herdr', (options) => {
      const { binary, minimumVersion } = parse('herdr', herdrOptions, options);
      return new HerdrRuntime({
        ...(binary !== undefined && { binary }),
        ...(minimumVersion !== undefined && { minimumVersion }),
      });
    })
    .register('engine', 'claude-code', () => new ClaudeCodeEngine())
    .register('channel', 'slack', (options) => {
      const tokens = parse('slack', slackOptions, options);
      return new SlackChannel(
        new SocketModeTransport({ botToken: tokens.bot_token, appToken: tokens.app_token }),
      );
    });
}
