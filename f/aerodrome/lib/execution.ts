import {
  encodeFunctionData,
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
} from "./domain.ts";

function many<T>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
) {
  return rpcMany<T>(client, block, calls, ABI);
}

type ExecutionMode = "unsigned-simulation" | "signed-simulation" | "broadcast";

async function simulateTransaction(
  client: PublicClient,
  request: Parameters<PublicClient["call"]>[0],
): Promise<ExecutionSimulation> {
  const { data } = await client.call(request);
  return {
    status: "success",
    ...(data === undefined ? {} : { returnData: data }),
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
      /^0x[0-9a-fA-F]{64}$/.test(value),
      `${label} variable must contain a hex private key`,
    );
    try {
      return privateKeyToAccount(value as Hex);
    } catch {
      throw new Error(`Invalid ${label} signing key`);
    }
  }
  const deps: ExecutionDeps = {
    async readJournal() {
      return (await wmill.getState("f/aerodrome/__vote_state")) ?? {};
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

/** Execute atomic VoteExecutor batches with retry-safe journaling. */
async function executeBatched(
  client: PublicClient,
  snapshot: ExecutionSnapshot,
  allocations: Allocation[],
  policy: Policy,
  dryRun: boolean,
  deps: ExecutionDeps,
  voteExecutor: VoteExecutorConfig["voteExecutor"],
  adminAddress: VoteExecutorConfig["adminAddress"],
  batchSize: number,
): Promise<ExecutionReport> {
  const mode: ExecutionMode = dryRun
    ? deps.adminAccount
      ? "signed-simulation"
      : "unsigned-simulation"
    : "broadcast";
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
    const tokenIds = batch.map(({ allocation }) => allocation.tokenId);
    const encodedTokenIds = tokenIds.map(BigInt);
    const pools = batch.map(({ allocation }) => allocation.pools);
    const weights = batch.map(({ allocation }) => allocation.weights.map(BigInt));
    const args = [encodedTokenIds, pools, weights] as const;
    const data = encodeFunctionData({
      abi: VOTE_EXECUTOR_ABI,
      functionName: "voteMany",
      args,
    });

    if (mode === "unsigned-simulation") {
      let simulation: ExecutionSimulation;
      try {
        simulation = await simulateTransaction(client, {
          account: adminAddress,
          to: voteExecutor,
          data,
          value: 0n,
        });
      } catch {
        throw new Error(
          `Vote batch simulation failed for NFTs ${tokenIds.join(",")}; no transaction sent`,
        );
      }
      report.batches.push({
        tokenIds,
        status: "simulated",
        source: "executed",
        transaction: { to: voteExecutor, data },
        simulation,
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
    assert(
      fees.maxPriorityFeePerGas !== undefined,
      "Missing EIP-1559 priority fee quote",
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
    const transaction = {
      chainId: 8453,
      type: "eip1559",
      nonce,
      to: voteExecutor,
      data,
      value: 0n,
      gas: gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    } as const;
    const signed = await account.signTransaction(transaction);
    const hash = keccak256(signed);

    if (mode === "signed-simulation") {
      let simulation: ExecutionSimulation;
      try {
        simulation = await simulateTransaction(client, {
          account: adminAddress,
          to: voteExecutor,
          data,
          value: 0n,
          gas: gasLimit,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
      } catch {
        throw new Error(
          `Signed vote batch simulation failed for NFTs ${tokenIds.join(",")}; no transaction sent`,
        );
      }
      report.batches.push({
        tokenIds,
        status: "simulated",
        source: "executed",
        transaction: {
          to: voteExecutor,
          data,
          nonce,
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

    report.batches.push({
      tokenIds,
      status: "confirmed",
      source: "executed",
      transaction: { to: voteExecutor, data, nonce },
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
