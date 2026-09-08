import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits, decodeFunctionData, type Address } from "viem";
import {
  optimize,
  executionWindow,
  validatePolicy,
  execute,
  DEFAULT_POLICY,
  ABI,
  type Snapshot,
  type Nft,
} from "../f/aerodrome/auto_vote_optimizer__flow/vote.ts";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const raw = (n: number) => parseUnits(String(n), 18).toString();
function nft(id: number, power: number): Nft {
  return {
    tokenId: String(id),
    owner: addr(100 + id),
    power: raw(power),
    lastVoted: 0,
    escrowType: 0,
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
    ethUsd: 2000,
    unpriced: [],
    registeredPools: 2,
    activePools: 2,
  };
}
const policy = { ...DEFAULT_POLICY, dilution: 1, rewardHaircut: 0 };
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
    const decoded = decodeFunctionData({ abi: ABI, data: p.data });
    assert.equal(decoded.functionName, "vote");
    assert.equal(decoded.args?.[0], BigInt(p.tokenId));
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
test("already-voted and Relay positions are excluded from execution", () => {
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
  s.nfts[1].reason = "managed_or_relay";
  assert.deepEqual(optimize(s, policy), []);
});
test("zero valued rewards produce no votes and no NaN", () => {
  const s = fixture();
  s.pools.forEach((p) => (p.rewardUsd = 0));
  assert.deepEqual(optimize(s, policy), []);
});
test("token IDs above JS safe integer survive ABI encoding", () => {
  const s = fixture();
  s.nfts[0].tokenId = "900719925474099312345";
  const p = optimize(s, policy)[0];
  assert.equal(
    decodeFunctionData({ abi: ABI, data: p.data }).args?.[0],
    BigInt(s.nfts[0].tokenId),
  );
});
test("cardinality and concentration constraints fail closed if incompatible", () => {
  assert.throws(
    () => optimize(fixture(), { ...policy, maxPools: 1, maxShare: 0.5 }),
    /Too few/,
  );
  const p = optimize(fixture(), { ...policy, maxShare: 0.5 })[0];
  assert.equal(p.weights[0], p.weights[1]);
});
test("execution is limited to late voting window and excludes epoch rollover", () => {
  const s = fixture();
  assert.equal(executionWindow(s.voteEnd - 3600, s, policy), true);
  for (const t of [
    s.voteStart,
    s.voteEnd - policy.executionLeadSeconds - 1,
    s.voteEnd - 599,
    s.epoch + 604800,
  ])
    assert.equal(executionWindow(t, s, policy), false);
});
test("invalid inputs cannot silently turn off limits", () => {
  assert.throws(() => validatePolicy({ ...policy, maxGasUsd: NaN }));
  assert.throws(() => validatePolicy({ ...policy, deadlineBufferSeconds: 0 }));
  const s = fixture();
  s.nfts[0].current = { [addr(1)]: raw(200) };
  assert.throws(() => optimize(s, policy), /smaller/);
});

test("a zero-vote incentive pool is not lost to rounding or subset selection", () => {
  const s=fixture();
  s.pools[0].votes="0";
  const plans=optimize(s,{...policy,maxPools:1});
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

test("execution gates prevent signing outside the window and after simulation failure", async () => {
  const s=fixture();s.timestamp=s.voteEnd-3600;
  const plans=optimize(s,policy);let simulated=0, signed=0;
  const fake={
    async getBlock(){return {number:2n,timestamp:BigInt(s.timestamp)};},
    async multicall(){return [plans[0].owner,0n,BigInt(plans[0].power),0].map(result=>({status:"success",result}));},
    async simulateContract(){simulated++;throw Error("revert");}
  } as unknown as Parameters<typeof execute>[0];
  const deps={async readJournal(){return {};},async writeJournal(){},async accountFor(){signed++;throw Error("must not sign");}};
  await assert.rejects(execute(fake,s,[plans[0]],policy,false,deps),/simulation failed/);
  assert.equal(simulated,1);assert.equal(signed,0);
  s.timestamp=s.voteEnd-100;
  const outside=await execute(fake,s,[plans[0]],policy,false,deps);
  assert.equal(outside[0].status,"outside_execution_window");assert.equal(simulated,1);assert.equal(signed,0);
});

test("uncertain broadcasts block new signing and stale snapshots fail closed",async()=>{
  const s=fixture();s.timestamp=s.voteEnd-3600;const a=optimize(s,policy)[0];
  const hash=`0x${"1".repeat(64)}` as `0x${string}`;
  const fake={
    async getBlock(){return {number:2n,timestamp:BigInt(s.timestamp)};},
    async multicall(){return [a.owner,0n,BigInt(a.power),0].map(result=>({status:"success",result}));},
    async getTransactionReceipt(){throw Error("not found");}
  } as unknown as Parameters<typeof execute>[0];
  let signed=0;
  const deps={async readJournal(){return {[`${s.epoch}:${a.tokenId}`]:{hash,owner:a.owner,nonce:1,status:"prepared" as const,epoch:s.epoch,tokenId:a.tokenId}};},async writeJournal(){},async accountFor(){signed++;throw Error("must not sign");}};
  await assert.rejects(execute(fake,s,[a],policy,false,deps),/Unresolved vote/);assert.equal(signed,0);
  const stale={...s,timestamp:s.timestamp-901};
  await assert.rejects(execute(fake,stale,[a],policy,true),/expired/);
});
