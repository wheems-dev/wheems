import type { Driver, HealthCheck } from './driver.js';

/**
 * The vector store contract: keeps vectors by id and finds the nearest ones to a query.
 * Version one ships SQLite, which keeps them in a file beside the keyword index and
 * compares them in code: fast enough for thousands of pages. pgvector and Pinecone come
 * later as drivers of their own.
 *
 * A store holds named collections. Wheems uses one per workspace and index build, so a
 * rebuild fills a new collection and drops the old one only once the new one is in use.
 */
export interface VectorStoreDriver extends Driver<'vector-store'> {
  /**
   * Opens a collection, creating it when it doesn't exist. Names are lowercase letters,
   * digits, dots and dashes; anything else is refused with an `invalid` `DriverError`.
   */
  open(name: string): Promise<VectorCollection>;

  /** Removes a collection and everything in it. Does nothing when it doesn't exist. */
  drop(name: string): Promise<void>;

  /** Health checks for doctor. */
  check(): Promise<HealthCheck[]>;
}

export interface VectorCollection {
  readonly name: string;

  /**
   * Adds vectors, replacing any with the same id. Every vector in a collection has the
   * same length; one of another length is refused with an `invalid` `DriverError`.
   */
  upsert(items: VectorItem[]): Promise<void>;

  /** Removes vectors by id. Ids that aren't there are ignored. */
  remove(ids: string[]): Promise<void>;

  /**
   * The `k` stored vectors most like `vector` by cosine similarity, most similar first,
   * with their similarity from -1 to 1. Fewer when the collection holds fewer.
   */
  nearest(vector: Float32Array, k: number): Promise<VectorMatch[]>;

  /** How many vectors it holds. */
  count(): Promise<number>;

  /** Removes every vector, keeping the collection. */
  clear(): Promise<void>;

  /** Lets go of anything held open. The collection stays. */
  close(): Promise<void>;
}

export interface VectorItem {
  id: string;
  vector: Float32Array;
}

export interface VectorMatch {
  id: string;
  score: number;
}

/** Collection names every vector store accepts. */
export const COLLECTION_NAME = /^[a-z0-9][a-z0-9.-]{0,127}$/;

/** Cosine similarity of two vectors of the same length; 0 when either is all zeros. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
