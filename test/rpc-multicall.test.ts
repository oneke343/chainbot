import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Abi, type Address } from "viem";
import { rpcMulticall } from "../f/aave/lib/multicall.ts";

const aggregateAbi = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] results)"]);
const abi = parseAbi(["function owner() view returns (address)", "function value(uint256) view returns (uint256)"]);
const address: Address = `0x${"1".repeat(40)}`;
const multicallAddress: Address = `0x${"2".repeat(40)}`;

function fakeRpc(t: test.TestContext, fail = false) {
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    assert.equal(request.method, "eth_call");
    assert.equal(request.params[0].to, multicallAddress);
    assert.equal(request.params[1], "0x7b");
    const { args: [calls] } = decodeFunctionData({ abi: aggregateAbi, data: request.params[0].data });
    const results = calls.map((call) => {
      const decoded = decodeFunctionData({ abi, data: call.callData });
      const success = !fail || decoded.functionName !== "value";
      return { success, returnData: success ? encodeFunctionResult({ abi: abi as Abi, functionName: decoded.functionName,
        result: decoded.functionName === "owner" ? address : decoded.args[0] + 1n }) : "0x" };
    });
    return Response.json({ jsonrpc: "2.0", id: request.id, result: encodeFunctionResult({ abi: aggregateAbi, functionName: "aggregate3", result: results }) });
  });
  return requests;
}

const calls = [
  { address, abi, functionName: "owner" },
  { address, abi, functionName: "value", args: [41n] },
] as const;

test("typed multicall preserves heterogeneous result order and the requested block", async (t) => {
  const requests = fakeRpc(t);
  const [owner, value] = await rpcMulticall("https://example.test/rpc", { contracts: calls, multicallAddress, blockNumber: 123n, allowFailure: false });
  assert.equal(owner, address);
  assert.equal(value, 42n);
  assert.equal(requests.length, 1);
});

test("multicall chunks retain order and block; explicit partial failures stay typed", async (t) => {
  const requests = fakeRpc(t, true);
  const results = await rpcMulticall("https://example.test/rpc", { contracts: calls, multicallAddress, blockNumber: 123n, batchSize: 4 });
  assert.equal(requests.length, 2);
  assert.equal(results[0].status, "success");
  if (results[0].status === "success") assert.equal(results[0].result, address);
  assert.equal(results[1].status, "failure");
  await assert.rejects(rpcMulticall("https://example.test/rpc", { contracts: calls, multicallAddress, blockNumber: 123n, allowFailure: false }));
});

test("empty multicall does not contact RPC", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected RPC"); });
  assert.deepEqual(await rpcMulticall("https://example.test/rpc", { contracts: [] as const, deployless: true, allowFailure: false }), []);
  assert.equal(fetch.mock.callCount(), 0);
});
