import { DriverError, type HealthCheck } from '../contracts/driver.js';
import {
  COLLECTION_NAME,
  cosine,
  type VectorCollection,
  type VectorItem,
  type VectorMatch,
  type VectorStoreDriver,
} from '../contracts/vector-store.js';

/** A vector store that keeps everything in memory: the reference driver, for tests. */
export class MemoryVectorStore implements VectorStoreDriver {
  readonly kind = 'vector-store' as const;
  readonly name = 'memory';
  private readonly collections = new Map<string, Map<string, Float32Array>>();

  open(name: string): Promise<VectorCollection> {
    if (!COLLECTION_NAME.test(name)) {
      return Promise.reject(
        new DriverError(this.name, 'invalid', `"${name}" isn't a collection name`),
      );
    }
    let vectors = this.collections.get(name);
    if (!vectors) {
      vectors = new Map();
      this.collections.set(name, vectors);
    }
    return Promise.resolve(new MemoryCollection(name, vectors));
  }

  drop(name: string): Promise<void> {
    this.collections.get(name)?.clear();
    this.collections.delete(name);
    return Promise.resolve();
  }

  /** The names of the collections that exist, for tests. */
  names(): string[] {
    return [...this.collections.keys()].sort();
  }

  check(): Promise<HealthCheck[]> {
    return Promise.resolve([{ name: 'vector store', status: 'pass', message: 'In memory' }]);
  }
}

class MemoryCollection implements VectorCollection {
  constructor(
    readonly name: string,
    private readonly vectors: Map<string, Float32Array>,
  ) {}

  upsert(items: VectorItem[]): Promise<void> {
    const length = this.vectors.values().next().value?.length ?? items[0]?.vector.length;
    for (const item of items) {
      if (item.vector.length !== length || length === 0) {
        return Promise.reject(
          new DriverError(
            'memory',
            'invalid',
            `Vectors in ${this.name} have ${String(length)} numbers, not ${String(item.vector.length)}`,
          ),
        );
      }
    }
    for (const item of items) this.vectors.set(item.id, Float32Array.from(item.vector));
    return Promise.resolve();
  }

  remove(ids: string[]): Promise<void> {
    for (const id of ids) this.vectors.delete(id);
    return Promise.resolve();
  }

  nearest(vector: Float32Array, k: number): Promise<VectorMatch[]> {
    const matches = [...this.vectors]
      .filter(([, stored]) => stored.length === vector.length)
      .map(([id, stored]) => ({ id, score: cosine(stored, vector) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return Promise.resolve(matches.slice(0, Math.max(0, k)));
  }

  count(): Promise<number> {
    return Promise.resolve(this.vectors.size);
  }

  clear(): Promise<void> {
    this.vectors.clear();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
