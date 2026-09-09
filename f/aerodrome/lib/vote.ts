// Pinned dependencies; Bun runtime is needed for local account signing.
import {
  parseAbi,
  formatUnits,
  encodeFunctionData,
  keccak256,
  isAddress,
  getAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as wmill from "windmill-client";
import {
  assert,
  call,
  mapWithConcurrency,
  many as rpcMany,
  type PublicClient,
  type ReadConfig,
  type Call,
} from "./rpc.ts";
export { clientFor, mapWithConcurrency } from "./rpc.ts";
export type { PublicClient, ReadConfig } from "./rpc.ts";
import {
  readVeNfts,
  validateSugar,
} from "./sugar.ts";
import { readPoolView } from "./pool_view.ts";

export const VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" as Address;
export const VE = "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const WEEK = 604800;
export const DEFAULT_EXECUTOR_BATCH_SIZE = 16;
export const ABI = parseAbi([
  "function ve() view returns (address)",
  "function voter() view returns (address)",
  "function ownerOf(uint256) view returns (address)",
  "function balanceOfNFT(uint256) view returns (uint256)",
  "function lastVoted(uint256) view returns (uint256)",
  "function epochStart(uint256) view returns (uint256)",
  "function epochVoteStart(uint256) view returns (uint256)",
  "function epochVoteEnd(uint256) view returns (uint256)",
  "function maxVotingNum() view returns (uint256)",
  "function votes(uint256,address) view returns (uint256)",
]);
function many(
  client: PublicClient,
  block: bigint,
  calls: Call[],
  optional = false,
  config?: ReadConfig,
) {
  return rpcMany(client, block, calls, ABI, optional, config);
}
// The admin can call only the executor's atomic batch entrypoint. The
// executor itself forwards each item to the immutable Aerodrome Voter.
export const VOTE_EXECUTOR_ABI = parseAbi([
  "function voteMany(uint256[],address[][],uint256[][])",
  "function admin() view returns (address)",
  "function transferAdmin(address)",
  "function recoverERC20(address,address,uint256)",
  "function recoverETH(address,uint256)",
  "function AERODROME_VOTER() view returns (address)",
]);
export type Nft = {
  tokenId: string;
  owner: Address;
  power: string;
  lastVoted: number;
  managedId: string;
  permanent: boolean;
  current: Record<string, string>;
  eligible: boolean;
  reason?: string;
};
export type Pool = {
  address: Address;
  gauge: Address;
  votes: string;
  rewardUsd: number;
  rewards: {
    token: Address;
    amount: string;
    source: string;
    usd: number | null;
  }[];
};
export type Snapshot = {
  block: string;
  timestamp: number;
  epoch: number;
  voteStart: number;
  voteEnd: number;
  maxPools: number;
  nfts: Nft[];
  pools: Pool[];
  unpriced: string[];
  registeredPools: number;
  activePools: number;
};
export type ExecutionSnapshot = Pick<
  Snapshot,
  "block" | "timestamp" | "epoch" | "voteStart" | "voteEnd"
>;
export type CollectTimings = {
  deploymentValidationMs: number;
  sugarValidationMs: number;
  nftDiscoveryMs: number;
  poolDiscoveryMs: number;
  steps: CollectStepTimings;
};
export type CollectStepTimings = {
  sugarNftMs: number;
  sugarPoolMs: number;
  rewardPricesMs: number;
};
function emptyCollectStepTimings(): CollectStepTimings {
  return {
    sugarNftMs: 0,
    sugarPoolMs: 0,
    rewardPricesMs: 0,
  };
}
function addTiming(
  timings: CollectStepTimings | undefined,
  key: keyof CollectStepTimings,
  elapsedMs: number,
) {
  if (timings) timings[key] += elapsedMs;
}
export type CollectResult = {
  snapshot: Snapshot;
  timings: CollectTimings;
};

export type Allocation = {
  tokenId: string;
  owner: Address;
  power: string;
  pools: Address[];
  weights: string[];
  estimatedRewardUsd: number;
};
export type Policy = {
  dilution: number;
  maxShare: number;
  rewardHaircut: number;
  candidateMinVotes: number;
  candidateMinRewardPerVoteUsd: number;
  maxSnapshotAgeSeconds: number;
};
export const DEFAULT_POLICY: Policy = {
  dilution: 1.15,
  maxShare: 1,
  rewardHaircut: 0.1,
  candidateMinVotes: 0,
  candidateMinRewardPerVoteUsd: 0,
  maxSnapshotAgeSeconds: 900,
};
function units(n: string | bigint) {
  return Number(formatUnits(BigInt(n), 18));
}
export function validatePolicy(p: Policy) {
  for (const [key, value] of Object.entries(p))
    assert(Number.isFinite(value), `Invalid policy ${key}`);
  assert(
    p.dilution >= 1 && p.dilution <= 10 && p.maxShare > 0 && p.maxShare <= 1,
    "Invalid dilution/maxShare",
  );
  assert(
    p.rewardHaircut >= 0 &&
      p.rewardHaircut < 1 &&
      p.candidateMinVotes >= 0 &&
      p.candidateMinRewardPerVoteUsd >= 0 &&
      Number.isFinite(p.candidateMinVotes),
    "Invalid cost policy",
  );
  assert(
    p.maxSnapshotAgeSeconds > 0 && p.maxSnapshotAgeSeconds <= 3600,
    "Invalid snapshot age",
  );
}
type Price = { price: number; timestamp: number; confidence?: number };
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

export type PoolDiscovery = {
  pools: Pool[];
  unpriced: string[];
  registeredPools: number;
  activePools: number;
};

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
  assert(!client.chain || client.chain.id === 8453, "RPC must be Base (8453)");
  const block = await client.getBlock({ blockTag: "latest" });
  assert(block.number !== null, "Missing block number");
  const [ve, voter, epoch, start, end, maxPools] = await many(
    client,
    block.number,
    [
      call(VOTER, "ve"),
      call(VE, "voter"),
      call(VOTER, "epochStart", block.timestamp),
      call(VOTER, "epochVoteStart", block.timestamp),
      call(VOTER, "epochVoteEnd", block.timestamp),
      call(VOTER, "maxVotingNum"),
    ],
    false,
    config,
  );
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

type Candidate = {
  p: Pool;
  r: number;
  b: number;
  f: number;
  competitionVotes: number;
  density: number;
  maxGain: number;
};
export type OptimizationMetrics = {
  eligibleNfts: number;
  totalVotingPower: string;
  valuedPools: number;
  candidatePools: number;
  filteredPools: number;
  selectedPools: number;
  selectedPoolAddresses: Address[];
  estimatedRewardUsd: number;
};

function prepareCandidates(
  snapshot: Snapshot,
  policy: Policy,
  total: number,
): { candidates: Candidate[]; valuedPools: number } {
  // Build one candidate per valued, live pool. `b` is risk-adjusted external
  // voting power (all local NFT votes are removed first), while `f` is local
  // power that the current run cannot move. `competitionVotes` deliberately
  // uses unadjusted external votes plus fixed votes: it is the pool size used
  // by the noise filter, while `density` uses the risk-adjusted denominator
  // used by the optimizer.
  //
  // `maxGain` is an optimistic standalone gain for up to `cap` new votes. It
  // remains useful for fallback ordering and combinatorial search, but is not
  // exposed as a candidate threshold because it is not the final allocation.
  const valued = snapshot.pools
    .filter((p) => p.rewardUsd > 0)
    .map((p) => {
      const all = snapshot.nfts.reduce(
        (s, n) => s + BigInt(n.current[p.address.toLowerCase()] ?? "0"),
        0n,
      );
      const fixed = snapshot.nfts
        .filter((n) => !n.eligible)
        .reduce(
          (s, n) => s + BigInt(n.current[p.address.toLowerCase()] ?? "0"),
          0n,
        );
      assert(BigInt(p.votes) >= all, "Pool votes smaller than owned votes");
      const external = units(BigInt(p.votes) - all);
      const r = p.rewardUsd * (1 - policy.rewardHaircut);
      const b = Math.max(1e-18, external * policy.dilution);
      const f = units(fixed);
      const cap = Math.min(total * policy.maxShare, total);
      const maxGain =
        r * ((f + cap) / (b + f + cap) - f / (b + f));
      return {
        p,
        r,
        b,
        f,
        competitionVotes: external + f,
        density: r / Math.max(b + f, 1e-18),
        maxGain,
      };
    });
  if (!valued.length) return { candidates: [], valuedPools: 0 };

  const minimum = Math.ceil(1 / policy.maxShare - 1e-10);
  const passes = (c: Candidate) => {
    // This is an AND for removal, not an AND for admission. A low-vote pool
    // with unusually good reward density is often exactly the pool worth
    // voting for, so remove only pools that are both small and unattractive
    // on a per-vote basis.
    const lowVotes =
      policy.candidateMinVotes > 0 &&
      c.competitionVotes < policy.candidateMinVotes;
    const lowDensity =
      policy.candidateMinRewardPerVoteUsd > 0 &&
      c.density < policy.candidateMinRewardPerVoteUsd;
    return !(lowVotes && lowDensity);
  };
  let candidates = valued.filter(passes);

  // Thresholds are allowed to be strict, but never leave maxShare infeasible.
  // If the user asks for an aggressive filter, the best potential pools are
  // put back until at least `minimum` pools remain.
  if (candidates.length < minimum) {
    const fallback = valued
      .filter((c) => !candidates.includes(c))
      .sort((a, b) => b.maxGain - a.maxGain || b.r - a.r);
    candidates = [...candidates, ...fallback.slice(0, minimum - candidates.length)];
  }

  return { candidates, valuedPools: valued.length };
}

// Concave allocation: R * (fixed + x) / (external + fixed + x).
//
// Important sequencing: this function solves one aggregate problem using the
// sum of every eligible NFT's power. It does not choose pools NFT by NFT. The
// resulting relative weights are later copied to each NFT, which realizes the
// same aggregate `x` because Voter scales weights by that NFT's own power.
// Greedy subset selection and an all-pool relaxation provide two candidate
// solutions. Keep the better one; cardinality remains a heuristic constraint.
export function optimizeDetailed(
  snapshot: Snapshot,
  policy: Policy,
): { allocations: Allocation[]; metrics: OptimizationMetrics } {
  validatePolicy(policy);
  const eligible = snapshot.nfts.filter((n) => n.eligible),
    power = eligible.reduce((s, n) => s + BigInt(n.power), 0n),
    total = units(power);
  const emptyMetrics = (valuedPools = 0, candidatePools = 0): OptimizationMetrics => ({
    eligibleNfts: eligible.length,
    totalVotingPower: power.toString(),
    valuedPools,
    candidatePools,
    filteredPools: Math.max(0, valuedPools - candidatePools),
    selectedPools: 0,
    selectedPoolAddresses: [],
    estimatedRewardUsd: 0,
  });
  if (power === 0n) return { allocations: [], metrics: emptyMetrics() };
  assert(
    Number.isInteger(snapshot.maxPools) && snapshot.maxPools > 0,
    "Snapshot maxVotingNum must be a positive integer",
  );
  const k = snapshot.maxPools;
  const prepared = prepareCandidates(snapshot, policy, total),
    candidates = prepared.candidates;
  if (candidates.length === 0)
    return { allocations: [], metrics: emptyMetrics(prepared.valuedPools) };
  const solve = (items: typeof candidates) => {
    // KKT/water-filling solution. For
    //   V(x) = r * (f + x) / (b + f + x),
    // the marginal return is r*b/(b+f+x)^2. Setting every active pool's
    // marginal return to the common threshold `mid` gives the square-root
    // allocation below. Binary search finds the threshold whose allocations
    // consume the total eligible power.
    assert(
      items.length * policy.maxShare >= 1 - 1e-10,
      "Too few valued pools for maxShare",
    );
    let lo = 0,
      hi = Math.max(...items.map((c) => (c.r * c.b) / (c.b + c.f) ** 2));
    for (let i = 0; i < 180; i++) {
      const mid = (lo + hi) / 2;
      const used = items.reduce(
        (s, c) =>
          s +
          Math.min(
            total * policy.maxShare,
            Math.max(0, Math.sqrt((c.r * c.b) / mid) - c.b - c.f),
          ),
        0,
      );
      if (used > total) lo = mid;
      else hi = mid;
    }
    return items.map((c) =>
      Math.min(
        total * policy.maxShare,
        Math.max(0, Math.sqrt((c.r * c.b) / hi) - c.b - c.f),
      ),
    );
  };
  // First solve without a pool-count limit. This exposes which pools deserve
  // power naturally; the top `k` become the relaxed cardinality candidate.
  const relaxed = solve(candidates);
  const relaxedSelection = candidates
    .map((c, i) => ({ c, x: relaxed[i] }))
    .sort((a, b) => b.x - a.x || a.c.p.address.localeCompare(b.c.p.address))
    .slice(0, k)
    .map((v) => v.c);
  const value = (items: typeof candidates) => {
    const amounts = solve(items);
    return items.reduce((s,c,i) => s + c.r * ((c.f+amounts[i])/(c.b+c.f+amounts[i])-c.f/(c.b+c.f)),0);
  };
  // Seed enough pools to satisfy the concentration cap. For the default cap,
  // this starts with the best single pool, including pools with no other votes.
  const minimum = Math.ceil(1 / policy.maxShare - 1e-10);
  assert(k >= minimum, "Too few valued pools for maxShare");
  let greedy = minimum === 1 ? [] as typeof candidates : relaxedSelection.slice(0, minimum);
  while (greedy.length < Math.min(k,candidates.length)) {
    let best: typeof candidates[number] | undefined;
    let bestValue = greedy.length ? value(greedy) : -Infinity;
    for (const c of candidates) {
      if (greedy.includes(c)) continue;
      const trial = value([...greedy,c]);
      if (trial > bestValue + 1e-10) { best=c; bestValue=trial; }
    }
    if (!best) break;
    greedy.push(best);
  }
  // The pool-count constraint is combinatorial. Compare the greedy subset with
  // the relaxed subset and keep the higher-valued re-optimized solution.
  const selected = greedy.length && value(greedy) >= value(relaxedSelection) ? greedy : relaxedSelection;
  const amounts = solve(selected);
  const SCALE = 1000000000000n;
  const weights = amounts.map((x) =>
    x > 0 ? BigInt(Math.max(1,Math.floor((x / total) * Number(SCALE)))) : 0n,
  );
  // Voter expects relative weights, not absolute veAERO amounts. One 1e12
  // scale gives enough precision for small NFTs; flooring leaves only a few
  // parts per trillion unused and Voter normalizes the remaining sum.
  const positive = selected
    .map((c, i) => ({ c, w: weights[i] }))
    .filter((v) => v.w > 0n);
  assert(positive.length > 0, "Allocation rounded to zero");
  const sum = positive.reduce((s, v) => s + v.w, 0n);
  // Every eligible NFT receives the same pool vector. Its actual pool votes
  // are proportional to n.power inside Voter.vote, so a 1-power NFT and a
  // 99-power NFT contribute 1% and 99% of the aggregate allocation.
  const allocations = eligible.map((n) => {
    const usable = positive.filter((v) => (BigInt(n.power) * v.w) / sum > 0n);
    assert(
      usable.length === positive.length,
      "NFT voting power too small for allocation precision",
    );
    return {
      tokenId: n.tokenId,
      owner: n.owner,
      power: n.power,
      pools: usable.map((v) => v.c.p.address),
      weights: usable.map((v) => v.w.toString()),
      estimatedRewardUsd: 0,
    };
  });
  allocations.forEach((a) => {
    a.estimatedRewardUsd = positive.reduce((s, v) => {
      const own = units((BigInt(a.power) * v.w) / sum);
      const added = allocations.reduce(
        (t, n) => t + units((BigInt(n.power) * v.w) / sum),
        0,
      );
      return s + (v.c.r * own) / (v.c.b + v.c.f + added);
    }, 0);
  });
  return {
    allocations,
    metrics: {
      eligibleNfts: eligible.length,
      totalVotingPower: power.toString(),
      valuedPools: prepared.valuedPools,
      candidatePools: candidates.length,
      filteredPools: Math.max(0, prepared.valuedPools - candidates.length),
      selectedPools: positive.length,
      selectedPoolAddresses: positive.map((v) => v.c.p.address),
      estimatedRewardUsd: allocations.reduce((s, a) => s + a.estimatedRewardUsd, 0),
    },
  };
}

export function optimize(snapshot: Snapshot, policy: Policy): Allocation[] {
  return optimizeDetailed(snapshot, policy).allocations;
}

export function withinVotingWindow(timestamp: number, snapshot: Snapshot) {
  return timestamp > snapshot.voteStart && timestamp < snapshot.voteEnd;
}
type JournalEntry = {
  hash: Hex;
  owner: Address;
  sender?: Address;
  nonce: number;
  status: "prepared" | "confirmed" | "reverted";
  epoch: number;
  tokenId: string;
};
export type Journal = Record<string, JournalEntry>;
export type ExecutionDeps = {
  adminAccount(): Promise<LocalAccount>;
  readJournal(): Promise<Journal>;
  writeJournal(journal: Journal): Promise<void>;
};
export type VoteExecutorConfig = {
  voteExecutor: Address;
  adminAddress: Address;
  /** Maximum NFTs included in one VoteExecutor.voteMany transaction. */
  batchSize?: number;
};
export function makeExecutionDeps(
  adminVariablePath: string,
): ExecutionDeps {
  async function accountFromVariable(path: string | undefined, label: string) {
    assert(path && /^[uf]\//.test(path), `Missing ${label} secret variable path`);
    let value: string;
    try {
      value = await wmill.getVariable(path);
    } catch {
      throw new Error(`Unable to read ${label} secret variable`);
    }
    assert(
      /^0x[0-9a-fA-F]{64}$/.test(value),
      `${label} variable must contain a hex private key`,
    );
    try {
      return privateKeyToAccount(value as Hex);
    } catch {
      throw new Error(`Invalid ${label} signing key`);
    }
  }
  return {
    async adminAccount() {
      return accountFromVariable(adminVariablePath, "admin");
    },
    async readJournal() {
      return (await wmill.getState("f/aerodrome/__vote_state")) ?? {};
    },
    async writeJournal(journal) {
      await wmill.setState(journal, "f/aerodrome/__vote_state");
    },
  };
}

type PreparedBatchVote = {
  allocation: Allocation;
  key: string;
};

/**
 * Execute votes in atomic batches. VoteExecutor forwards each item to the
 * Aerodrome Voter, so Voter sees the approved executor as msg.sender. A single
 * hash is journaled for every NFT in the batch; any failed vote reverts the
 * whole transaction and leaves every entry retryable.
 */
async function executeBatched(
  client: PublicClient,
  snapshot: ExecutionSnapshot,
  allocations: Allocation[],
  policy: Policy,
  dryRun: boolean,
  deps: ExecutionDeps,
  voteExecutor: Address,
  adminAddress: Address,
  batchSize: number,
): Promise<Record<string, unknown>[]> {
  const journal = dryRun ? {} : await deps.readJournal();
  const results: Record<string, unknown>[] = [];
  const latest = await client.getBlock();
  assert(
    Number(latest.timestamp) - snapshot.timestamp <=
      policy.maxSnapshotAgeSeconds,
    "Snapshot expired; rerun collection",
  );
  const pending = allocations.filter((allocation) => {
    if (withinVotingWindow(Number(latest.timestamp), snapshot)) return true;
    results.push({
      tokenId: allocation.tokenId,
      status: "outside_voting_window",
    });
    return false;
  });
  // Read every NFT precondition in one fixed-block multicall. Per-NFT
  // multicalls add one network round trip for each allocation.
  const checks = pending.length
    ? await many(
        client,
        latest.number!,
        pending.flatMap((allocation) => [
          call(VE, "ownerOf", BigInt(allocation.tokenId)),
          call(VOTER, "lastVoted", BigInt(allocation.tokenId)),
          call(VE, "balanceOfNFT", BigInt(allocation.tokenId)),
        ]),
      )
    : [];
  const prepared: PreparedBatchVote[] = [];
  for (let i = 0; i < pending.length; i++) {
    const allocation = pending[i];
    const owner = checks[i * 3];
    const last = checks[i * 3 + 1];
    const power = checks[i * 3 + 2];
    assert(
      owner.toLowerCase() === allocation.owner.toLowerCase(),
      "NFT ownership changed",
    );
    if (Number(last) >= snapshot.epoch) {
      results.push({ tokenId: allocation.tokenId, status: "already_voted" });
      continue;
    }
    assert(
      power.toString() === allocation.power,
      "Voting power changed; recompute allocation",
    );
    const key = `${snapshot.epoch}:${allocation.tokenId}`;
    if (!dryRun && journal[key] && journal[key].status !== "reverted") {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({
          hash: journal[key].hash,
        });
      } catch {
        throw new Error(
          `Unresolved vote ${journal[key].hash}; reconcile nonce ${journal[key].nonce} before retry`,
        );
      }
      journal[key].status =
        receipt.status === "success" ? "confirmed" : "reverted";
      await deps.writeJournal(journal);
      if (receipt.status === "success") {
        results.push({
          tokenId: allocation.tokenId,
          status: "confirmed",
          hash: receipt.transactionHash,
        });
        continue;
      }
    }
    prepared.push({ allocation, key });
  }

  let account: LocalAccount | undefined;

  for (let start = 0; start < prepared.length; start += batchSize) {
    const batch = prepared.slice(start, start + batchSize);
    const tokenIds = batch.map(({ allocation }) => BigInt(allocation.tokenId));
    const pools = batch.map(({ allocation }) => allocation.pools);
    const weights = batch.map(({ allocation }) =>
      allocation.weights.map(BigInt),
    );
    const args = [tokenIds, pools, weights] as const;
    const data = encodeFunctionData({
      abi: VOTE_EXECUTOR_ABI,
      functionName: "voteMany",
      args,
    });
    try {
      await client.simulateContract({
        address: voteExecutor,
        abi: VOTE_EXECUTOR_ABI,
        functionName: "voteMany",
        args,
        account: adminAddress,
      });
    } catch {
      throw new Error(
        `Vote batch simulation failed for NFTs ${batch
          .map(({ allocation }) => allocation.tokenId)
          .join(",")}; no transaction sent`,
      );
    }
    if (dryRun) {
      for (const { allocation } of batch)
        results.push({
          tokenId: allocation.tokenId,
          status: "simulated",
          to: voteExecutor,
          data,
          batchSize: batch.length,
        });
      continue;
    }
    const gas = await client.estimateContractGas({
      address: voteExecutor,
      abi: VOTE_EXECUTOR_ABI,
      functionName: "voteMany",
      args,
      account: adminAddress,
    });
    const gasLimit = (gas * 125n) / 100n;
    const fees = await client.estimateFeesPerGas();
    assert(fees.maxFeePerGas !== undefined, "Missing EIP-1559 fee quote");
    account ??= await deps.adminAccount();
    assert(
      account.address.toLowerCase() === adminAddress.toLowerCase(),
      "Admin signing key does not match adminAddress",
    );
    const nonce = await client.getTransactionCount({
      address: adminAddress,
      blockTag: "pending",
    });
    assert(
      nonce ===
        (await client.getTransactionCount({
          address: adminAddress,
          blockTag: "latest",
        })),
      "Admin has pending transactions; retry after confirmation",
    );
    const beforeSign = await client.getBlock();
    assert(
      withinVotingWindow(Number(beforeSign.timestamp), snapshot),
      "Voting window closed or not started",
    );
    const signed = await account.signTransaction({
      chainId: 8453,
      type: "eip1559",
      nonce,
      to: voteExecutor,
      data,
      value: 0n,
      gas: gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
    });
    const hash = keccak256(signed);
    for (const { allocation, key } of batch)
      journal[key] = {
        hash,
        owner: allocation.owner,
        sender: adminAddress,
        nonce,
        status: "prepared",
        epoch: snapshot.epoch,
        tokenId: allocation.tokenId,
      };
    await deps.writeJournal(journal);
    try {
      await client.sendRawTransaction({ serializedTransaction: signed });
    } catch {
      throw new Error(
        `Broadcast uncertain for vote batch ${hash}; reconcile nonce ${nonce} before retry`,
      );
    }
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 2,
        timeout: 60000,
      });
    } catch {
      throw new Error(`Vote batch pending: ${hash}; journal retained`);
    }
    for (const { key } of batch)
      journal[key].status =
        receipt.status === "success" ? "confirmed" : "reverted";
    await deps.writeJournal(journal);
    assert(receipt.status === "success", `Vote batch reverted: ${hash}`);

    const postCalls: Call[] = [];
    for (const { allocation } of batch) {
      postCalls.push(call(VOTER, "lastVoted", BigInt(allocation.tokenId)));
      postCalls.push(
        ...allocation.pools.map((pool) =>
          call(VOTER, "votes", BigInt(allocation.tokenId), pool),
        ),
      );
    }
    const post = await many(client, receipt.blockNumber, postCalls);
    let offset = 0;
    for (const { allocation } of batch) {
      const lastVoted = post[offset++];
      const votes = post.slice(offset, offset + allocation.pools.length);
      offset += allocation.pools.length;
      assert(
        Number(lastVoted) >= snapshot.epoch && votes.every((value) => value > 0n),
        `Vote postcondition failed: ${hash}`,
      );
      results.push({
        tokenId: allocation.tokenId,
        status: "confirmed",
        hash,
        batchSize: batch.length,
      });
    }
  }
  return results;
}

export async function execute(
  client: PublicClient,
  snapshot: ExecutionSnapshot,
  allocations: Allocation[],
  policy: Policy,
  dryRun: boolean,
  deps: ExecutionDeps,
  executorConfig: Partial<VoteExecutorConfig> = {},
) {
  assert(typeof dryRun === "boolean", "dryRun must be a boolean");
  validatePolicy(policy);
  assert(deps, "Execution requires admin and journal adapters");
  const voteExecutor = executorConfig.voteExecutor
    ? getAddress(executorConfig.voteExecutor)
    : undefined;
  const adminAddress = executorConfig.adminAddress
    ? getAddress(executorConfig.adminAddress)
    : undefined;
  assert(voteExecutor, "voteExecutor is required");
  assert(adminAddress, "adminAddress is required");
  assert(deps.adminAccount, "Execution dependencies must provide adminAccount");
  const batchSize = executorConfig.batchSize ?? DEFAULT_EXECUTOR_BATCH_SIZE;
  assert(
    Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 50,
    "executor batchSize must be an integer from 1 to 50",
  );
  const [configuredAdmin, configuredVoter] = await Promise.all([
    client.readContract({
      address: voteExecutor,
      abi: VOTE_EXECUTOR_ABI,
      functionName: "admin",
      blockNumber: BigInt(snapshot.block),
      authorizationList: undefined,
    }),
    client.readContract({
      address: voteExecutor,
      abi: VOTE_EXECUTOR_ABI,
      functionName: "AERODROME_VOTER",
      blockNumber: BigInt(snapshot.block),
      authorizationList: undefined,
    }),
  ]);
  assert(
    getAddress(configuredAdmin) === adminAddress,
    "VoteExecutor admin does not match adminAddress",
  );
  assert(
    getAddress(configuredVoter) === VOTER,
    "VoteExecutor is not bound to the Aerodrome Base Voter",
  );
  return executeBatched(
    client,
    snapshot,
    allocations,
    policy,
    dryRun,
    deps,
    voteExecutor,
    adminAddress,
    batchSize,
  );
}
