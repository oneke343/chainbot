import {
  DEFAULT_POLICY,
  optimizeDetailed,
  validatePolicy,
  type Policy,
  type Snapshot,
} from "../../lib/vote.ts";

/**
 * Stage 2: optimize all eligible NFT voting power together.
 *
 * `optimizeDetailed` first removes candidate-pool noise, then solves the
 * concave aggregate allocation. It returns relative weights; the Voter
 * contract scales those weights by each NFT's own balanceOfNFT in stage 3.
 */
export function main(
  snapshot: Snapshot,
  options: Partial<Policy> = {},
) {
  const started = Date.now();
  const policy = { ...DEFAULT_POLICY, ...options };
  validatePolicy(policy);
  const result = optimizeDetailed(snapshot, policy);
  return {
    stage: "optimize",
    elapsedMs: Date.now() - started,
    allocations: result.allocations,
    metrics: result.metrics,
    policy,
  };
}
