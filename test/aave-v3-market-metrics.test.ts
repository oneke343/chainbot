import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main } from "../f/aave/sources/v3/market_metrics.ts";
import type { AaveV3MarketMetricsQuery } from "../f/aave/lib/v3-types.ts";
import { decimal, rate } from "./fixtures/aave-v3-reserves.ts";

const api = { base_url: "https://api.v3.aave.com/graphql" };
const chains = { chains: [{ chainId: 1, name: "Ethereum" }, { chainId: 8453, name: "Base" }] };
const sampledAt = "2026-10-16T04:00:00.000Z";
const metrics: AaveV3MarketMetricsQuery = { markets: [{
  name: "Core", address: "0xPOOL", chain: { chainId: 1 },
  reserves: [{
    underlyingToken: { address: "0xASSET", symbol: "USDC" },
    supplyInfo: { total: decimal("900719925474099312345678", 6), supplyCap: { amount: decimal(0, 6) } },
    borrowInfo: {
      total: { amount: decimal(1, 6) }, availableLiquidity: { amount: decimal(2, 6) },
      utilizationRate: rate(9000), optimalUsageRate: rate(9000), apy: rate(500), borrowCap: { amount: decimal(0, 6) },
    },
  }],
}] };

test("Source uses one query for all chains and checkpoints its collection timestamp", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("no I/O in workflow body"); });
  const completed_steps: Record<string, unknown> = {};
  async function next() {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
    let steps: ReturnType<WorkflowCtx["_flushPending"]> = [];
    await assert.rejects(main(api), (error: unknown) => {
      assert.ok(error instanceof wmill.StepSuspend);
      steps = error.dispatchInfo.steps;
      return true;
    });
    assert.equal(steps.length, 1);
    return steps[0];
  }
  const discovery = await next();
  assert.equal(discovery.script, "f/aave/sources/v3/chains");
  assert.equal(Reflect.get(discovery, "cache_ttl"), 86400);
  completed_steps[discovery.key] = chains;
  const query = await next();
  assert.equal(query.script, "f/aave/sources/v3/market_metrics_query");
  assert.deepEqual(query.args, { api, chain_ids: [1, 8453] });
  assert.equal(Reflect.get(query, "timeout"), 60);
  completed_steps[query.key] = metrics;
  completed_steps.sampled_at = sampledAt;
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  const result = await main(api);
  assert.equal(result.sampledAt, sampledAt);
  assert.deepEqual(Object.keys(result.reserves), ["1/0xpool/0xasset"]);
  assert.equal(result.reserves["1/0xpool/0xasset"].totalSupply.raw, "900719925474099312345678");
  assert.deepEqual(result.reserves["1/0xpool/0xasset"].borrow!.apy, rate(500));
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  assert.deepEqual(await main(api), result);
});

test("Source keeps supply-only reserves and separates the same asset across markets and chains", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const data = structuredClone(metrics);
  const second = structuredClone(data.markets[0]);
  second.address = "0xOTHER";
  second.reserves[0].borrowInfo = null;
  const third = structuredClone(data.markets[0]);
  third.chain.chainId = 8453;
  data.markets.push(second, third);
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: { chains, market_metrics_query: data, sampled_at: sampledAt } }));
  const result = await main(api);
  assert.equal(Object.keys(result.reserves).length, 3);
  assert.equal(result.reserves["1/0xother/0xasset"].borrow, null);
  assert.equal(result.reserves["8453/0xpool/0xasset"].chainId, 8453);
});

test("Source query failures propagate", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: {
    chains, market_metrics_query: { __wmill_error: true, message: "API unavailable" },
  } }));
  await assert.rejects(main(api), /API unavailable/);
});
