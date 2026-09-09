// Pinned dependencies; Bun runtime is needed for local account signing.
import {
  createPublicClient,
  http,
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
import { base } from "viem/chains";
import * as wmill from "windmill-client";

export const VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" as Address;
export const VE = "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4" as Address;
export const WETH = "0x4200000000000000000000000000000000000006" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const WEEK = 604800;
export const ABI = parseAbi([
  "function ve() view returns (address)",
  "function voter() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function ownerToNFTokenIdList(address,uint256) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function balanceOfNFT(uint256) view returns (uint256)",
  "function escrowType(uint256) view returns (uint8)",
  "function idToManaged(uint256) view returns (uint256)",
  "function locked(uint256) view returns (int128 amount,uint256 end,bool isPermanent)",
  "function lastVoted(uint256) view returns (uint256)",
  "function usedWeights(uint256) view returns (uint256)",
  "function poolVote(uint256,uint256) view returns (address)",
  "function votes(uint256,address) view returns (uint256)",
  "function epochStart(uint256) view returns (uint256)",
  "function epochVoteStart(uint256) view returns (uint256)",
  "function epochVoteEnd(uint256) view returns (uint256)",
  "function maxVotingNum() view returns (uint256)",
  "function length() view returns (uint256)",
  "function pools(uint256) view returns (address)",
  "function gauges(address) view returns (address)",
  "function isAlive(address) view returns (bool)",
  "function weights(address) view returns (uint256)",
  "function gaugeToFees(address) view returns (address)",
  "function gaugeToBribe(address) view returns (address)",
  "function rewardsListLength() view returns (uint256)",
  "function rewards(uint256) view returns (address)",
  "function tokenRewardsPerEpoch(address,uint256) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function vote(uint256,address[],uint256[])",
]);
type Call = {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
};
type PublicClient = ReturnType<typeof clientFor>;
export type Nft = {
  tokenId: string;
  owner: Address;
  power: string;
  lastVoted: number;
  escrowType: number;
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
  ethUsd: number;
  unpriced: string[];
  registeredPools: number;
  activePools: number;
};
export type Allocation = {
  tokenId: string;
  owner: Address;
  power: string;
  pools: Address[];
  weights: string[];
  estimatedRewardUsd: number;
  data: Hex;
};
export type Policy = {
  maxPools: number;
  dilution: number;
  maxShare: number;
  rewardHaircut: number;
  candidateMinRewardUsd: number;
  candidateMinRewardPerVoteUsd: number;
  candidateMinExpectedGainUsd: number;
  candidatePoolLimit: number;
  maxGasUsd: number;
  minNetUsd: number;
  executionLeadSeconds: number;
  deadlineBufferSeconds: number;
  maxSnapshotAgeSeconds: number;
};
export const DEFAULT_POLICY: Policy = {
  maxPools: 10,
  dilution: 1.15,
  maxShare: 1,
  rewardHaircut: 0.1,
  candidateMinRewardUsd: 0,
  candidateMinRewardPerVoteUsd: 0,
  candidateMinExpectedGainUsd: 0,
  candidatePoolLimit: 0,
  maxGasUsd: 2,
  minNetUsd: 0,
  executionLeadSeconds: 7200,
  deadlineBufferSeconds: 600,
  maxSnapshotAgeSeconds: 900,
};
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function count(n: bigint, limit: number, label: string) {
  assert(
    n >= 0n && n <= BigInt(limit),
    `${label} exceeds supported limit ${limit}; refusing partial discovery`,
  );
  return Number(n);
}
function units(n: string | bigint) {
  return Number(formatUnits(BigInt(n), 18));
}
export function validatePolicy(p: Policy) {
  for (const [key, value] of Object.entries(p))
    assert(Number.isFinite(value), `Invalid policy ${key}`);
  assert(
    Number.isInteger(p.maxPools) && p.maxPools > 0 && p.maxPools <= 30,
    "maxPools must be 1..30",
  );
  assert(
    p.dilution >= 1 && p.dilution <= 10 && p.maxShare > 0 && p.maxShare <= 1,
    "Invalid dilution/maxShare",
  );
  assert(
    p.rewardHaircut >= 0 &&
      p.rewardHaircut < 1 &&
      p.candidateMinRewardUsd >= 0 &&
      p.candidateMinRewardPerVoteUsd >= 0 &&
      p.candidateMinExpectedGainUsd >= 0 &&
      Number.isInteger(p.candidatePoolLimit) &&
      p.candidatePoolLimit >= 0 &&
      p.maxGasUsd > 0 &&
      p.minNetUsd >= 0,
    "Invalid cost policy",
  );
  assert(
    p.deadlineBufferSeconds >= 60 &&
      p.executionLeadSeconds > p.deadlineBufferSeconds &&
      p.executionLeadSeconds < WEEK,
    "Invalid execution window",
  );
  assert(
    p.maxSnapshotAgeSeconds > 0 && p.maxSnapshotAgeSeconds <= 3600,
    "Invalid snapshot age",
  );
}
export function clientFor(rpcUrl: string) {
  assert(/^https?:\/\//.test(rpcUrl), "Invalid RPC URL");
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: 30000, retryCount: 2 }),
  });
}

export type ReadConfig = {
  rpcChunkSize?: number;
  rpcConcurrency?: number;
};
const DEFAULT_READ_CONFIG = {
  rpcChunkSize: 1000,
  rpcConcurrency: 4,
} as const;
function readConfig(config?: ReadConfig) {
  const chunkSize = config?.rpcChunkSize ?? DEFAULT_READ_CONFIG.rpcChunkSize;
  const concurrency = config?.rpcConcurrency ?? DEFAULT_READ_CONFIG.rpcConcurrency;
  assert(
    Number.isInteger(chunkSize) && chunkSize >= 100 && chunkSize <= 1000,
    "rpcChunkSize must be an integer from 100 to 1000",
  );
  assert(
    Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8,
    "rpcConcurrency must be an integer from 1 to 8",
  );
  return { rpcChunkSize: chunkSize, rpcConcurrency: concurrency };
}

/**
 * Split work into chunks and process those chunks with bounded concurrency.
 * A worker claims the next chunk synchronously before awaiting, so at most
 * `concurrency` mapper calls are in flight. Flattening chunk results in chunk
 * order preserves the input order when the mapper returns one result per item.
 */
export async function mapChunksWithConcurrency<T, R>(
  items: readonly T[],
  chunkSize: number,
  concurrency: number,
  mapper: (chunk: readonly T[], chunkIndex: number) => Promise<readonly R[]>,
): Promise<R[]> {
  assert(Number.isInteger(chunkSize) && chunkSize >= 1, "Invalid chunk size");
  assert(Number.isInteger(concurrency) && concurrency >= 1, "Invalid concurrency");
  if (!items.length) return [];
  const chunks = Array.from(
    { length: Math.ceil(items.length / chunkSize) },
    (_, index) => items.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const chunkResults = new Array<readonly R[]>(chunks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const chunkIndex = next++;
      if (chunkIndex >= chunks.length) return;
      chunkResults[chunkIndex] = await mapper(chunks[chunkIndex], chunkIndex);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()),
  );
  return chunkResults.flatMap((results) => results);
}

// Fixed-block Multicall3 reads; failed required calls never turn into zeroes.
// Chunking and concurrency are delegated to the generic scheduler above, so
// this function stays focused on RPC semantics and failure handling.
async function many(
  client: PublicClient,
  block: bigint,
  calls: Call[],
  optional = false,
  config?: ReadConfig,
): Promise<any[]> {
  if (!calls.length) return [];
  const { rpcChunkSize, rpcConcurrency } = readConfig(config);
  const entries = await mapChunksWithConcurrency(
    calls,
    rpcChunkSize,
    rpcConcurrency,
    async (part) => {
      const results = await client.multicall({
        blockNumber: block,
        allowFailure: true,
        batchSize: 0,
        authorizationList: undefined,
        contracts: part.map((c) => ({ ...c, abi: ABI })) as any,
      });
      return results.map((result, index) => ({
        result,
        request: part[index],
      }));
    },
  );
  const out: any[] = new Array(calls.length);
  entries.forEach(({ result, request }, index) => {
    if (result.status === "failure") {
      assert(
        optional,
        `Contract read failed: ${request.address} ${request.functionName}`,
      );
      out[index] = null;
    } else out[index] = result.result;
  });
  return out;
}
function call(
  address: Address,
  functionName: string,
  ...args: unknown[]
): Call {
  return { address, functionName, args };
}
async function readNft(
  client: PublicClient,
  block: bigint,
  id: bigint,
  owners: Address[],
  epoch: number,
  config?: ReadConfig,
): Promise<Nft> {
  const [owner, power, kind, managed, lock, last, used] = await many(
    client,
    block,
    [
      call(VE, "ownerOf", id),
      call(VE, "balanceOfNFT", id),
      call(VE, "escrowType", id),
      call(VE, "idToManaged", id),
      call(VE, "locked", id),
      call(VOTER, "lastVoted", id),
      call(VOTER, "usedWeights", id),
    ],
    false,
    config,
  );
  assert(
    owners.some((o) => o.toLowerCase() === owner.toLowerCase()),
    "NFT owner changed during enumeration",
  );
  const current: Record<string, string> = {};
  if (used > 0n) {
    let sum = 0n;
    for (let i = 0; i < 1024 && sum < used; i += 32) {
      const addresses = await many(
        client,
        block,
        Array.from({ length: 32 }, (_, j) =>
          call(VOTER, "poolVote", id, BigInt(i + j)),
        ),
        true,
        config,
      );
      const valid = addresses.filter((a): a is Address => a !== null);
      assert(valid.length > 0, "Incomplete prior vote enumeration");
      const weights: bigint[] = await many(
        client,
        block,
        valid.map((p) => call(VOTER, "votes", id, p)),
        false,
        config,
      );
      valid.forEach((p, j) => {
        assert(!(p.toLowerCase() in current), "Duplicate prior pool");
        current[p.toLowerCase()] = weights[j].toString();
        sum += weights[j];
      });
    }
    assert(sum === used, "Prior votes do not match usedWeights");
  }
  const reason =
    Number(kind) !== 0
      ? "managed_or_relay"
      : power === 0n
        ? "zero_power"
        : Number(last) >= epoch
          ? "already_voted"
          : undefined;
  return {
    tokenId: id.toString(),
    owner,
    power: power.toString(),
    lastVoted: Number(last),
    escrowType: Number(kind),
    managedId: managed.toString(),
    permanent: lock[2],
    current,
    eligible: !reason,
    reason,
  };
}

/** Discover direct veAERO ownership, NFT state, and movable prior votes. */
export async function discoverNfts(
  client: PublicClient,
  block: bigint,
  owners: Address[],
  epoch: number,
  config?: ReadConfig,
): Promise<Nft[]> {
  const counts = await many(
    client,
    block,
    owners.map((o) => call(VE, "balanceOf", o)),
    false,
    config,
  );
  const queries = owners.flatMap((o, i) =>
    Array.from({ length: count(counts[i], 1000, "NFT count") }, (_, j) =>
      call(VE, "ownerToNFTokenIdList", o, BigInt(j)),
    ),
  );
  const ids: bigint[] = await many(client, block, queries, false, config);
  assert(
    new Set(ids.map(String)).size === ids.length,
    "Duplicate NFT enumeration",
  );
  const { rpcConcurrency } = readConfig(config);
  return mapChunksWithConcurrency(ids, 1, rpcConcurrency, async (chunk) => [
    await readNft(client, block, chunk[0], owners, epoch, config),
  ]);
}

// Backward-compatible name for callers that only need NFT discovery.
export const discover = discoverNfts;
type Price = { price: number; timestamp: number; confidence?: number };
export async function prices(
  tokens: Address[],
  now: number,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let i = 0; i < tokens.length; i += 40) {
    const keys = tokens.slice(i, i + 40).map((t) => `base:${t.toLowerCase()}`);
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
    for (const key of keys) {
      const p = body.coins[key];
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

export type PoolDiscovery = {
  pools: Pool[];
  ethUsd: number;
  unpriced: string[];
  registeredPools: number;
  activePools: number;
};

/** Discover live gauges, reward contracts, reward amounts, and valuations. */
export async function discoverPools(
  client: PublicClient,
  block: bigint,
  timestamp: bigint,
  epoch: bigint,
  poolCount: bigint,
  config?: ReadConfig,
): Promise<PoolDiscovery> {
  const addresses: Address[] = await many(
    client,
    block,
    Array.from({ length: count(poolCount, 50000, "Pool count") }, (_, i) =>
      call(VOTER, "pools", BigInt(i)),
    ),
    false,
    config,
  );
  const gauges: Address[] = await many(
    client,
    block,
    addresses.map((p) => call(VOTER, "gauges", p)),
    false,
    config,
  );
  const alive: boolean[] = await many(
    client,
    block,
    gauges.map((g) => call(VOTER, "isAlive", g)),
    false,
    config,
  );
  const active = addresses
    .map((p, i) => ({ address: p, gauge: gauges[i] }))
    .filter((_, i) => alive[i]);
  console.info(
    `Aerodrome snapshot: ${addresses.length} registered pools, ${active.length} active gauges`,
  );
  const details = await many(
    client,
    block,
    active.flatMap((p) => [
      call(VOTER, "weights", p.address),
      call(VOTER, "gaugeToFees", p.gauge),
      call(VOTER, "gaugeToBribe", p.gauge),
    ]),
    false,
    config,
  );
  const pools: Pool[] = active.map((p, i) => ({
    ...p,
    votes: details[i * 3].toString(),
    rewardUsd: 0,
    rewards: [],
  }));
  const rewardContracts = active.flatMap((_, i) => [
    { address: details[i * 3 + 1] as Address, pool: i, source: "fees" },
    { address: details[i * 3 + 2] as Address, pool: i, source: "incentives" },
  ]);
  const lengths: bigint[] = await many(
    client,
    block,
    rewardContracts.map((r) => call(r.address, "rewardsListLength")),
    false,
    config,
  );
  const entries = rewardContracts.flatMap((r, i) =>
    Array.from(
      { length: count(lengths[i], 1000, "Reward token count") },
      (_, j) => ({ ...r, index: j }),
    ),
  );
  const tokens: Address[] = await many(
    client,
    block,
    entries.map((e) => call(e.address, "rewards", BigInt(e.index))),
    false,
    config,
  );
  const amounts: bigint[] = await many(
    client,
    block,
    entries.map((e, i) =>
      call(e.address, "tokenRewardsPerEpoch", tokens[i], epoch),
    ),
    false,
    config,
  );
  const unique = [
    ...new Set(
      tokens
        .filter((_, i) => amounts[i] > 0n)
        .map((t) => t.toLowerCase())
        .concat(WETH.toLowerCase()),
    ),
  ] as Address[];
  const priceMap = await prices(unique, Number(timestamp));
  assert(
    priceMap.has(WETH.toLowerCase()),
    "Fresh WETH/USD price is required for gas limits",
  );
  const decimals = await many(
    client,
    block,
    unique.map((t) => call(t, "decimals")),
    true,
    config,
  );
  const decimalMap = new Map(unique.map((t, i) => [t, decimals[i]]));
  entries.forEach((e, i) => {
    if (amounts[i] === 0n) return;
    const token = tokens[i].toLowerCase() as Address,
      price = priceMap.get(token),
      dec = decimalMap.get(token);
    const usd =
      price !== undefined && Number.isInteger(dec) && dec >= 0 && dec <= 36
        ? Number(formatUnits(amounts[i], dec)) * price
        : null;
    assert(usd === null || Number.isFinite(usd), "Invalid reward valuation");
    pools[e.pool].rewards.push({
      token,
      amount: amounts[i].toString(),
      source: e.source,
      usd,
    });
    if (usd !== null) pools[e.pool].rewardUsd += usd;
  });
  const unpriced = [
    ...new Set(
      pools.flatMap((p) =>
        p.rewards.filter((r) => r.usd === null).map((r) => r.token),
      ),
    ),
  ];
  return {
    pools,
    ethUsd: priceMap.get(WETH.toLowerCase())!,
    unpriced,
    registeredPools: addresses.length,
    activePools: active.length,
  };
}

export async function collect(
  client: PublicClient,
  walletAddresses: string[],
  config?: ReadConfig,
): Promise<Snapshot> {
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
  assert((await client.getChainId()) === 8453, "RPC must be Base (8453)");
  const block = await client.getBlock({ blockTag: "latest" });
  assert(block.number !== null, "Missing block number");
  const [ve, voter, epoch, start, end, maxPools, n] = await many(
    client,
    block.number,
    [
      call(VOTER, "ve"),
      call(VE, "voter"),
      call(VOTER, "epochStart", block.timestamp),
      call(VOTER, "epochVoteStart", block.timestamp),
      call(VOTER, "epochVoteEnd", block.timestamp),
      call(VOTER, "maxVotingNum"),
      call(VOTER, "length"),
    ],
    false,
    config,
  );
  assert(
    ve.toLowerCase() === VE.toLowerCase() &&
      voter.toLowerCase() === VOTER.toLowerCase(),
    "Aerodrome deployment mismatch",
  );
  // Both branches use the same fixed block but do not depend on each other's
  // results, so run them in parallel after deployment validation.
  const [nfts, poolDiscovery] = await Promise.all([
    discoverNfts(client, block.number, owners, Number(epoch), config),
    discoverPools(
      client,
      block.number,
      block.timestamp,
      epoch,
      n,
      config,
    ),
  ]);
  return {
    block: block.number.toString(),
    timestamp: Number(block.timestamp),
    epoch: Number(epoch),
    voteStart: Number(start),
    voteEnd: Number(end),
    maxPools: Number(maxPools),
    nfts,
    ...poolDiscovery,
  };
}

type Candidate = {
  p: Pool;
  r: number;
  b: number;
  f: number;
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
  // Build one candidate per valued, live pool. `b` is external voting power
  // (all local NFT votes are removed first), while `f` is local power that the
  // current run cannot move. `maxGain` is an upper bound used only for safe
  // pre-filtering/ranking; the exact allocation is solved below.
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
      const r = p.rewardUsd * (1 - policy.rewardHaircut);
      const b = Math.max(1e-18, units(BigInt(p.votes) - all) * policy.dilution);
      const f = units(fixed);
      const cap = Math.min(total * policy.maxShare, total);
      const maxGain =
        r * ((f + cap) / (b + f + cap) - f / (b + f));
      return {
        p,
        r,
        b,
        f,
        density: r / Math.max(b + f, 1e-18),
        maxGain,
      };
    });
  if (!valued.length) return { candidates: [], valuedPools: 0 };

  const minimum = Math.ceil(1 / policy.maxShare - 1e-10);
  const passes = (c: Candidate) =>
    c.p.rewardUsd >= policy.candidateMinRewardUsd &&
    c.density >= policy.candidateMinRewardPerVoteUsd &&
    c.maxGain >= policy.candidateMinExpectedGainUsd;
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

  if (policy.candidatePoolLimit > 0 && candidates.length > policy.candidatePoolLimit) {
    const limit = Math.max(minimum, policy.candidatePoolLimit);
    candidates = candidates
      .sort((a, b) => b.maxGain - a.maxGain || b.r - a.r)
      .slice(0, limit);
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
  const k = Math.min(policy.maxPools, snapshot.maxPools);
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
      data: encodeFunctionData({
        abi: ABI,
        functionName: "vote",
        args: [
          BigInt(n.tokenId),
          usable.map((v) => v.c.p.address),
          usable.map((v) => v.w),
        ],
      }),
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

export function executionWindow(
  timestamp: number,
  snapshot: Snapshot,
  policy: Policy,
) {
  return (
    timestamp > snapshot.voteStart &&
    timestamp >= snapshot.voteEnd - policy.executionLeadSeconds &&
    timestamp < snapshot.voteEnd - policy.deadlineBufferSeconds &&
    Math.floor(timestamp / WEEK) * WEEK === snapshot.epoch
  );
}
type JournalEntry = {
  hash: Hex;
  owner: Address;
  nonce: number;
  status: "prepared" | "confirmed" | "reverted";
  epoch: number;
  tokenId: string;
};
export type Journal = Record<string, JournalEntry>;
export type ExecutionDeps = {
  accountFor(owner: Address): Promise<LocalAccount>;
  readJournal(): Promise<Journal>;
  writeJournal(journal: Journal): Promise<void>;
};
export function makeExecutionDeps(
  signerVariablePaths: Record<string, string> = {},
): ExecutionDeps {
  return {
    async accountFor(owner) {
      const path = Object.entries(signerVariablePaths).find(
        ([a]) => a.toLowerCase() === owner.toLowerCase(),
      )?.[1];
      assert(
        path && /^[uf]\//.test(path),
        `Missing signer secret variable path for ${owner}`,
      );
      let value: string;
      try {
        value = await wmill.getVariable(path);
      } catch {
        throw new Error("Unable to read signer secret variable");
      }
      assert(
        /^0x[0-9a-fA-F]{64}$/.test(value),
        "Signer variable must contain a hex private key",
      );
      try {
        return privateKeyToAccount(value as Hex);
      } catch {
        throw new Error("Invalid signing key");
      }
    },
    async readJournal() {
      return (await wmill.getState("f/aerodrome/__vote_state")) ?? {};
    },
    async writeJournal(journal) {
      await wmill.setState(journal, "f/aerodrome/__vote_state");
    },
  };
}
export async function execute(
  client: PublicClient,
  snapshot: Snapshot,
  allocations: Allocation[],
  policy: Policy,
  dryRun: boolean,
  deps?: ExecutionDeps,
) {
  assert(typeof dryRun === "boolean", "dryRun must be a boolean");
  assert(dryRun || deps, "Execution requires signing and journal adapters");
  const journal = dryRun ? {} : await deps!.readJournal();
  const results: Record<string, unknown>[] = [];
  for (const a of allocations) {
    const latest = await client.getBlock();
    assert(
      Number(latest.timestamp) - snapshot.timestamp <=
        policy.maxSnapshotAgeSeconds,
      "Snapshot expired; rerun collection",
    );
    if (!executionWindow(Number(latest.timestamp), snapshot, policy)) {
      results.push({
        tokenId: a.tokenId,
        status: "outside_execution_window",
        data: a.data,
      });
      continue;
    }
    const [owner, last, power, kind] = await many(client, latest.number!, [
      call(VE, "ownerOf", BigInt(a.tokenId)),
      call(VOTER, "lastVoted", BigInt(a.tokenId)),
      call(VE, "balanceOfNFT", BigInt(a.tokenId)),
      call(VE, "escrowType", BigInt(a.tokenId)),
    ]);
    assert(
      owner.toLowerCase() === a.owner.toLowerCase() && kind === 0,
      "NFT ownership/type changed",
    );
    if (Number(last) >= snapshot.epoch) {
      results.push({ tokenId: a.tokenId, status: "already_voted" });
      continue;
    }
    assert(
      power.toString() === a.power,
      "Voting power changed; recompute allocation",
    );
    const key = `${snapshot.epoch}:${a.tokenId}`;
    if (!dryRun && journal[key] && journal[key].status !== "reverted") {
      // Never sign a second nonce after uncertain broadcast/crash. The prepared
      // hash is persisted before broadcast, including the crash-before-send case.
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
      await deps!.writeJournal(journal);
      if (receipt.status === "success") {
        results.push({
          tokenId: a.tokenId,
          status: "confirmed",
          hash: receipt.transactionHash,
        });
        continue;
      }
    }
    const args = [BigInt(a.tokenId), a.pools, a.weights.map(BigInt)] as const;
    try {
      await client.simulateContract({
        address: VOTER,
        abi: ABI,
        functionName: "vote",
        args,
        account: a.owner,
      });
    } catch {
      throw new Error(
        `Vote simulation failed for NFT ${a.tokenId}; no transaction sent`,
      );
    }
    const gas = await client.estimateContractGas({
      address: VOTER,
      abi: ABI,
      functionName: "vote",
      args,
      account: a.owner,
    });
    const gasLimit = (gas * 125n) / 100n;
    const fees = await client.estimateFeesPerGas();
    assert(fees.maxFeePerGas !== undefined, "Missing EIP-1559 fee quote");
    // Base L1 and operator fees are added using GasPriceOracle below.
    const oracleAbi = parseAbi([
      "function getL1Fee(bytes) view returns (uint256)",
      "function getOperatorFee(uint256) view returns (uint256)",
    ]);
    // Calldata padded to cover signature/envelope overhead conservatively.
    const envelope = (a.data + "ff".repeat(256)) as Hex;
    const l1 = await client.readContract({
      address: "0x420000000000000000000000000000000000000F",
      abi: oracleAbi,
      functionName: "getL1Fee",
      args: [envelope],
      authorizationList: undefined,
    });
    const operator = await client.readContract({
      address: "0x420000000000000000000000000000000000000F",
      abi: oracleAbi,
      functionName: "getOperatorFee",
      args: [gasLimit],
      authorizationList: undefined,
    });
    const feeWei = gasLimit * fees.maxFeePerGas + (l1 + operator) * 2n;
    const gasUsd = units(feeWei) * snapshot.ethUsd;
    if (
      gasUsd > policy.maxGasUsd ||
      a.estimatedRewardUsd - gasUsd < policy.minNetUsd
    ) {
      results.push({
        tokenId: a.tokenId,
        status: "below_net_return_or_gas_limit",
        gasUsd,
        estimatedRewardUsd: a.estimatedRewardUsd,
      });
      continue;
    }
    if (dryRun) {
      results.push({
        tokenId: a.tokenId,
        status: "simulated",
        to: VOTER,
        data: a.data,
        gasUsd,
        estimatedNetUsd: a.estimatedRewardUsd - gasUsd,
      });
      continue;
    }
    const account = await deps!.accountFor(a.owner);
    assert(
      account.address.toLowerCase() === a.owner.toLowerCase(),
      "Signing key does not own NFT",
    );
    const nonce = await client.getTransactionCount({
      address: a.owner,
      blockTag: "pending",
    });
    assert(
      nonce ===
        (await client.getTransactionCount({
          address: a.owner,
          blockTag: "latest",
        })),
      "Owner has pending transactions; retry after confirmation",
    );
    assert(
      (await client.getBalance({ address: a.owner })) >= feeWei,
      "Insufficient ETH for vote",
    );
    const beforeSign = await client.getBlock();
    assert(
      executionWindow(Number(beforeSign.timestamp), snapshot, policy),
      "Execution window closed",
    );
    const signed = await account.signTransaction({
      chainId: 8453,
      type: "eip1559",
      nonce,
      to: VOTER,
      data: a.data,
      value: 0n,
      gas: gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
    });
    const hash = keccak256(signed);
    journal[key] = {
      hash,
      owner: a.owner,
      nonce,
      status: "prepared",
      epoch: snapshot.epoch,
      tokenId: a.tokenId,
    };
    await deps!.writeJournal(journal);
    try {
      await client.sendRawTransaction({ serializedTransaction: signed });
    } catch {
      throw new Error(
        `Broadcast uncertain for NFT ${a.tokenId}, hash ${hash}; reconcile journal before retry`,
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
      throw new Error(`Vote pending: ${hash}; journal retained`);
    }
    journal[key].status =
      receipt.status === "success" ? "confirmed" : "reverted";
    await deps!.writeJournal(journal);
    assert(receipt.status === "success", `Vote reverted: ${hash}`);
    const post = await many(client, receipt.blockNumber, [
      call(VOTER, "lastVoted", BigInt(a.tokenId)),
      ...a.pools.map((p) => call(VOTER, "votes", BigInt(a.tokenId), p)),
    ]);
    assert(
      Number(post[0]) >= snapshot.epoch && post.slice(1).every((v) => v > 0n),
      `Vote postcondition failed: ${hash}`,
    );
    results.push({
      tokenId: a.tokenId,
      status: "confirmed",
      hash,
      gasUsd,
      estimatedNetUsd: a.estimatedRewardUsd - gasUsd,
    });
  }
  return results;
}
