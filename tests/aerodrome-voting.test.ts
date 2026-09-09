import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits, decodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  optimize,
  optimizeDetailed,
  withinVotingWindow,
  validatePolicy,
  execute,
  mapWithConcurrency,
  DEFAULT_POLICY,
  DEFAULT_EXECUTOR_BATCH_SIZE,
  VOTER,
  VOTE_EXECUTOR_ABI,
  type Snapshot,
  type Nft,
} from "../f/aerodrome/lib/vote.ts";
import { readPoolView } from "../f/aerodrome/lib/pool_view.ts";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const raw = (n: number) => parseUnits(String(n), 18).toString();
function nft(id: number, power: number): Nft {
  return {
    tokenId: String(id),
    owner: addr(100 + id),
    power: raw(power),
    lastVoted: 0,
    managedId: "0",
    permanent: true,
    current: {},
    eligible: true,
  };
}
function fixture(): Snapshot {
  return {
    block: "1",
    timestamp: 604900,
    epoch: 604800,
    voteStart: 608400,
    voteEnd: 1206000,
    maxPools: 30,
    nfts: [nft(1, 100), nft(2, 100)],
    pools: [
      {
        address: addr(1),
        gauge: addr(11),
        votes: raw(100),
        rewardUsd: 100,
        rewards: [],
      },
      {
        address: addr(2),
        gauge: addr(12),
        votes: raw(100),
        rewardUsd: 100,
        rewards: [],
      },
    ],
    unpriced: [],
    registeredPools: 2,
    activePools: 2,
  };
}
const policy = { ...DEFAULT_POLICY, dilution: 1, rewardHaircut: 0 };
assert.equal(DEFAULT_EXECUTOR_BATCH_SIZE, 16);
test("bounded concurrency preserves order and bounds in-flight work", async () => {
  let active = 0;
  let maxActive = 0;
  const result = await mapWithConcurrency(
    [1, 2, 3, 4, 5],
    2,
    async (value, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 8 : 1));
      active -= 1;
      return value * 10;
    },
  );
  assert.equal(maxActive, 2);
  assert.deepEqual(result, [10, 20, 30, 40, 50]);
});
test("PoolView must be bound to the official Voter before reading pool data", async () => {
  const fake = {
    async readContract() {
      return addr(999);
    },
  } as unknown as Parameters<typeof readPoolView>[0];
  await assert.rejects(
    readPoolView(fake, 1n, 1n, addr(500), VOTER),
    /different Voter/,
  );
});
test("joint rewards include self dilution and match the analytic optimum", () => {
  const s = fixture(),
    plans = optimize(s, policy);
  assert.equal(plans.length, 2);
  assert.ok(
    Math.abs(plans.reduce((sum, p) => sum + p.estimatedRewardUsd, 0) - 100) <
      1e-8,
  );
  for (const p of plans) {
    assert.equal(p.weights[0], p.weights[1]);
    assert.deepEqual(p.pools, [addr(1), addr(2)]);
  }
});
test("doubling voting power increases payout, never beyond pool rewards", () => {
  const s = fixture();
  const before = optimize(s, policy).reduce(
    (sum, p) => sum + p.estimatedRewardUsd,
    0,
  );
  s.nfts = s.nfts.map((n) => ({ ...n, power: raw(200) }));
  const after = optimize(s, policy).reduce(
    (sum, p) => sum + p.estimatedRewardUsd,
    0,
  );
  assert.ok(after > before);
  assert.ok(after < 200);
});
test("movable old votes are removed from pool denominators", () => {
  const baseline = optimize(fixture(), policy);
  const s = fixture();
  s.nfts[0].current = { [addr(1)]: raw(100) };
  s.pools[0].votes = raw(200);
  assert.deepEqual(optimize(s, policy), baseline);
});
test("ineligible positions are excluded from execution", () => {
  const s = fixture();
  s.nfts[0].eligible = false;
  s.nfts[0].reason = "already_voted";
  s.nfts[0].current = { [addr(1)]: raw(50) };
  s.pools[0].votes = raw(150);
  assert.deepEqual(
    optimize(s, policy).map((p) => p.tokenId),
    ["2"],
  );
  s.nfts[1].eligible = false;
  s.nfts[1].reason = "ineligible";
  assert.deepEqual(optimize(s, policy), []);
});
test("zero valued rewards produce no votes and no NaN", () => {
  const s = fixture();
  s.pools.forEach((p) => (p.rewardUsd = 0));
  assert.deepEqual(optimize(s, policy), []);
});
test("token IDs above JS safe integer survive optimization", () => {
  const s = fixture();
  s.nfts[0].tokenId = "900719925474099312345";
  const p = optimize(s, policy)[0];
  assert.equal(p.tokenId, s.nfts[0].tokenId);
});
test("cardinality and concentration constraints fail closed if incompatible", () => {
  const constrained = { ...fixture(), maxPools: 1 };
  assert.throws(
    () => optimize(constrained, { ...policy, maxShare: 0.5 }),
    /Too few/,
  );
  const p = optimize(fixture(), { ...policy, maxShare: 0.5 })[0];
  assert.equal(p.weights[0], p.weights[1]);
});
test("execution only requires the voting window to be open", () => {
  const s = fixture();
  assert.equal(withinVotingWindow(s.voteStart + 1, s), true);
  for (const t of [s.voteStart, s.voteStart - 1, s.voteEnd, s.voteEnd + 1])
    assert.equal(withinVotingWindow(t, s), false);
});
test("invalid inputs cannot silently turn off limits", () => {
  assert.throws(() => validatePolicy({ ...policy, maxSnapshotAgeSeconds: 0 }));
  const s = fixture();
  s.nfts[0].current = { [addr(1)]: raw(200) };
  assert.throws(() => optimize(s, policy), /smaller/);
});

test("a zero-vote incentive pool is not lost to rounding or subset selection", () => {
  const s=fixture();
  s.pools[0].votes="0";
  s.maxPools = 1;
  const plans=optimize(s,policy);
  assert.equal(plans[0].pools[0],s.pools[0].address);
  assert.ok(plans.reduce((sum,p)=>sum+p.estimatedRewardUsd,0)>99.99);
});

test("asymmetric rewards match marginal-return water filling", () => {
  const s=fixture();s.pools[0].rewardUsd=400;
  const p=optimize(s,policy)[0];
  const idx=p.pools.findIndex(a=>a===s.pools[0].address);
  const ratio=Number(p.weights[idx])/p.weights.reduce((sum,w)=>sum+Number(w),0);
  assert.ok(Math.abs(ratio-5/6)<1e-8);
});

test("candidate filtering reports reductions and preserves maxShare feasibility", () => {
  const s = fixture();
  s.pools.push({
    address: addr(3),
    gauge: addr(13),
    votes: raw(1000),
    rewardUsd: 1,
    rewards: [],
  });
  s.pools.push({
    address: addr(4),
    gauge: addr(14),
    votes: raw(10),
    rewardUsd: 1,
    rewards: [],
  });
  const result = optimizeDetailed(s, {
    ...policy,
    candidateMinVotes: 500,
    candidateMinRewardPerVoteUsd: 0.2,
  });
  assert.equal(result.metrics.valuedPools, 4);
  assert.equal(result.metrics.candidatePools, 3);
  assert.equal(result.metrics.filteredPools, 1);
  // Pool 3 is high-vote/low-density and must remain a candidate even though
  // the optimizer is allowed to assign it zero final weight.
  assert.equal(result.metrics.selectedPools, 2);
  assert.equal(result.allocations.length, 2);
});

test("strict candidate thresholds fall back to enough pools for concentration cap", () => {
  const result = optimizeDetailed(fixture(), {
    ...policy,
    maxShare: 0.5,
    candidateMinVotes: 1_000_000,
    candidateMinRewardPerVoteUsd: 1_000_000,
  });
  assert.equal(result.metrics.candidatePools, 2);
  assert.equal(result.metrics.selectedPools, 2);
});

test("minimum selected share removes tiny pools before weight encoding", () => {
  const result = optimizeDetailed(fixture(), {
    ...policy,
    minSelectedShare: 0.51,
  });
  assert.equal(result.metrics.selectedPools, 1);
  assert.deepEqual(result.allocations[0].weights, ["1000000000000"]);
});

test("excluded pools are removed before candidate selection and fallback", () => {
  const excluded = fixture().pools[0].address;
  const result = optimizeDetailed(fixture(), {
    ...policy,
    excludedPools: [`0x${excluded.slice(2).toUpperCase()}` as typeof excluded],
  });
  assert.deepEqual(result.metrics.selectedPoolAddresses, [addr(2)]);
  assert.equal(result.allocations[0].pools[0], addr(2));
});

test("excluded pool addresses must be valid non-zero addresses", () => {
  assert.throws(
    () => validatePolicy({ ...policy, excludedPools: ["not-an-address"] as never }),
    /excludedPools/,
  );
  assert.throws(
    () => validatePolicy({ ...policy, excludedPools: ["0x0000000000000000000000000000000000000000"] as never }),
    /excludedPools/,
  );
});

test("execution gates prevent signing after epoch end and gas estimation failure", async () => {
  const s=fixture();s.timestamp=s.voteEnd-3600;
  const plans=optimize(s,policy);let signed=0;
  const fake={
    async getBlock(){return {number:2n,timestamp:BigInt(s.timestamp)};},
    async multicall(){return [plans[0].owner,0n,BigInt(plans[0].power),0].map(result=>({status:"success",result}));},
    async estimateContractGas(){throw Error("revert");},
    async readContract(args: { functionName: string }) {
      return args.functionName === "admin" ? addr(901) : VOTER;
    },
  } as unknown as Parameters<typeof execute>[0];
  const deps={async readJournal(){return {};},async writeJournal(){},async adminAccount(){signed++;throw Error("must not sign");}};
  const config = { voteExecutor: addr(900), adminAddress: addr(901) };
  await assert.rejects(execute(fake,s,[plans[0]],policy,false,deps,config),/revert/);
  assert.equal(signed,0);
  s.timestamp=s.voteEnd;
  const expired=await execute(fake,s,[plans[0]],policy,false,deps,config);
  assert.equal(expired.skipped[0].reason,"outside_voting_window");assert.equal(signed,0);
});

test("executor mode simulates with the admin and wrapper target", async () => {
  const s = fixture();
  s.timestamp = s.voteEnd - 3600;
  const allocation = optimize(s, policy)[0];
  const executor = addr(900);
  const admin = addr(901);
  let simulation: { to: Address; account: Address } | undefined;
  const fake = {
    async getBlock() {
      return { number: 2n, timestamp: BigInt(s.timestamp) };
    },
    async multicall() {
      return [allocation.owner, 0n, BigInt(allocation.power), 0].map((result) => ({
        status: "success",
        result,
      }));
    },
    async call(args: { to: Address; account: Address }) {
      simulation = { to: args.to, account: args.account };
      return { data: "0x" };
    },
    async estimateContractGas() {
      return 100000n;
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    },
    async readContract(args: { functionName: string }) {
      if (args.functionName === "admin") return admin;
      if (args.functionName === "AERODROME_VOTER") return VOTER;
      return 0n;
    },
  } as unknown as Parameters<typeof execute>[0];
  const result = await execute(
    fake,
    s,
    [allocation],
    policy,
    true,
    { async readJournal(){return {};}, async writeJournal(){} },
    { voteExecutor: executor, adminAddress: admin },
  );
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].status, "simulated");
  assert.equal(result.batches[0].transaction.to.toLowerCase(), executor.toLowerCase());
  assert.equal(result.batches[0].simulation?.status, "success");
  assert.equal(simulation?.to.toLowerCase(), executor.toLowerCase());
  assert.equal(simulation?.account.toLowerCase(), admin.toLowerCase());
});

test("executor batch mode encodes one atomic voteMany call", async () => {
  const s = fixture();
  s.timestamp = s.voteEnd - 3600;
  const allocations = optimize(s, policy);
  const executor = addr(910);
  const admin = addr(911);
  let simulation: { to: Address; account: Address } | undefined;
  const fake = {
    async getBlock() {
      return { number: 2n, timestamp: BigInt(s.timestamp) };
    },
    async multicall(args: { contracts: Array<{ functionName: string; args?: readonly unknown[] }> }) {
      return args.contracts.map((call) => {
        const tokenId = Number(call.args?.[0] ?? 0n);
        const allocation = allocations.find((item) => Number(item.tokenId) === tokenId);
        if (call.functionName === "ownerOf") return { status: "success", result: allocation?.owner };
        if (call.functionName === "balanceOfNFT") return { status: "success", result: BigInt(allocation?.power ?? "0") };
        if (call.functionName === "lastVoted") return { status: "success", result: 0n };
        return { status: "success", result: 0 };
      });
    },
    async readContract(args: { functionName: string }) {
      if (args.functionName === "admin") return admin;
      if (args.functionName === "AERODROME_VOTER") return VOTER;
      return 0n;
    },
    async call(args: { to: Address; account: Address }) {
      simulation = { to: args.to, account: args.account };
      return { data: "0x" };
    },
    async estimateContractGas() {
      return 200000n;
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    },
  } as unknown as Parameters<typeof execute>[0];
  const result = await execute(
    fake,
    s,
    allocations,
    policy,
    true,
    { async readJournal(){return {};}, async writeJournal(){} },
    { voteExecutor: executor, adminAddress: admin, batchSize: 2 },
  );
  assert.equal(result.batches.length, 1);
  assert.deepEqual(result.batches[0].tokenIds, allocations.map((item) => item.tokenId));
  assert.equal(result.batches[0].status, "simulated");
  assert.equal(result.batches[0].transaction.to.toLowerCase(), executor.toLowerCase());
  assert.equal(result.batches[0].simulation?.status, "success");
  assert.equal(simulation?.to.toLowerCase(), executor.toLowerCase());
  assert.equal(simulation?.account.toLowerCase(), admin.toLowerCase());
  assert.equal(
    decodeFunctionData({
      abi: VOTE_EXECUTOR_ABI,
      data: result.batches[0].transaction.data as `0x${string}`,
    }).functionName,
    "voteMany",
  );
});

test("executor dry-run signs locally and simulates without broadcasting", async () => {
  const s = fixture();
  s.timestamp = s.voteEnd - 3600;
  const allocation = optimize(s, policy)[0];
  const executor = addr(920);
  const admin = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
  let contractSimulations = 0;
  let ethCalls = 0;
  let broadcasts = 0;
  let journalWrites = 0;
  const fake = {
    async getBlock() {
      return { number: 2n, timestamp: BigInt(s.timestamp) };
    },
    async multicall() {
      return [allocation.owner, 0n, BigInt(allocation.power), 0].map((result) => ({
        status: "success",
        result,
      }));
    },
    async readContract(args: { functionName: string }) {
      if (args.functionName === "admin") return admin.address;
      if (args.functionName === "AERODROME_VOTER") return VOTER;
      return 0n;
    },
    async simulateContract() {
      contractSimulations++;
    },
    async estimateContractGas() {
      return 100000n;
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    },
    async getTransactionCount() {
      return 7;
    },
    async call(args: { account: Address; to: Address }) {
      ethCalls++;
      assert.equal(args.account.toLowerCase(), admin.address.toLowerCase());
      assert.equal(args.to.toLowerCase(), executor.toLowerCase());
      return { data: "0x" as Hex };
    },
    async sendRawTransaction() {
      broadcasts++;
    },
  } as unknown as Parameters<typeof execute>[0];
  const result = await execute(
    fake,
    s,
    [allocation],
    policy,
    true,
    {
      async readJournal(){return {};},
      async writeJournal(){journalWrites++;},
      async adminAccount(){return admin;},
    },
    { voteExecutor: executor, adminAddress: admin.address },
  );
  assert.equal(contractSimulations, 0);
  assert.equal(ethCalls, 1);
  assert.equal(broadcasts, 0);
  assert.equal(journalWrites, 0);
  assert.equal(result.batches[0].status, "simulated");
  assert.equal(result.batches[0].source, "executed");
  assert.equal(result.batches[0].simulation?.status, "success");
  assert.equal(result.batches[0].simulation?.returnData, "0x");
  assert.match(String(result.batches[0].transaction.signedHash), /^0x[0-9a-f]{64}$/);
});

test("executor result contains the broadcast receipt", async () => {
  const s = fixture();
  s.timestamp = s.voteEnd - 3600;
  const allocation = optimize(s, policy)[0];
  const executor = addr(930);
  const admin = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);
  const transactionHash = `0x${"3".repeat(64)}` as Hex;
  let broadcasts = 0;
  let journalWrites = 0;
  const fake = {
    async getBlock() {
      return { number: 2n, timestamp: BigInt(s.timestamp) };
    },
    async multicall() {
      return [allocation.owner, 0n, BigInt(allocation.power), 0].map((result) => ({
        status: "success",
        result,
      }));
    },
    async readContract(args: { functionName: string }) {
      if (args.functionName === "admin") return admin.address;
      if (args.functionName === "AERODROME_VOTER") return VOTER;
      return 0n;
    },
    async estimateContractGas() {
      return 100000n;
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    },
    async getTransactionCount() {
      return 7;
    },
    async sendRawTransaction() {
      broadcasts++;
    },
    async waitForTransactionReceipt() {
      return {
        status: "success",
        transactionHash,
        blockNumber: 99n,
        gasUsed: 80000n,
        effectiveGasPrice: 3n,
      };
    },
  } as unknown as Parameters<typeof execute>[0];
  const result = await execute(
    fake,
    s,
    [allocation],
    policy,
    false,
    {
      async readJournal(){return {};},
      async writeJournal(){journalWrites++;},
      async adminAccount(){return admin;},
    },
    { voteExecutor: executor, adminAddress: admin.address },
  );
  assert.equal(broadcasts, 1);
  assert.equal(journalWrites, 2);
  assert.deepEqual(result.batches[0].broadcast, {
    status: "success",
    transactionHash,
    blockNumber: "99",
    gasUsed: "80000",
    effectiveGasPrice: "3",
  });
  assert.equal(result.batches[0].transaction.nonce, 7);
});

test("uncertain broadcasts block new signing and stale snapshots fail closed",async()=>{
  const s=fixture();s.timestamp=s.voteEnd-3600;const a=optimize(s,policy)[0];
  const hash=`0x${"1".repeat(64)}` as `0x${string}`;
  const fake={
    async getBlock(){return {number:2n,timestamp:BigInt(s.timestamp)};},
    async multicall(){return [a.owner,0n,BigInt(a.power),0].map(result=>({status:"success",result}));},
    async readContract(args: { functionName: string }) {
      return args.functionName === "admin" ? addr(901) : VOTER;
    },
    async getTransactionReceipt(){throw Error("not found");}
  } as unknown as Parameters<typeof execute>[0];
  let signed=0;
  const deps={async readJournal(){return {[`${s.epoch}:${a.tokenId}`]:{hash,owner:a.owner,nonce:1,status:"prepared" as const,epoch:s.epoch,tokenId:a.tokenId}};},async writeJournal(){},async adminAccount(){signed++;throw Error("must not sign");}};
  const config = { voteExecutor: addr(900), adminAddress: addr(901) };
  await assert.rejects(execute(fake,s,[a],policy,false,deps,config),/Unresolved vote/);assert.equal(signed,0);
  const stale={...s,timestamp:s.timestamp-901};
  await assert.rejects(execute(fake,stale,[a],policy,true,deps,config),/expired/);
});
