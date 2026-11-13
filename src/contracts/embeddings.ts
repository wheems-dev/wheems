import type { Driver, HealthCheck } from './driver.js';

/**
 * The embeddings contract: turns text into vectors, so the knowledge base can be searched
 * by meaning as well as by keyword. Version one ships Ollama, which runs on the machine and
 * costs nothing. Hosted providers (OpenAI, Voyage) come later as drivers of their own.
 *
 * With no embeddings driver set up, search is keyword-only, and everything else works.
 */
export interface EmbeddingsDriver extends Driver<'embeddings'> {
  /**
   * The model the vectors come from. Vectors from different models can't be compared, so
   * the index is rebuilt whenever the driver or this changes.
   */
  readonly model: string;

  /**
   * Optional: the similarity below which a match by meaning alone isn't worth showing. Each
   * model scores unrelated texts differently (nomic-embed-text puts them around 0.4 to 0.5),
   * so the driver says. Without it, every match by meaning near the best one is shown.
   */
  readonly minimumSimilarity?: number;

  /**
   * One vector per text, in the same order. `purpose` says whether the texts are documents
   * being stored or a query being searched for; models that embed the two differently (such
   * as nomic-embed-text) need to know. Every vector from one model has the same length.
   * Throws a `DriverError` (`unavailable` when the service behind it can't be reached).
   */
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<Float32Array[]>;

  /** Health checks for doctor, such as whether the service answers and has the model. */
  check(): Promise<HealthCheck[]>;
}

export type EmbeddingPurpose = 'document' | 'query';

/** How an embeddings driver appears in `wheems setup`. */
export interface EmbeddingsSetup {
  /** The model setup suggests. */
  defaultModel: string;
  /** What to tell the person when the program behind the driver isn't there. */
  installHint: string;
  /** The models already available, or null when the service can't be reached. */
  models(): Promise<string[] | null>;
  /** The command that downloads a model, run on the person's terminal, or null when there's none. */
  pull: ((model: string) => string[]) | null;
}
