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
 * Stage 3: re-check the snapshot, simulate every vote, and optionally sign,
 * broadcast, confirm, and journal it. In VoteExecutor mode, executorBatchSize
 * groups NFT votes into atomic voteMany transactions. Secrets are resolved only
 * here.
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
      simulated: execution.filter((r) => r.status === "simulated").length,
      confirmed: execution.filter((r) => r.status === "confirmed").length,
      skipped: execution.filter((r) =>
        ["already_voted", "outside_voting_window"].includes(String(r.status)),
      ).length,
    },
  };
}
