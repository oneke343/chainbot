import {
  DEFAULT_POLICY,
  clientFor,
  execute,
  makeExecutionDeps,
  validatePolicy,
  type Allocation,
  type Policy,
  type Snapshot,
} from "../../lib/vote.ts";

/**
 * Stage 3: re-check the snapshot, simulate every vote, and optionally sign,
 * broadcast, confirm, and journal it. Secrets are resolved only here.
 */
export async function main(
  snapshot: Snapshot,
  allocations: Allocation[],
  rpcUrl = "https://base-rpc.publicnode.com",
  dryRun = true,
  signerVariablePaths: Record<string, string> = {},
  options: Partial<Policy> = {},
) {
  const started = Date.now();
  const policy = { ...DEFAULT_POLICY, ...options };
  validatePolicy(policy);
  if (!dryRun)
    for (const allocation of allocations)
      if (
        !Object.keys(signerVariablePaths).some(
          (owner) => owner.toLowerCase() === allocation.owner.toLowerCase(),
        )
      )
        throw new Error(`Missing signer configuration for ${allocation.owner}`);

  const execution = await execute(
    clientFor(rpcUrl),
    snapshot,
    allocations,
    policy,
    dryRun,
    makeExecutionDeps(signerVariablePaths),
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
        ["already_voted", "outside_execution_window", "below_net_return_or_gas_limit"].includes(r.status),
      ).length,
    },
  };
}
