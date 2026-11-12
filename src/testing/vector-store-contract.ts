import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VectorStoreDriver } from '../contracts/vector-store.js';
import { expectDriverError, expectHealthCheck } from './runtime-contract.js';

export interface VectorStoreContractOptions {
  create: () => VectorStoreDriver | Promise<VectorStoreDriver>;
  teardown?: () => void | Promise<void>;
  /** Whether a collection keeps its vectors when opened again; true for any real store. */
  persistent?: boolean;
}

const v = (...xs: number[]) => Float32Array.from(xs);

/**
 * The vector store contract test suite. Every vector store driver must pass it.
 *
 *   vectorStoreContract('my-store', { create: () => new MyStore() });
 */
export function vectorStoreContract(label: string, options: VectorStoreContractOptions): void {
  describe(`vector store contract: ${label}`, () => {
    let driver: VectorStoreDriver;
    const prefix = `contract.${Math.random().toString(36).slice(2, 8)}`;
    let counter = 0;
    const nextName = () => `${prefix}-${String(++counter)}`;

    beforeAll(async () => {
      driver = await options.create();
    });

    afterAll(async () => {
      for (let i = 1; i <= counter; i++) await driver.drop(`${prefix}-${String(i)}`);
      await options.teardown?.();
    });

    it('identifies itself as a vector store driver', () => {
      expect(driver.kind).toBe('vector-store');
      expect(driver.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    });

    it('returns well-formed health checks', async () => {
      const checks = await driver.check();
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) expectHealthCheck(check);
    });

    it('finds the nearest vectors by cosine similarity, most similar first', async () => {
      const collection = await driver.open(nextName());
      await collection.upsert([
        { id: 'east', vector: v(1, 0, 0) },
        { id: 'north', vector: v(0, 1, 0) },
        { id: 'north-east', vector: v(3, 3, 0) },
        { id: 'west', vector: v(-2, 0, 0) },
      ]);
      expect(await collection.count()).toBe(4);
      const matches = await collection.nearest(v(10, 1, 0), 3);
      expect(matches.map((m) => m.id)).toEqual(['east', 'north-east', 'north']);
      expect(matches[0]?.score).toBeCloseTo(10 / Math.sqrt(101), 4);
      const all = await collection.nearest(v(1, 0, 0), 10);
      expect(all).toHaveLength(4);
      expect(all.at(-1)).toMatchObject({ id: 'west' });
      expect(all.at(-1)?.score).toBeCloseTo(-1, 4);
      await collection.close();
    });

    it('replaces a vector with the same id, and removes by id', async () => {
      const collection = await driver.open(nextName());
      await collection.upsert([
        { id: 'a', vector: v(1, 0) },
        { id: 'b', vector: v(0, 1) },
      ]);
      await collection.upsert([{ id: 'a', vector: v(0, 1) }]);
      expect(await collection.count()).toBe(2);
      expect((await collection.nearest(v(1, 0), 1))[0]?.score).toBeCloseTo(0, 4);
      await collection.remove(['a', 'missing']);
      expect(await collection.count()).toBe(1);
      expect((await collection.nearest(v(0, 1), 5)).map((m) => m.id)).toEqual(['b']);
      await collection.clear();
      expect(await collection.count()).toBe(0);
      expect(await collection.nearest(v(0, 1), 5)).toEqual([]);
      await collection.close();
    });

    it('refuses a vector of another length', async () => {
      const collection = await driver.open(nextName());
      await collection.upsert([{ id: 'a', vector: v(1, 0, 0) }]);
      await expectDriverError(collection.upsert([{ id: 'b', vector: v(1, 0) }]), 'invalid');
      expect(await collection.count()).toBe(1);
      await collection.close();
    });

    it('refuses an invalid collection name', async () => {
      await expectDriverError(driver.open('Not Valid!'), 'invalid');
    });

    it('keeps collections apart, and drop removes one', async () => {
      const first = nextName();
      const second = nextName();
      const a = await driver.open(first);
      const b = await driver.open(second);
      await a.upsert([{ id: 'x', vector: v(1, 1) }]);
      expect(await b.count()).toBe(0);
      await a.close();
      await b.close();
      await driver.drop(first);
      await driver.drop('never-made');
      const reopened = await driver.open(first);
      expect(await reopened.count()).toBe(0);
      await reopened.close();
    });

    it.skipIf(options.persistent === false)(
      'keeps vectors when a collection is opened again',
      async () => {
        const name = nextName();
        const collection = await driver.open(name);
        await collection.upsert([{ id: 'kept', vector: v(0.5, 0.25) }]);
        await collection.close();
        const again = await driver.open(name);
        expect(await again.count()).toBe(1);
        expect((await again.nearest(v(2, 1), 1))[0]).toMatchObject({ id: 'kept' });
        await again.close();
      },
    );
  });
}
