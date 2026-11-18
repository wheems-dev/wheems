import { beforeAll, describe, expect, it } from 'bun:test';
import type { EmbeddingsDriver } from '../contracts/embeddings.js';
import { cosine } from '../contracts/vector-store.js';
import { expectHealthCheck } from './runtime-contract.js';

export interface EmbeddingsContractOptions {
  create: () => EmbeddingsDriver | Promise<EmbeddingsDriver>;
  /**
   * Whether the service behind the driver is there to embed with. Where it isn't (such as
   * CI without Ollama), only the checks that need no service run.
   */
  available?: boolean;
}

/**
 * The embeddings contract test suite. Every embeddings driver must pass it.
 *
 *   embeddingsContract('my-embeddings', { create: () => new MyEmbeddings() });
 */
export function embeddingsContract(label: string, options: EmbeddingsContractOptions): void {
  describe(`embeddings contract: ${label}`, () => {
    let driver: EmbeddingsDriver;

    beforeAll(async () => {
      driver = await options.create();
    });

    it('identifies itself as an embeddings driver with a model', () => {
      expect(driver.kind).toBe('embeddings');
      expect(driver.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(driver.model.length).toBeGreaterThan(0);
    });

    it('returns well-formed health checks', async () => {
      const checks = await driver.check();
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) expectHealthCheck(check);
    });

    it.skipIf(options.available === false)(
      'returns one vector per text, in order, all the same length',
      async () => {
        const texts = ['The boat is called Halcyon.', 'Invoices go out on Fridays.', 'Halcyon'];
        const vectors = await driver.embed(texts, 'document');
        expect(vectors).toHaveLength(texts.length);
        const length = vectors[0]?.length ?? 0;
        expect(length).toBeGreaterThan(0);
        for (const vector of vectors) {
          expect(vector).toBeInstanceOf(Float32Array);
          expect(vector).toHaveLength(length);
          expect(vector.every((x) => Number.isFinite(x))).toBe(true);
        }
        const [query] = await driver.embed(['Halcyon'], 'query');
        expect(query).toHaveLength(length);
      },
    );

    it.skipIf(options.available === false)('returns nothing for no texts', async () => {
      expect(await driver.embed([], 'document')).toEqual([]);
    });

    it.skipIf(options.available === false)(
      'puts a query nearer the text it is about than one it is not',
      async () => {
        const [about, other] = await driver.embed(
          ['The boat is called Halcyon, chosen over Kestrel.', 'Invoices go out every Friday.'],
          'document',
        );
        const [query] = await driver.embed(['what is the boat called'], 'query');
        if (!about || !other || !query) throw new Error('missing vectors');
        expect(cosine(query, about)).toBeGreaterThan(cosine(query, other));
      },
    );
  });
}
