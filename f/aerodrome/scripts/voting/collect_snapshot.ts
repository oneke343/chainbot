import {
  clientFor,
  collectDetailed,
  type ReadConfig,
  type Snapshot,
} from "../../lib/vote.ts";
import { getAddress } from "viem";

/**
 * Stage 1: read one fixed-block snapshot. The output is deliberately pure
 * data, so the next stage can be replayed without querying a different block.
 */
export async function main(
  walletAddresses: string[],
  rpcUrl = "https://base-rpc.publicnode.com",
  rpcChunkSize = 1000,
  rpcConcurrency = 4,
  poolViewAddress,
  poolViewPageSize = 100,
) {
  const started = Date.now();
  const readConfig: ReadConfig = {
    rpcChunkSize,
    rpcConcurrency,
    poolViewAddress: getAddress(poolViewAddress),
    poolViewPageSize,
  };
  const collected = await collectDetailed(
    clientFor(rpcUrl),
    walletAddresses,
    readConfig,
  );
  const snapshot: Snapshot = collected.snapshot;
  return {
    stage: "collect",
    elapsedMs: Date.now() - started,
    snapshot,
    metrics: {
      registeredPools: snapshot.registeredPools,
      activePools: snapshot.activePools,
      valuedPools: snapshot.pools.length,
      unpricedRewards: snapshot.unpriced.length,
      nfts: snapshot.nfts.length,
      eligibleNfts: snapshot.nfts.filter((n) => n.eligible).length,
      block: snapshot.block,
      epoch: snapshot.epoch,
      ...collected.timings,
    },
  };
}
