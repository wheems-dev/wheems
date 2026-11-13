/**
 * Contract test suites and in-memory drivers, published as `wheems/testing`.
 * The suites use Vitest; a driver package runs one in its own test file:
 *
 *   import { runtimeContract } from 'wheems/testing';
 *   runtimeContract('my-runtime', { create: () => new MyRuntime() });
 */
export {
  runtimeContract,
  expectDriverError,
  expectHealthCheck,
  type RuntimeContractOptions,
} from './runtime-contract.js';
export { engineContract, type EngineContractOptions } from './engine-contract.js';
export { channelContract, type ChannelContractOptions } from './channel-contract.js';
export {
  MemoryRuntime,
  echoLineProgram,
  sleepProgram,
  type Program,
  type ProgramFactory,
  type ProgramIo,
} from './memory-runtime.js';
export { embeddingsContract, type EmbeddingsContractOptions } from './embeddings-contract.js';
export { vectorStoreContract, type VectorStoreContractOptions } from './vector-store-contract.js';
export { MemoryChannel } from './memory-channel.js';
export { HashEmbeddings, type HashEmbeddingsOptions } from './memory-embeddings.js';
export { MemoryVectorStore } from './memory-vector-store.js';
export { StubEngine } from './stub-engine.js';
