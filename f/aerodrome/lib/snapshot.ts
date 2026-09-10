import {
  formatUnits,
  getAddress,
  isAddress,
  type Address,
} from "viem";
import {
  assert,
  call,
  mapWithConcurrency,
  many as rpcMany,
  type Call,
  type PublicClient,
  type ReadConfig,
} from "./rpc.ts";
import { readVeNfts, validateSugar } from "./sugar.ts";
import { readPoolView } from "./pool_view.ts";
import { ABI, BASE_CHAIN_ID, VE, VOTER } from "./protocol.ts";
import {
  ZERO_ADDRESS,
  type CollectResult,
  type CollectStepTimings,
  type Nft,
  type Pool,
  type PoolDiscovery,
  type Snapshot,
} from "./domain.ts";

const ZERO = ZERO_ADDRESS;

function many<T>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
  optional?: false,
  config?: ReadConfig,
): Promise<T[]>;
function many<T>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
  optional: true,
  config?: ReadConfig,
): Promise<(T | null)[]>;
function many<T>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
  optional = false,
  config?: ReadConfig,
) {
  return rpcMany<T>(client, block, calls, ABI, optional, config);
}

function emptyCollectStepTimings(): CollectStepTimings {
  return { sugarNftMs: 0, sugarPoolMs: 0, rewardPricesMs: 0 };
}

function addTiming(
  timings: CollectStepTimings | undefined,
  key: keyof CollectStepTimings,
  elapsedMs: number,
) {
  if (timings) timings[key] += elapsedMs;
}

type Price = { price: number; timestamp: number; confidence?: number };

type DeploymentSnapshot = {
  ve: Address;
  voter: Address;
  epoch: bigint;
  voteStart: bigint;
  voteEnd: bigint;
  maxPools: bigint;
};

function parseDeploymentSnapshot(reads: unknown[]): DeploymentSnapshot {
  const [ve, voter, epoch, voteStart, voteEnd, maxPools] = reads;
  assert(
    typeof ve === "string" && isAddress(ve) &&
      typeof voter === "string" && isAddress(voter) &&
      typeof epoch === "bigint" &&
      typeof voteStart === "bigint" &&
      typeof voteEnd === "bigint" &&
      typeof maxPools === "bigint",
    "Unexpected Aerodrome deployment read result",
  );
  return { ve, voter, epoch, voteStart, voteEnd, maxPools };
}

// CoinLlama accepts a bounded list per request. Fetch those lists in parallel
// so latency is approximately the slowest batch instead of their sum.
const PRICE_BATCH_SIZE = 100;
const PRICE_BATCH_CONCURRENCY = 4;

export async function prices(
  tokens: Address[],
  now: number,
  concurrency = PRICE_BATCH_CONCURRENCY,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const batches = Array.from(
    { length: Math.ceil(tokens.length / PRICE_BATCH_SIZE) },
    (_, index) => tokens.slice(
      index * PRICE_BATCH_SIZE,
      (index + 1) * PRICE_BATCH_SIZE,
    ),
  );
  const responses = await mapWithConcurrency(
    batches,
    concurrency,
    async (batch) => {
      const keys = batch.map((t) => `base:${t.toLowerCase()}`);
      const response = await fetch(
        `https://coins.llama.fi/prices/current/${keys.join(",")}`,
        { signal: AbortSignal.timeout(30000) },
      );
      assert(response.ok, "Price service unavailable");
      const body = (await response.json()) as { coins: Record<string, Price> };
      assert(
        body.coins && typeof body.coins === "object",
        "Invalid price response",
      );
      return { keys, coins: body.coins };
    },
  );
  for (const { keys, coins } of responses) {
    for (const key of keys) {
      const p = coins[key];
      if (
        p &&
        Number.isFinite(p.price) &&
        p.price > 0 &&
        Math.abs(now - p.timestamp) <= 3600 &&
        (p.confidence ?? 0) >= 0.9
      )
        map.set(key.slice(5), p.price);
    }
  }
  return map;
}

type RewardEntry = {
  pool: number;
  source: string;
  token: Address;
  amount: bigint;
  decimals: number | null;
};

/** Convert Sugar reward rows to the Snapshot reward representation. */
async function valueRewards(
  timestamp: bigint,
  pools: Pool[],
  entries: RewardEntry[],
  timings?: CollectStepTimings,
) {
  const unique = [
    ...new Set(
      entries
        .filter((e) => e.amount > 0n)
        .map((e) => e.token.toLowerCase()),
    ),
  ] as Address[];
  const phaseStarted = Date.now();
  const priceMap = await prices(unique, Number(timestamp));
  addTiming(timings, "rewardPricesMs", Date.now() - phaseStarted);
  entries.forEach((e) => {
    if (e.amount === 0n) return;
    const token = e.token.toLowerCase() as Address,
      price = priceMap.get(token),
      dec = e.decimals;
    const usd =
      price !== undefined && Number.isInteger(dec) && dec >= 0 && dec <= 36
        ? Number(formatUnits(e.amount, dec)) * price
        : null;
    assert(usd === null || Number.isFinite(usd), "Invalid reward valuation");
    pools[e.pool].rewards.push({
      token,
      amount: e.amount.toString(),
      source: e.source,
      usd,
    });
    if (usd !== null) pools[e.pool].rewardUsd += usd;
  });
  return {
    unpriced: [
      ...new Set(
        pools.flatMap((p) =>
          p.rewards.filter((r) => r.usd === null).map((r) => r.token),
        ),
      ),
    ],
  };
}

/** Convert VeSugar rows to the business NFT model. */
export async function discoverNftsSugar(
  client: PublicClient,
  block: bigint,
  owners: Address[],
  epoch: number,
  config?: ReadConfig,
  timings?: CollectStepTimings,
): Promise<Nft[]> {
  const started = Date.now();
  const raw = await readVeNfts(client, block, owners, config);
  addTiming(timings, "sugarNftMs", Date.now() - started);
  return raw.map((nft) => {
    const current: Record<string, string> = {};
    for (const vote of nft.votes ?? []) current[vote.lp.toLowerCase()] = vote.weight.toString();
    const reason =
      nft.voting_amount === 0n
        ? "zero_power"
        : Number(nft.voted_at) >= epoch
          ? "already_voted"
          : undefined;
    return {
      tokenId: nft.id.toString(),
      owner: nft.account,
      power: nft.voting_amount.toString(),
      lastVoted: Number(nft.voted_at),
      managedId: nft.managed_id.toString(),
      permanent: nft.permanent,
      current,
      eligible: !reason,
      reason,
    };
  });
}

/** Discover active pools, rewards, and decimals through the view contract. */
export async function discoverPools(
  client: PublicClient,
  block: bigint,
  timestamp: bigint,
  epoch: bigint,
  config: ReadConfig,
  timings?: CollectStepTimings,
): Promise<PoolDiscovery> {
  assert(config.poolViewAddress, "poolViewAddress is required");
  const poolStarted = Date.now();
  const view = await readPoolView(
    client,
    block,
    epoch,
    config.poolViewAddress,
    VOTER,
    config,
  );
  addTiming(timings, "sugarPoolMs", Date.now() - poolStarted);
  const pools: Pool[] = view.pools.map((pool) => ({
    address: pool.pool,
    gauge: pool.gauge,
    votes: pool.votes.toString(),
    rewardUsd: 0,
    rewards: [],
  }));
  const rewardEntries: RewardEntry[] = view.pools.flatMap((pool, index) =>
    pool.rewards.map((reward) => ({
      pool: index,
      source: reward.source === 0 ? "fees" : "incentives",
      token: reward.token,
      amount: reward.amount,
      decimals: reward.decimalsValid ? Number(reward.decimals) : null,
    })),
  );
  const valued = await valueRewards(
    timestamp,
    pools,
    rewardEntries,
    timings,
  );
  return {
    pools,
    unpriced: valued.unpriced,
    registeredPools: view.registeredPools,
    activePools: pools.length,
  };
}

export async function collectDetailed(
  client: PublicClient,
  walletAddresses: string[],
  config?: ReadConfig,
): Promise<CollectResult> {
  const started = Date.now();
  const stepTimings = emptyCollectStepTimings();
  assert(config?.poolViewAddress, "poolViewAddress is required");
  assert(
    walletAddresses.length > 0 && walletAddresses.length <= 50,
    "Provide 1..50 wallet addresses",
  );
  assert(
    walletAddresses.every((a) => isAddress(a) && a.toLowerCase() !== ZERO),
    "Invalid wallet address",
  );
  const owners = [...new Set(walletAddresses.map((a) => a.toLowerCase()))].map(
    (a) => getAddress(a),
  );
  assert(
    !client.chain || client.chain.id === BASE_CHAIN_ID,
    `RPC must be Base (${BASE_CHAIN_ID})`,
  );
  const block = await client.getBlock({ blockTag: "latest" });
  assert(block.number !== null, "Missing block number");
  const deploymentReads = await many<unknown>(
    client,
    block.number,
    [
      call<Address>(VOTER, "ve"),
      call<Address>(VE, "voter"),
      call<bigint>(VOTER, "epochStart", block.timestamp),
      call<bigint>(VOTER, "epochVoteStart", block.timestamp),
      call<bigint>(VOTER, "epochVoteEnd", block.timestamp),
      call<bigint>(VOTER, "maxVotingNum"),
    ],
    false,
    config,
  );
  const {
    ve,
    voter,
    epoch,
    voteStart: start,
    voteEnd: end,
    maxPools,
  } = parseDeploymentSnapshot(deploymentReads);
  const deploymentValidationMs = Date.now() - started;
  assert(
    ve.toLowerCase() === VE.toLowerCase() &&
      voter.toLowerCase() === VOTER.toLowerCase(),
    "Aerodrome deployment mismatch",
  );
  const sugarStarted = Date.now();
  await validateSugar(client, block.number, VOTER, VE);
  const sugarValidationMs = Date.now() - sugarStarted;
  // Both branches use the same fixed block but do not depend on each other's
  // results, so run them in parallel after deployment validation.
  let nftDiscoveryMs = 0;
  let poolDiscoveryMs = 0;
  const [nfts, poolDiscovery] = await Promise.all([
    (async () => {
      const phaseStarted = Date.now();
      const result = await discoverNftsSugar(
        client,
        block.number,
        owners,
        Number(epoch),
        config,
        stepTimings,
      );
      nftDiscoveryMs = Date.now() - phaseStarted;
      return result;
    })(),
    (async () => {
      const phaseStarted = Date.now();
      const result = await discoverPools(
        client,
        block.number,
        block.timestamp,
        epoch,
        config,
        stepTimings,
      );
      poolDiscoveryMs = Date.now() - phaseStarted;
      return result;
    })(),
  ]);
  const snapshot: Snapshot = {
    block: block.number.toString(),
    timestamp: Number(block.timestamp),
    epoch: Number(epoch),
    voteStart: Number(start),
    voteEnd: Number(end),
    maxPools: Number(maxPools),
    nfts,
    ...poolDiscovery,
  };
  return {
    snapshot,
    timings: {
      deploymentValidationMs,
      sugarValidationMs,
      nftDiscoveryMs,
      poolDiscoveryMs,
      steps: stepTimings,
    },
  };
}

export async function collect(
  client: PublicClient,
  walletAddresses: string[],
  config?: ReadConfig,
): Promise<Snapshot> {
  return (await collectDetailed(client, walletAddresses, config)).snapshot;
}
