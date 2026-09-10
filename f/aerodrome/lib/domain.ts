import {
  getAddress,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

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

export type CollectStepTimings = {
  sugarNftMs: number;
  sugarPoolMs: number;
  rewardPricesMs: number;
};

export type CollectTimings = {
  deploymentValidationMs: number;
  sugarValidationMs: number;
  nftDiscoveryMs: number;
  poolDiscoveryMs: number;
  steps: CollectStepTimings;
};

export type CollectResult = {
  snapshot: Snapshot;
  timings: CollectTimings;
};

export type PoolDiscovery = {
  pools: Pool[];
  unpriced: string[];
  registeredPools: number;
  activePools: number;
};

export type ExecutionSnapshot = Pick<
  Snapshot,
  "block" | "timestamp" | "epoch" | "voteStart" | "voteEnd"
>;

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
  minSelectedShare: number;
  excludedPools: Address[];
  maxSnapshotAgeSeconds: number;
};

export const DEFAULT_POLICY: Policy = {
  dilution: 1.15,
  maxShare: 1,
  rewardHaircut: 0.1,
  candidateMinVotes: 0,
  candidateMinRewardPerVoteUsd: 0,
  minSelectedShare: 0.005,
  excludedPools: [],
  maxSnapshotAgeSeconds: 900,
};

/** Construct the complete internal policy from untrusted Flow overrides. */
export function resolvePolicy(overrides: Partial<Policy> = {}): Policy {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  validatePolicy(policy);
  return policy;
}

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

export type JournalEntry = {
  hash: Hex;
  owner: Address;
  sender?: Address;
  nonce: number;
  status: "prepared" | "confirmed" | "reverted";
  epoch: number;
  tokenId: string;
};

export type Journal = Record<string, JournalEntry>;

/** Parse Windmill state once at the persistence boundary. */
export function parseJournal(value: unknown): Journal {
  if (value === null || value === undefined) return {};
  assertRecord(value, "Vote journal must be an object");
  const journal: Journal = {};
  for (const [key, raw] of Object.entries(value)) {
    assertRecord(raw, `Invalid vote journal entry ${key}`);
    const hash = raw.hash;
    const owner = raw.owner;
    const sender = raw.sender;
    const nonce = raw.nonce;
    const status = raw.status;
    const epoch = raw.epoch;
    const tokenId = raw.tokenId;
    if (
      !isHex(hash) || hash.length !== 66 ||
      typeof owner !== "string" || !isAddress(owner) ||
      (sender !== undefined &&
        (typeof sender !== "string" || !isAddress(sender))) ||
      !Number.isInteger(nonce) || nonce < 0 ||
      !isJournalStatus(status) ||
      !Number.isInteger(epoch) || typeof tokenId !== "string"
    )
      throw new Error(`Invalid vote journal entry ${key}`);
    journal[key] = {
      hash,
      owner: getAddress(owner),
      ...(sender === undefined ? {} : { sender: getAddress(sender) }),
      nonce,
      status,
      epoch,
      tokenId,
    };
  }
  return journal;
}

function isJournalStatus(
  value: unknown,
): value is JournalEntry["status"] {
  return value === "prepared" || value === "confirmed" || value === "reverted";
}

function assertRecord(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(message);
}

export type ExecutionSkipReason = "already_voted" | "outside_voting_window";

export type ExecutionSkip = {
  tokenId: string;
  reason: ExecutionSkipReason;
};

export type ExecutionSimulation = {
  status: "success" | "not_run";
  returnData?: Hex;
  gasUsed?: string;
  blockNumber?: string;
};

export type ExecutionBroadcast = {
  status: "success" | "reverted";
  transactionHash: Hex;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice?: string;
};

export type ExecutionBatchResult = {
  tokenIds: string[];
  status: "simulated" | "confirmed";
  source: "executed" | "reconciled";
  transaction: {
    to: Address;
    data?: Hex;
    chainId?: number;
    nonce?: number;
    estimatedGas?: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    signedHash?: Hex;
  };
  simulation?: ExecutionSimulation;
  broadcast?: ExecutionBroadcast;
};

export type ExecutionReport = {
  batches: ExecutionBatchResult[];
  skipped: ExecutionSkip[];
};

export type ExecutionDeps = {
  /** Optional in unsigned dry-run mode; required when signing or broadcasting. */
  adminAccount?(): Promise<import("viem").LocalAccount>;
  readJournal(): Promise<Journal>;
  writeJournal(journal: Journal): Promise<void>;
};

export type VoteExecutorConfig = {
  voteExecutor: Address;
  adminAddress: Address;
  /** Maximum NFTs included in one VoteExecutor.voteMany transaction. */
  batchSize?: number;
};

export function validatePolicy(policy: Policy) {
  for (const [key, value] of Object.entries(policy)) {
    if (key === "excludedPools") continue;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`Invalid policy ${key}`);
  }
  if (
    !Array.isArray(policy.excludedPools) ||
    !policy.excludedPools.every(
      (pool) => isAddress(pool) && getAddress(pool) !== ZERO_ADDRESS,
    )
  )
    throw new Error("Invalid excludedPools");
  if (
    policy.dilution < 1 ||
    policy.dilution > 10 ||
    policy.maxShare <= 0 ||
    policy.maxShare > 1
  )
    throw new Error("Invalid dilution/maxShare");
  if (
    policy.rewardHaircut < 0 ||
    policy.rewardHaircut >= 1 ||
    policy.candidateMinVotes < 0 ||
    policy.candidateMinRewardPerVoteUsd < 0 ||
    policy.minSelectedShare < 0 ||
    policy.minSelectedShare > policy.maxShare
  )
    throw new Error("Invalid cost policy");
  if (
    policy.maxSnapshotAgeSeconds <= 0 ||
    policy.maxSnapshotAgeSeconds > 3600
  )
    throw new Error("Invalid snapshot age");
}
