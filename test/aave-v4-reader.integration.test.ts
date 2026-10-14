import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createPublicClient, http, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { main as readHubs } from "../f/aave/scripts/sources/aave_v4_read_hubs.ts";
import { main as rule } from "../f/aave/scripts/rules/evaluate_aave_v4_market_params.ts";
import { rpcMulticall } from "../f/aave/lib/multicall.ts";
import { READER_ABI, READER_BYTECODE } from "../f/aave/lib/market-params-reader-artifact.ts";

// Opt in because normal Windmill/Node CI does not require Foundry binaries.
test("Reader-shaped Source uses one latest multicall and detects changes on a local EVM", { skip: process.env.AAVE_READER_INTEGRATION !== "1", timeout: 60_000 }, async (t) => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "1", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  anvil.stderr.on("data", (data) => { diagnostics += data; });
  anvil.on("error", (error) => { diagnostics += error.message; });
  const url = `http://127.0.0.1:${port}`;
  let id = 0;
  async function rpc(method: string, params: unknown[] = []): Promise<any> {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await rpc("eth_chainId"); ready = true; break; } catch { /* wait only for local process startup */ }
      if (anvil.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ready, `Anvil did not start: ${diagnostics}`);
    const artifact = JSON.parse(readFileSync(join("/tmp/chainbot-aave-reader-out", "AaveV4ConfigReader.t.sol/MockAave.json"), "utf8"));
    const [account] = await rpc("eth_accounts");
    async function transact(data: Hex, to?: Address) {
      const hash = await rpc("eth_sendTransaction", [{ from: account, ...(to ? { to } : {}), data, gas: "0x1c9c380" }]);
      let receipt;
      for (let attempt = 0; attempt < 100; attempt++) {
        receipt = await rpc("eth_getTransactionReceipt", [hash]);
        if (receipt) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(receipt, `Local transaction did not mine: ${hash}`);
      assert.equal(receipt.status, "0x1");
      return receipt;
    }
    const multicallArtifact = JSON.parse(readFileSync(join("/tmp/chainbot-aave-reader-out", "AaveV4ConfigReader.t.sol/MockMulticall3.json"), "utf8"));
    await rpc("anvil_setCode", ["0xca11bde05977b3631167028862be2a173976ca11", multicallArtifact.deployedBytecode.object]);
    const address = (await transact(artifact.bytecode.object)).contractAddress as Address;
    const secondAddress = (await transact(artifact.bytecode.object)).contractAddress as Address;
    const owner = "0x000000000000000000000000000000000000dead";
    const eoa = "0x000000000000000000000000000000000000beef";
    const word = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
    // The official Spoke extSloads getter exposes these ERC-1967 slots to the Reader.
    for (const [slot, value] of [
      ["0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", address],
      ["0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", eoa],
      ["0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50", address],
    ]) await rpc("anvil_setStorageAt", [address, slot, word(value)]);
    await rpc("evm_mine");
    const client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
    const pinnedBlock = await client.getBlockNumber();
    const readHub = () => client.readContract({ abi: READER_ABI, code: READER_BYTECODE, blockNumber: pinnedBlock, authorizationList: undefined, functionName: "readHub", args: [address] });
    const readSpoke = () => client.readContract({ abi: READER_ABI, code: READER_BYTECODE, authorizationList: undefined, functionName: "readSpoke", args: [address] });
    const hub = await readHub();
    assert.equal(hub.hub.assets.length, 2);
    assert.equal(hub.hub.assets[0].registeredSpokes[1].config.addCap, 100);
    assert.equal(hub.treasuries[0].owner.toLowerCase(), owner);
    const spoke = await readSpoke();
    assert.equal(spoke.reserves[0].dynamicConfigs[0].collateralFactor, 8000);
    assert.equal(spoke.reserves[0].dynamicConfigs[1].collateralFactor, 8100);
    assert.equal(spoke.oracle.decimals, 8);
    const roles = await client.readContract({ abi: READER_ABI, code: READER_BYTECODE, authorizationList: undefined, functionName: "readAuthority", args: [address] });
    assert.ok(roles.some((role) => role.roleId === 0n));
    assert.ok(roles.some((role) => role.roleId === (1n << 64n) - 1n));
    const abi = parseAbi(["function owner() view returns (address)", "function getAssetCount() view returns (uint256)", "function missingGetter() view returns (bool)"]);
    const typed = await rpcMulticall(url, { contracts: [{ address, abi, functionName: "owner" }, { address, abi, functionName: "getAssetCount" }], deployless: true, allowFailure: false, blockNumber: pinnedBlock });
    assert.deepEqual(typed, [getAddress(owner), 2n]);
    await assert.rejects(rpcMulticall(url, { contracts: [{ address, abi, functionName: "missingGetter" }], deployless: true, allowFailure: false, blockNumber: pinnedBlock }));
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;
    const fetchMock = t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (requestUrl.replace(/\/$/, "") === url && body) requests.push(JSON.parse(String(body)));
      return originalFetch(input, init);
    });
    const graph = await readHubs(url, [secondAddress, address]);
    fetchMock.mock.restore();
    const calls = requests.flat().filter(request => request.method === "eth_call");
    assert.equal(calls.length, 1, "all Hubs use exactly one eth_call");
    assert.equal(requests.flat().some(request => request.method === "eth_sendTransaction"), false);
    assert.equal(calls[0].params[1], "latest");
    assert.equal(requests.flat().every(request => request.method === "eth_call"), true, "no chain ID or block-number requests");
    assert.equal(calls[0].params[0].to.toLowerCase(), "0xca11bde05977b3631167028862be2a173976ca11");
    assert.ok(calls[0].params[2], "Reader runtime is injected through state override");
    assert.equal(Object.keys(graph).length, 2);
    const decoded = graph[address];
    assert.deepEqual(decoded, JSON.parse(JSON.stringify(hub, (_key, value) => typeof value === "bigint" ? value.toString() : value)), "preserve the entire Reader struct and its arrays");
    assert.equal(decoded.spokes[0].proxy.admin, getAddress(eoa));
    assert.equal(decoded.spokes[0].proxy.beaconOwner, getAddress(owner));
    assert.equal(decoded.spokes[0].reserves[0].dynamicConfigs[0].collateralFactor, 8000);
    assert.equal(decoded.hub.assets[0].assetId, "0");
    assert.equal(decoded.hub.assets[0].registeredSpokes[0].config.addCap, 100);
    assert.equal(decoded.hub.assets[0].config.reinvestmentController, "0x0000000000000000000000000000000000000000");
    assert.doesNotThrow(() => JSON.stringify(graph));
    const first = await rule({ "1": graph });
    async function set(functionName: string, value: unknown) {
      await transact(encodeFunctionData({ abi: artifact.abi, functionName, args: [value] }), address);
    }
    await set("setCap", 200);
    assert.equal((await readHub()).hub.assets[0].registeredSpokes[0].config.addCap, 100, "pinned getter ignores newer blocks");
    await set("setFactor", 7900);
    await set("setAdminFunction", true);
    await set("setRevoked", true);
    await set("setProxyImplementation", secondAddress);
    await transact(encodeFunctionData({ abi: parseAbi(["function setOwner(address)"]), functionName: "setOwner", args: [secondAddress] }), hub.treasuries[0].addr);
    const fresh = await readHubs(url, [address, secondAddress]);
    assert.equal(fresh[address].hub.assets[0].registeredSpokes[0].config.addCap, 200, "latest sees the new cap without pinning");
    assert.equal(graph[address].hub.assets[0].registeredSpokes[0].config.addCap, 100, "previous snapshot is unchanged");
    const evaluation = await rule({ "1": fresh }, first.nextBaseline);
    for (const suffix of ["registeredSpokes." + getAddress(address) + ".config", "dynamicConfigs.0", ".proxy", ".members." + getAddress(owner), ".treasuries." + getAddress(hub.treasuries[0].addr)])
      assert.ok(evaluation.output.fields.changes.some(change => change.path.endsWith(suffix)), suffix);
    assert.ok(evaluation.output.fields.changes.some(change => change.fields.some(field => field.parameter === "role" && field.after === "0")));
    await set("setFailDynamic", true);
    await assert.rejects(readSpoke());
    await assert.rejects(readHubs(url, [secondAddress, address]), /dynamic read failed|revert/);
    await set("setFailDynamic", false);
    await set("setReserveCount", 10_001n);
    await assert.rejects(readSpoke());
  } finally {
    if (anvil.exitCode === null) {
      const ended = once(anvil, "exit");
      anvil.kill("SIGTERM");
      await ended;
    }
  }
});
