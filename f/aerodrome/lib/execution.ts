import {
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  type Address,
  type FormattedTransaction,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import * as wmill from "windmill-client";
import {
  assert,
  call,
  callWithAbi,
  many as rpcMany,
  readOne,
  type Call,
  type PublicClient,
} from "./rpc.ts";
import {
  ABI,
  BASE_CHAIN_ID,
  DEFAULT_EXECUTOR_BATCH_SIZE,
  VE,
  VOTER,
  VOTE_EXECUTOR_ABI,
} from "./protocol.ts";
import {
  type Allocation,
  type ExecutionDeps,
  type ExecutionReport,
  type ExecutionSimulation,
  type ExecutionSnapshot,
  type Journal,
  type Policy,
  type VoteExecutorConfig,
  parseJournal,
  validatePolicy,
} from "./domain.ts";

function many<T>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
) {
  return rpcMany<T>(client, block, calls, ABI);
}

type ExecutionMode = "unsigned-simulation" | "signed-simulation" | "broadcast";

type FilledTransaction = FormattedTransaction<typeof base>;

type TransactionIntent = {
  from: Address;
  to: Address;
  input: Hex;
  value: bigint;
};

type ValidatedFilledTransaction = {
  from: Address;
  to: Address;
  input: Hex;
  value: bigint;
  chainId: number;
  nonce: number;
  gas: bigint;
} & (
  | { type: "legacy"; gasPrice: bigint }
  | {
      type: "eip1559";
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    }
);

function validateFilledTransaction(
  filled: FilledTransaction,
  intent: TransactionIntent,
): ValidatedFilledTransaction {
  assert(
    typeof filled.from === "string" && isAddress(filled.from),
    "Filled transaction is missing a valid sender",
  );
  assert(
    typeof filled.to === "string" && isAddress(filled.to),
    "Filled transaction is missing a valid target",
  );
  assert(isHex(filled.input), "Filled transaction is missing calldata");
  assert(
    typeof filled.value === "bigint" && typeof filled.chainId === "number" &&
      typeof filled.nonce === "number" && typeof filled.gas === "bigint",
    "Filled transaction is missing required fields",
  );
  assert(
    getAddress(filled.from) === getAddress(intent.from),
    "Filled transaction sender does not match adminAddress",
  );
  assert(
    getAddress(filled.to) === getAddress(intent.to),
    "Filled transaction target does not match voteExecutor",
  );
  assert(
    filled.input.toLowerCase() === intent.input.toLowerCase(),
    "Filled transaction data changed",
  );
  assert(filled.value === intent.value, "Filled transaction value changed");
  assert(
    filled.chainId === BASE_CHAIN_ID,
    `Filled transaction chainId is not Base mainnet (${BASE_CHAIN_ID})`,
  );
  assert(filled.gas > 0n, "Filled transaction is missing gas");
  assert(filled.nonce >= 0, "Filled transaction has an invalid nonce");
  const common = {
    from: getAddress(filled.from),
    to: getAddress(filled.to),
    input: filled.input,
    value: filled.value,
    chainId: filled.chainId,
    nonce: filled.nonce,
    gas: filled.gas,
  } as const;
  const legacyFees = filled.gasPrice !== undefined;
  const eip1559Fees =
    filled.maxFeePerGas !== undefined ||
    filled.maxPriorityFeePerGas !== undefined;
  if (filled.type === "legacy" || (filled.type === undefined && legacyFees)) {
    assert(
      filled.gasPrice !== undefined &&
        !eip1559Fees,
      "Legacy filled transaction must contain only gasPrice",
    );
    return { ...common, type: "legacy", gasPrice: filled.gasPrice };
  }
  if (
    filled.type === "eip1559" ||
    (filled.type === undefined && eip1559Fees)
  ) {
    assert(
      filled.maxFeePerGas !== undefined &&
        filled.maxPriorityFeePerGas !== undefined &&
        filled.gasPrice === undefined,
      "EIP-1559 filled transaction must contain both fee fields",
    );
    return {
      ...common,
      type: "eip1559",
      maxFeePerGas: filled.maxFeePerGas,
      maxPriorityFeePerGas: filled.maxPriorityFeePerGas,
    };
  }
  throw new Error(`Unsupported filled transaction type: ${String(filled.type)}`);
}

function signableTransaction(filled: ValidatedFilledTransaction) {
  const base = {
    chainId: filled.chainId,
    nonce: filled.nonce,
    to: filled.to,
    data: filled.input,
    value: filled.value,
    gas: filled.gas,
  } as const;
  return filled.type === "legacy"
    ? { ...base, gasPrice: filled.gasPrice }
    : {
        ...base,
        type: filled.type,
        maxFeePerGas: filled.maxFeePerGas,
        maxPriorityFeePerGas: filled.maxPriorityFeePerGas,
      };
}

function transactionDetails(
  filled: ValidatedFilledTransaction,
  estimatedGas?: string,
) {
  return {
    to: filled.to,
    data: filled.input,
    chainId: filled.chainId,
    nonce: filled.nonce,
    ...(estimatedGas === undefined ? {} : { estimatedGas }),
    gasLimit: filled.gas.toString(),
    ...(filled.type === "legacy"
      ? { gasPrice: filled.gasPrice.toString() }
      : {
          maxFeePerGas: filled.maxFeePerGas.toString(),
          maxPriorityFeePerGas: filled.maxPriorityFeePerGas.toString(),
        }),
  };
}

export function withinVotingWindow(timestamp: number, snapshot: ExecutionSnapshot) {
  return timestamp > snapshot.voteStart && timestamp < snapshot.voteEnd;
}

export function makeExecutionDeps(adminVariablePath: string): ExecutionDeps {
  async function accountFromVariable(path: string | undefined, label: string) {
    assert(path && /^[uf]\//.test(path), `Missing ${label} secret variable path`);
    let value: string;
    try {
      value = await wmill.getVariable(path);
    } catch {
      throw new Error(`Unable to read ${label} secret variable`);
    }
    assert(
      isHex(value) && value.length === 66,
      `${label} variable must contain a hex private key`,
    );
    try {
      return privateKeyToAccount(value);
    } catch {
      throw new Error(`Invalid ${label} signing key`);
    }
  }
  const deps: ExecutionDeps = {
    async readJournal() {
      return parseJournal(await wmill.getState("f/aerodrome/__vote_state"));
    },
    async writeJournal(journal: Journal) {
      await wmill.setState(journal, "f/aerodrome/__vote_state");
    },
  };
  if (adminVariablePath) {
    deps.adminAccount = async () =>
      accountFromVariable(adminVariablePath, "admin");
  }
  return deps;
}

type PreparedBatchVote = {
  allocation: Allocation;
  key: string;
};

type VoteBatch = {
  tokenIds: string[];
  intent: TransactionIntent;
};

type Eip1559Fees = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

function makeVoteBatch(
  votes: readonly PreparedBatchVote[],
  voteExecutor: Address,
  adminAddress: Address,
): VoteBatch {
  const tokenIds = votes.map(({ allocation }) => allocation.tokenId);
  const data = encodeFunctionData({
    abi: VOTE_EXECUTOR_ABI,
    functionName: "voteMany",
    args: [
      tokenIds.map(BigInt),
      votes.map(({ allocation }) => allocation.pools),
      votes.map(({ allocation }) => allocation.weights.map(BigInt)),
    ],
  });
  return {
    tokenIds,
    intent: { from: adminAddress, to: voteExecutor, input: data, value: 0n },
  };
}

async function quoteEip1559Fees(client: PublicClient): Promise<Eip1559Fees> {
  const fees = await client.estimateFeesPerGas({
    chain: base,
    type: "eip1559",
  });
  assert(
    fees.maxFeePerGas !== undefined &&
      fees.maxPriorityFeePerGas !== undefined,
    "Missing EIP-1559 fee quote for vote simulation",
  );
  return fees;
}

async function simulateVoteBatch(
  client: PublicClient,
  batch: VoteBatch,
  fees: Eip1559Fees,
): Promise<ExecutionSimulation> {
  try {
    const [simulationBlock] = await client.simulateBlocks({
      blockTag: "latest",
      blocks: [{
        calls: [{
          account: batch.intent.from,
          to: batch.intent.to,
          data: batch.intent.input,
          value: batch.intent.value,
          type: "eip1559",
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }],
      }],
      validation: true,
      traceTransfers: false,
    });
    const [simulationCall] = simulationBlock?.calls ?? [];
    assert(simulationCall, "Invalid eth_simulateV1 response");
    assert(
      simulationCall.status === "success",
      `eth_simulateV1 reverted${simulationCall.error ? `: ${simulationCall.error.message}` : ""}`,
    );
    assert(
      typeof simulationCall.gasUsed === "bigint",
      "eth_simulateV1 response is missing gasUsed",
    );
    return {
      status: "success",
      ...(isHex(simulationCall.data)
        ? { returnData: simulationCall.data }
        : {}),
      gasUsed: simulationCall.gasUsed.toString(),
      ...(simulationBlock.number === undefined
        ? {}
        : { blockNumber: simulationBlock.number.toString() }),
    };
  } catch (error) {
    throw new Error(
      `Vote batch simulation failed for NFTs ${batch.tokenIds.join(",")}: ${String(error)}`,
    );
  }
}

async function fillVoteBatch(
  client: PublicClient,
  batch: VoteBatch,
  fees: Eip1559Fees,
): Promise<ValidatedFilledTransaction> {
  const { transaction } = await client.fillTransaction({
    chain: base,
    account: batch.intent.from,
    to: batch.intent.to,
    data: batch.intent.input,
    value: batch.intent.value,
    type: "eip1559",
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return validateFilledTransaction(transaction, batch.intent);
}

type ExecutionContext = {
  client: PublicClient;
  snapshot: ExecutionSnapshot;
  policy: Policy;
  deps: ExecutionDeps;
  voteExecutor: Address;
  adminAddress: Address;
  batchSize: number;
  mode: ExecutionMode;
};

function executionMode(dryRun: boolean, deps: ExecutionDeps): ExecutionMode {
  if (!dryRun) return "broadcast";
  return deps.adminAccount ? "signed-simulation" : "unsigned-simulation";
}

/** Execute atomic VoteExecutor batches with retry-safe journaling. */
async function executeBatched(
  context: ExecutionContext,
  allocations: Allocation[],
): Promise<ExecutionReport> {
  const {
    client,
    snapshot,
    policy,
    deps,
    voteExecutor,
    adminAddress,
    batchSize,
    mode,
  } = context;
  const journal = mode === "broadcast" ? await deps.readJournal() : {};
  const report: ExecutionReport = { batches: [], skipped: [] };
  const reconciled = new Map<
    string,
    {
      tokenIds: string[];
      nonce: number;
      receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
    }
  >();
  const latest = await client.getBlock();
  assert(
    Number(latest.timestamp) >= snapshot.timestamp &&
      Number(latest.timestamp) - snapshot.timestamp <=
        policy.maxSnapshotAgeSeconds,
    "Snapshot expired; rerun collection",
  );
  const pending = allocations.filter((allocation) => {
    if (withinVotingWindow(Number(latest.timestamp), snapshot)) return true;
    report.skipped.push({
      tokenId: allocation.tokenId,
      reason: "outside_voting_window",
    });
    return false;
  });
  const checks = pending.length
    ? await many<Address | bigint>(
        client,
        latest.number!,
        pending.flatMap((allocation) => [
          call<Address>(VE, "ownerOf", BigInt(allocation.tokenId)),
          call<bigint>(VOTER, "lastVoted", BigInt(allocation.tokenId)),
          call<bigint>(VE, "balanceOfNFT", BigInt(allocation.tokenId)),
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
      typeof owner === "string" &&
        typeof last === "bigint" &&
        typeof power === "bigint",
      "Unexpected precondition read result",
    );
    assert(
      owner.toLowerCase() === allocation.owner.toLowerCase(),
      "NFT ownership changed",
    );
    if (Number(last) >= snapshot.epoch) {
      report.skipped.push({
        tokenId: allocation.tokenId,
        reason: "already_voted",
      });
      continue;
    }
    assert(
      power.toString() === allocation.power,
      "Voting power changed; recompute allocation",
    );
    const key = `${snapshot.epoch}:${allocation.tokenId}`;
    if (mode === "broadcast" && journal[key] && journal[key].status !== "reverted") {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: journal[key].hash });
      } catch {
        throw new Error(
          `Unresolved vote ${journal[key].hash}; reconcile nonce ${journal[key].nonce} before retry`,
        );
      }
      journal[key].status =
        receipt.status === "success" ? "confirmed" : "reverted";
      await deps.writeJournal(journal);
      if (receipt.status === "success") {
        const existing = reconciled.get(receipt.transactionHash) ?? {
          tokenIds: [],
          nonce: journal[key].nonce,
          receipt,
        };
        existing.tokenIds.push(allocation.tokenId);
        reconciled.set(receipt.transactionHash, existing);
        continue;
      }
    }
    prepared.push({ allocation, key });
  }

  let account: LocalAccount | undefined;

  for (let start = 0; start < prepared.length; start += batchSize) {
    const batch = prepared.slice(start, start + batchSize);
    const voteBatch = makeVoteBatch(batch, voteExecutor, adminAddress);
    const fees = await quoteEip1559Fees(client);
    const simulation = await simulateVoteBatch(client, voteBatch, fees);
    const validated = await fillVoteBatch(client, voteBatch, fees);
    const { tokenIds } = voteBatch;
    const gasDetails = transactionDetails(
      validated,
      simulation.gasUsed,
    );
    if (mode === "unsigned-simulation") {
      report.batches.push({
        tokenIds,
        status: "simulated",
        source: "executed",
        transaction: { ...gasDetails },
        simulation,
      });
      continue;
    }

    const pendingNonce = await client.getTransactionCount({
      address: adminAddress,
      blockTag: "pending",
    });
    const latestNonce = await client.getTransactionCount({
      address: adminAddress,
      blockTag: "latest",
    });
    assert(
      pendingNonce === latestNonce && validated.nonce === pendingNonce,
      "Admin has pending transactions or filled nonce is stale; retry after confirmation",
    );
    const beforeSign = await client.getBlock();
    assert(
      withinVotingWindow(Number(beforeSign.timestamp), snapshot),
      "Voting window closed or not started",
    );
    if (!account) {
      assert(deps.adminAccount, "Execution requires admin account when signing");
      account = await deps.adminAccount();
      assert(
        account.address.toLowerCase() === adminAddress.toLowerCase(),
        "Admin signing key does not match adminAddress",
      );
    }
    assert(account, "Execution requires admin account when signing");
    const signed = await account.signTransaction(signableTransaction(validated));
    const hash = keccak256(signed);

    if (mode === "signed-simulation") {
      report.batches.push({
        tokenIds,
        status: "simulated",
        source: "executed",
        transaction: {
          ...gasDetails,
          signedHash: hash,
        },
        simulation,
      });
      continue;
    }

    for (const { allocation, key } of batch)
      journal[key] = {
        hash,
        owner: allocation.owner,
        sender: adminAddress,
        nonce: validated.nonce,
        status: "prepared",
        epoch: snapshot.epoch,
        tokenId: allocation.tokenId,
      };
    await deps.writeJournal(journal);
    try {
      await client.sendRawTransaction({ serializedTransaction: signed });
    } catch {
      throw new Error(
        `Broadcast uncertain for vote batch ${hash}; reconcile nonce ${validated.nonce} before retry`,
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

    report.batches.push({
      tokenIds,
      status: "confirmed",
      source: "executed",
      transaction: { ...gasDetails },
      broadcast: {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        ...(receipt.effectiveGasPrice === undefined
          ? {}
          : { effectiveGasPrice: receipt.effectiveGasPrice.toString() }),
      },
    });
  }
  for (const { tokenIds, nonce, receipt } of reconciled.values())
    report.batches.push({
      tokenIds,
      status: "confirmed",
      source: "reconciled",
      transaction: { to: voteExecutor, nonce },
      broadcast: {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        ...(receipt.effectiveGasPrice === undefined
          ? {}
          : { effectiveGasPrice: receipt.effectiveGasPrice.toString() }),
      },
    });
  return report;
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
  assert(deps, "Execution requires admin and journal adapters");
  validatePolicy(policy);
  const voteExecutor = executorConfig.voteExecutor
    ? getAddress(executorConfig.voteExecutor)
    : undefined;
  const adminAddress = executorConfig.adminAddress
    ? getAddress(executorConfig.adminAddress)
    : undefined;
  assert(voteExecutor, "voteExecutor is required");
  assert(adminAddress, "adminAddress is required");
  assert(
    dryRun || deps.adminAccount,
    "Execution requires adminAccount when dryRun is false",
  );
  const batchSize = executorConfig.batchSize ?? DEFAULT_EXECUTOR_BATCH_SIZE;
  assert(
    Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 50,
    "executor batchSize must be an integer from 1 to 50",
  );
  const [configuredAdmin, configuredVoter] = await Promise.all([
    readOne<Address>(
      client,
      BigInt(snapshot.block),
      callWithAbi(voteExecutor, "admin", VOTE_EXECUTOR_ABI),
      VOTE_EXECUTOR_ABI,
    ),
    readOne<Address>(
      client,
      BigInt(snapshot.block),
      callWithAbi(voteExecutor, "AERODROME_VOTER", VOTE_EXECUTOR_ABI),
      VOTE_EXECUTOR_ABI,
    ),
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
    {
      client,
      snapshot,
      policy,
      deps,
      voteExecutor,
      adminAddress,
      batchSize,
      mode: executionMode(dryRun, deps),
    },
    allocations,
  );
}
