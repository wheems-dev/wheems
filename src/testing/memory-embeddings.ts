import { DriverError, type HealthCheck } from '../contracts/driver.js';
import type { EmbeddingPurpose, EmbeddingsDriver } from '../contracts/embeddings.js';

export interface HashEmbeddingsOptions {
  model?: string;
  dimensions?: number;
  /**
   * Words that mean the same, mapped to one word, such as `{ vessel: 'boat' }`. Texts that
   * share a meaning then come out close together, as with a real model.
   */
  synonyms?: Record<string, string>;
  /** Defaults to 0.2: texts with no words in common score near 0. */
  minimumSimilarity?: number;
  /** Leave unset to have skill proposals compared by their words instead. */
  nearDuplicate?: number;
}

/**
 * An embeddings driver for tests: each word is hashed into one of a few dimensions, so texts
 * with words in common come out close together. Deterministic, instant and offline.
 * `fail()` makes it throw as an unreachable service would, until `recover()`.
 */
export class HashEmbeddings implements EmbeddingsDriver {
  readonly kind = 'embeddings' as const;
  readonly name = 'hash';
  readonly model: string;
  readonly dimensions: number;
  readonly minimumSimilarity: number;
  readonly nearDuplicate: number | undefined;
  /** Every call, for tests to inspect. */
  readonly calls: { texts: string[]; purpose: EmbeddingPurpose }[] = [];
  private readonly synonyms: Record<string, string>;
  private failing: string | null = null;

  constructor(options: HashEmbeddingsOptions = {}) {
    this.model = options.model ?? 'hash-64';
    this.dimensions = options.dimensions ?? 64;
    this.synonyms = options.synonyms ?? {};
    this.minimumSimilarity = options.minimumSimilarity ?? 0.2;
    this.nearDuplicate = options.nearDuplicate;
  }

  fail(message = 'The embeddings service is not answering'): void {
    this.failing = message;
  }

  recover(): void {
    this.failing = null;
  }

  embed(texts: string[], purpose: EmbeddingPurpose): Promise<Float32Array[]> {
    if (this.failing !== null)
      return Promise.reject(new DriverError(this.name, 'unavailable', this.failing));
    this.calls.push({ texts: [...texts], purpose });
    return Promise.resolve(texts.map((text) => this.vector(text)));
  }

  check(): Promise<HealthCheck[]> {
    return Promise.resolve([
      this.failing === null
        ? { name: 'hash embeddings', status: 'pass', message: `${this.model} is ready` }
        : { name: 'hash embeddings', status: 'warn', message: this.failing },
    ]);
  }

  private vector(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const word = this.synonyms[raw] ?? raw;
      let hash = 2166136261;
      for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619);
      const index = (hash >>> 0) % this.dimensions;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    // Text with no words still gets a vector that isn't all zeros.
    if (vector.every((x) => x === 0)) vector[0] = 1;
    return vector;
  }
}
