// Public Aerodrome voting facade. Implementation is split by boundary:
// protocol constants, domain types, snapshot adapters, pure optimization, and
// transaction execution each live in their own module.
export { clientFor, mapWithConcurrency } from "./rpc.ts";
export type { PublicClient, ReadConfig } from "./rpc.ts";

export {
  ABI,
  BASE_CHAIN_ID,
  DEFAULT_EXECUTOR_BATCH_SIZE,
  VE,
  VOTER,
  VOTE_EXECUTOR_ABI,
} from "./protocol.ts";

export {
  DEFAULT_POLICY,
  resolvePolicy,
  parseJournal,
  validatePolicy,
  type Allocation,
  type CollectResult,
  type CollectStepTimings,
  type CollectTimings,
  type ExecutionBatchResult,
  type ExecutionBroadcast,
  type ExecutionDeps,
  type ExecutionReport,
  type ExecutionSimulation,
  type ExecutionSkip,
  type ExecutionSkipReason,
  type ExecutionSnapshot,
  type Journal,
  type Nft,
  type OptimizationMetrics,
  type Policy,
  type Pool,
  type PoolDiscovery,
  type Snapshot,
  type VoteExecutorConfig,
} from "./domain.ts";
export { optimize, optimizeDetailed } from "./optimizer.ts";
export {
  execute,
  makeExecutionDeps,
  withinVotingWindow,
} from "./execution.ts";
export {
  collect,
  collectDetailed,
  discoverNftsSugar,
  discoverPools,
  prices,
} from "./snapshot.ts";
