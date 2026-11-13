import { DriverError, type HealthCheck } from '../../contracts/driver.js';
import type {
  EmbeddingPurpose,
  EmbeddingsDriver,
  EmbeddingsSetup,
} from '../../contracts/embeddings.js';

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text';

export interface OllamaOptions {
  model?: string;
  /** Where Ollama answers. Defaults to http://127.0.0.1:11434. */
  url?: string;
  /** Milliseconds to wait for one batch of embeddings. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** How many texts go to Ollama in one request. */
const BATCH = 16;

/**
 * Embeddings from Ollama, which runs models on this machine for free. The default model,
 * nomic-embed-text, is small (274 MB) and good at search. It wants documents and queries
 * marked as such, which this driver does.
 */
export class OllamaEmbeddings implements EmbeddingsDriver {
  readonly kind = 'embeddings' as const;
  readonly name = 'ollama';
  readonly model: string;
  readonly minimumSimilarity: number | undefined;
  readonly nearDuplicate: number | undefined;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(options: OllamaOptions = {}) {
    this.model = options.model ?? OLLAMA_DEFAULT_MODEL;
    // Measured: related passages score 0.6 to 0.8 with nomic-embed-text, unrelated 0.4 to 0.55.
    this.minimumSimilarity = /nomic-embed/.test(this.model) ? 0.5 : undefined;
    // Measured on skills: near-duplicates 0.84 to 0.94, different tasks 0.57 to 0.75.
    this.nearDuplicate = /nomic-embed/.test(this.model) ? 0.8 : undefined;
    this.url = (options.url ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const input = texts.slice(start, start + BATCH).map((text) => this.prefix(purpose) + text);
      const body = (await this.call('/api/embed', { model: this.model, input })) as {
        embeddings?: unknown;
      };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) {
        throw new DriverError(this.name, 'failed', 'Ollama answered without the embeddings');
      }
      for (const vector of body.embeddings as unknown[]) {
        if (!Array.isArray(vector) || vector.length === 0)
          throw new DriverError(this.name, 'failed', 'Ollama answered with an empty embedding');
        vectors.push(Float32Array.from(vector as number[]));
      }
    }
    return vectors;
  }

  async check(): Promise<HealthCheck[]> {
    const models = await this.models();
    if (models === null) {
      return [
        {
          name: 'Ollama',
          status: 'warn',
          message: `Ollama isn't answering at ${this.url}, so search is keyword-only for now`,
          hint: 'Start the Ollama app, or run: ollama serve',
        },
      ];
    }
    if (!hasModel(models, this.model)) {
      return [
        {
          name: 'Ollama',
          status: 'warn',
          message: `Ollama doesn't have ${this.model}, so search is keyword-only for now`,
          hint: `Run: ollama pull ${this.model}`,
        },
      ];
    }
    return [{ name: 'Ollama', status: 'pass', message: `${this.model} is ready` }];
  }

  /** The models Ollama has, or null when it isn't answering. */
  async models(): Promise<string[] | null> {
    try {
      const response = await this.fetch(`${this.url}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { models?: { name?: unknown }[] };
      return (body.models ?? [])
        .map((m) => m.name)
        .filter((name): name is string => typeof name === 'string');
    } catch {
      return null;
    }
  }

  private prefix(purpose: EmbeddingPurpose): string {
    if (/nomic-embed/.test(this.model))
      return purpose === 'query' ? 'search_query: ' : 'search_document: ';
    return '';
  }

  private async call(path: string, payload: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DriverError(this.name, 'unavailable', `Ollama isn't answering at ${this.url}`, {
        hint: 'Start the Ollama app, or run: ollama serve',
        cause: error,
      });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const missing = response.status === 404 || /not found/i.test(text);
      throw new DriverError(
        this.name,
        missing ? 'unavailable' : 'failed',
        missing
          ? `Ollama doesn't have ${this.model}`
          : `Ollama answered ${String(response.status)}: ${text.slice(0, 200)}`,
        missing ? { hint: `Run: ollama pull ${this.model}` } : undefined,
      );
    }
    return response.json();
  }
}

/** Whether Ollama's list of models has this one; a name without a tag means `:latest`. */
export function hasModel(models: string[], model: string): boolean {
  const full = (name: string) => (name.includes(':') ? name : `${name}:latest`);
  return models.some((m) => full(m) === full(model));
}

/** What `wheems setup` needs to offer Ollama. */
export function ollamaSetup(url?: string): EmbeddingsSetup {
  return {
    defaultModel: OLLAMA_DEFAULT_MODEL,
    installHint:
      'Install Ollama from https://ollama.com (on a Mac: brew install ollama), start it, then come back here.',
    models: () => new OllamaEmbeddings({ ...(url !== undefined && { url }) }).models(),
    pull: (model) => ['ollama', 'pull', model],
  };
}
