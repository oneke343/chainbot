// Integration test ONLY against a localhost Anvil fork. No mainnet writes.
// Start: anvil --fork-url https://mainnet.base.org --chain-id 8453 --port 18545 --silent
// Run: bun tests/aerodrome-fork.ts
import assert from "node:assert/strict";
import { createWalletClient, http, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  ABI,
  VE,
  VOTER,
  clientFor,
  collect,
  discover,
  optimize,
  execute,
  DEFAULT_POLICY,
  type Journal,
  type Snapshot,
} from "../f/aerodrome/lib/vote.ts";
const url = "http://127.0.0.1:18545";
const client = clientFor(url);
async function local(method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await r.json();
  assert.ok(!body.error, JSON.stringify(body.error));
  return body.result;
}
assert.match(await local("web3_clientVersion", []), /anvil/i);
assert.equal(await client.getChainId(), 8453);
await local("anvil_setIntervalMining", [1]);
const account = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({
  chain: base,
  account,
  transport: http(url),
});
const source = "0xBDE0c70BdC242577c52dFAD53389F82fd149EA5a";
const aero = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
await local("anvil_setBalance", [account.address, "0x8ac7230489e80000"]);
await local("anvil_setBalance", [source, "0x8ac7230489e80000"]);
await local("anvil_impersonateAccount", [source]);
const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);
const sourceWallet = createWalletClient({
  chain: base,
  account: source,
  transport: http(url),
});
await client.waitForTransactionReceipt({
  hash: await sourceWallet.writeContract({
    chain: base,
    account: source,
    address: aero,
    abi: erc20,
    functionName: "transfer",
    args: [account.address, parseEther("2000")],
  }),
});
await local("anvil_stopImpersonatingAccount", [source]);
await client.waitForTransactionReceipt({
  hash: await wallet.writeContract({
    chain: base,
    account,
    address: aero,
    abi: erc20,
    functionName: "approve",
    args: [VE, parseEther("2000")],
  }),
});
const lockAbi = parseAbi([
  "function createLock(uint256,uint256) returns (uint256)",
  "function lockPermanent(uint256)",
  "function approve(address,uint256)",
]);
for (let i = 0; i < 2; i++)
  await client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      chain: base,
      account,
      address: VE,
      abi: lockAbi,
      functionName: "createLock",
      args: [parseEther("1000"), 126144000n],
    }),
  });
let block = await client.getBlock();
const epoch = await client.readContract({
  authorizationList: undefined,
  address: VOTER,
  abi: ABI,
  functionName: "epochStart",
  args: [block.timestamp],
});
const found = await discover(
  client,
  block.number!,
  [account.address],
  Number(epoch),
);
assert.equal(found.length, 2);
for (const nft of found)
  await client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      chain: base,
      account,
      address: VE,
      abi: lockAbi,
      functionName: "lockPermanent",
      args: [BigInt(nft.tokenId)],
    }),
  });
console.log("Fork: created two permanent veAERO NFTs for an ephemeral account");
const executorArtifact = await Bun.file(
  new URL("../contracts/out/VoteExecutor.sol/VoteExecutor.json", import.meta.url),
).json();
const executor = await (wallet.deployContract as any)({
  chain: base,
  account,
  abi: executorArtifact.abi,
  bytecode: executorArtifact.bytecode.object as Hex,
  args: [account.address],
});
const executorReceipt = await client.waitForTransactionReceipt({ hash: executor });
const executorAddress = executorReceipt.contractAddress;
assert.ok(executorAddress);
for (const nft of found)
  await client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      chain: base,
      account,
      address: VE,
      abi: lockAbi,
      functionName: "approve",
      args: [executorAddress, BigInt(nft.tokenId)],
    }),
  });
console.log(`Fork: deployed VoteExecutor ${executorAddress} and approved both NFTs`);
// Read market state from the public chain (or a saved same-epoch public
// snapshot). Replaying thousands of upstream storage misses through Anvil
// is unnecessary; ownership/signing/votes below use actual fork contracts.
const snapshot: Snapshot = process.argv[2]
  ? await Bun.file(process.argv[2]).json()
  : await collect(clientFor("https://base-rpc.publicnode.com"), [
      account.address,
    ]);
assert.equal(snapshot.epoch, Number(epoch));
block = await client.getBlock();
snapshot.nfts = await discover(
  client,
  block.number!,
  [account.address],
  snapshot.epoch,
);
assert.equal(snapshot.nfts.length, 2);
assert.ok(snapshot.nfts.every((n) => n.permanent && n.eligible));
assert.ok(snapshot.pools.some((p) => p.rewardUsd > 0));
await local("evm_setNextBlockTimestamp", [snapshot.voteEnd - 3600]);
await local("evm_mine", []);
block = await client.getBlock();
snapshot.timestamp = Number(block.timestamp);
snapshot.block = block.number!.toString();
snapshot.nfts = await discover(
  client,
  block.number!,
  [account.address],
  snapshot.epoch,
);
const policy = { ...DEFAULT_POLICY, maxGasUsd: 20 };
const plans = optimize(snapshot, policy);
assert.equal(plans.length, 2);
await local("anvil_setIntervalMining", [1]);
let journal: Journal = {};
const deps = {
  async relayerAccount() {
    return account;
  },
  async readJournal() {
    return journal;
  },
  async writeJournal(j: Journal) {
    journal = structuredClone(j);
  },
};
const executorConfig = {
  voteExecutor: executorAddress,
  relayerAddress: account.address,
};
const simulated = await execute(client, snapshot, plans, policy, true, deps, executorConfig);
assert.ok(simulated.every((r) => r.status === "simulated"));
const sent = await execute(client, snapshot, plans, policy, false, deps, executorConfig);
assert.ok(sent.every((r) => r.status === "confirmed"));
const repeated = await execute(client, snapshot, plans, policy, false, deps, executorConfig);
assert.ok(repeated.every((r) => r.status === "already_voted"));
await local("anvil_setIntervalMining", [0]);
console.log(
  JSON.stringify(
    {
      registered: snapshot.registeredPools,
      active: snapshot.activePools,
      valued: snapshot.pools.filter((p) => p.rewardUsd > 0).length,
      nfts: plans.map((p) => p.tokenId),
      simulation: simulated.map((r) => r.status),
      execution: sent,
      repeat: repeated.map((r) => r.status),
      journalEntries: Object.keys(journal).length,
    },
    null,
    2,
  ),
);
