import { z } from 'zod';
import { DriverError } from '../contracts/driver.js';
import { DriverRegistry } from '../contracts/registry.js';
import { slackConnectFlow } from './channel/slack/connect.js';
import { slackManifest } from './channel/slack/setup.js';
import { SlackChannel } from './channel/slack/slack-channel.js';
import { SocketModeTransport } from './channel/slack/transport.js';
import { OllamaEmbeddings, ollamaSetup } from './embeddings/ollama.js';
import { ClaudeCodeEngine, claudeCodeSetup } from './engine/claude-code.js';
import { CodexEngine, codexSetup } from './engine/codex.js';
import { OpencodeEngine, opencodeSetup } from './engine/opencode.js';
import { HerdrRuntime } from './runtime/herdr/herdr-runtime.js';
import { SqliteVectorStore } from './vector-store/sqlite.js';

const herdrOptions = z.strictObject({
  binary: z.string().min(1).optional(),
  minimumVersion: z.string().optional(),
});

const slackOptions = z.object({
  bot_token: z.string().startsWith('xoxb-', 'The bot token starts with xoxb-'),
  app_token: z.string().startsWith('xapp-', 'The app-level token starts with xapp-'),
});

const ollamaOptions = z.strictObject({
  model: z.string().min(1).optional(),
  url: z.url().optional(),
});

const sqliteOptions = z.object({
  dir: z.string().min(1),
});

function parse<T>(driver: string, schema: z.ZodType<T>, options: Record<string, unknown>): T {
  const parsed = schema.safeParse(options);
  if (!parsed.success) {
    throw new DriverError(
      driver,
      'invalid',
      `Invalid ${driver} options: ${z.prettifyError(parsed.error)}`,
      {
        hint: driver === 'slack' ? 'Run wheems setup to enter the Slack tokens.' : undefined,
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
    .register('engine', 'claude-code', () => new ClaudeCodeEngine(), {
      label: 'Claude Code',
      description: "Anthropic's coding agent, on a Claude subscription",
      engine: claudeCodeSetup(),
    })
    .register('engine', 'codex', () => new CodexEngine(), {
      label: 'Codex',
      description: "OpenAI's coding agent, on a ChatGPT subscription",
      engine: codexSetup(),
    })
    .register('engine', 'opencode', () => new OpencodeEngine(), {
      label: 'opencode',
      description: 'any model, through OpenRouter, a provider key or its free models',
      engine: opencodeSetup(),
    })
    .register(
      'channel',
      'slack',
      (options) => {
        const tokens = parse('slack', slackOptions, options);
        return new SlackChannel(
          new SocketModeTransport({ botToken: tokens.bot_token, appToken: tokens.app_token }),
        );
      },
      {
        label: 'Slack',
        description: 'chat with your agents in Slack',
        connect: slackConnectFlow(),
        manifest: () => slackManifest(),
      },
    )
    .register(
      'embeddings',
      'ollama',
      (options) => {
        const { model, url } = parse('ollama', ollamaOptions, options);
        return new OllamaEmbeddings({
          ...(model !== undefined && { model }),
          ...(url !== undefined && { url }),
        });
      },
      {
        label: 'Ollama',
        description: 'runs an embedding model on this machine, free',
        embeddings: ollamaSetup(),
      },
    )
    .register('vector-store', 'sqlite', (options) => {
      const { dir } = parse('sqlite', sqliteOptions, options);
      return new SqliteVectorStore({ dir });
    })
    .plan('embeddings', 'openai', {
      label: 'OpenAI',
      description: "OpenAI's embedding models, with an API key",
    })
    .plan('vector-store', 'pgvector', {
      label: 'pgvector',
      description: 'vectors in Postgres',
    })
    .plan('channel', 'telegram', {
      label: 'Telegram',
      description: 'chat with your agents in Telegram',
    });
}
