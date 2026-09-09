import {
  DEFAULT_POLICY,
  DEFAULT_EXECUTOR_BATCH_SIZE,
  clientFor,
  execute,
  makeExecutionDeps,
  type Allocation,
  type ExecutionSnapshot,
  type Policy,
} from "../../lib/vote.ts";
import { getAddress } from "viem";

/**
 * Stage 3: re-check the snapshot and simulate every vote. With an admin secret,
 * dry-run also estimates, signs locally, and simulates the signed transaction
 * without broadcasting; with dryRun false it additionally sends, confirms, and
 * journals it. In VoteExecutor mode, executorBatchSize groups NFT votes into
 * atomic voteMany transactions.
 */
export async function main(
  snapshot: ExecutionSnapshot,
  allocations: Allocation[],
  rpcUrl = "https://base-rpc.publicnode.com",
  dryRun = true,
  options: Partial<Policy> = {},
  voteExecutor = "",
  adminAddress = "",
  adminVariablePath = "",
  executorBatchSize = DEFAULT_EXECUTOR_BATCH_SIZE,
) {
  const started = Date.now();
  const policy = { ...DEFAULT_POLICY, ...options };
  if (!/^0x[0-9a-fA-F]{40}$/.test(voteExecutor))
    throw new Error("voteExecutor is required and must be a valid EVM address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(adminAddress))
    throw new Error("adminAddress is required and must be a valid EVM address");

  const execution = await execute(
    clientFor(rpcUrl),
    snapshot,
    allocations,
    policy,
    dryRun,
    makeExecutionDeps(adminVariablePath),
    {
      voteExecutor: getAddress(voteExecutor),
      adminAddress: getAddress(adminAddress),
      batchSize: executorBatchSize,
    },
  );
  return {
    stage: "execute",
    elapsedMs: Date.now() - started,
    dryRun,
    execution,
    metrics: {
      allocations: allocations.length,
      batches: execution.batches.length,
      simulated: execution.batches
        .filter((batch) => batch.status === "simulated")
        .reduce((count, batch) => count + batch.tokenIds.length, 0),
      confirmed: execution.batches
        .filter((batch) => batch.status === "confirmed")
        .reduce((count, batch) => count + batch.tokenIds.length, 0),
      skipped: execution.skipped.length,
    },
  };
}
