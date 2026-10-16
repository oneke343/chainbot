import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main } from "../f/aave/sources/v3/market_params.ts";
import type { AaveV3MarketParamsQuery } from "../f/aave/lib/v3-types.ts";
import { jsondiff } from "../f/chain_sentinel/lib/jsondiff.ts";

type Market = AaveV3MarketParamsQuery["markets"][number];
const api = { base_url: "https://api.v3.aave.com/graphql" };
const pool = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const asset = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const address = "0xcccccccccccccccccccccccccccccccccccccccc";
const chains = { chains: [{ chainId: 1, name: "Ethereum" }, { chainId: 8453, name: "Base" }] };
const percent = (raw: string, decimals = 4) => ({ raw, decimals });
const amount = (raw: string, decimals = 6) => ({ amount: { raw, decimals } });

function market(chainId = 1): Market {
  return {
    name: "Core", address: pool, chain: { chainId },
    reserves: [{
      underlyingToken: { address: asset, symbol: "USDC", decimals: 6 },
      aToken: { address }, vToken: { address },
      usdOracleAddress: address, interestRateStrategyAddress: address,
      isFrozen: false, isPaused: false, flashLoanEnabled: true,
      supplyInfo: {
        maxLTV: percent("8000"), liquidationThreshold: percent("8500"),
        liquidationBonus: percent("10500"), canBeCollateral: true,
        supplyCap: amount("900719925474099312345678"),
      },
      borrowInfo: {
        reserveFactor: percent("1000"), borrowCap: amount("800000000"), borrowingState: "ENABLED",
        baseVariableBorrowRate: percent("0"), variableRateSlope1: percent("400"),
        variableRateSlope2: percent("6000"), optimalUsageRate: percent("9000"),
      },
      isolationModeConfig: {
        canBeCollateral: false, canBeBorrowed: true,
        debtCeiling: amount("12345", 2), debtCeilingDecimals: 2,
      },
    }],
    eModeCategories: [{
      id: 1, label: "Stablecoins", maxLTV: percent("9000"),
      liquidationThreshold: percent("9300"), liquidationPenalty: percent("100"), isolated: false,
      reserves: [{ underlyingToken: { address: asset }, canBeCollateral: true, canBeBorrowed: true, hasLtvZero: false }],
    }],
  };
}

async function collect(markets: Market[]) {
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: {
    chains, market_params_query: { markets },
  } }));
  return await main(api);
}

test("Source discovers chains then dispatches one configuration query for all mainnets", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("workflow body must not perform HTTP requests"); });
  const completed_steps: Record<string, unknown> = {};
  async function nextStep() {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
    let steps: ReturnType<WorkflowCtx["_flushPending"]> = [];
    await assert.rejects(main(api), (error: unknown) => {
      assert.ok(error instanceof wmill.StepSuspend);
      assert.equal(error.dispatchInfo.mode, "sequential");
      steps = error.dispatchInfo.steps;
      return true;
    });
    assert.equal(steps.length, 1);
    return steps[0];
  }
  const discovery = await nextStep();
  assert.equal(discovery.script, "f/aave/sources/v3/chains");
  assert.equal(Reflect.get(discovery, "cache_ttl"), 86400);
  assert.deepEqual(discovery.args, { api });
  completed_steps[discovery.key] = chains;
  const query = await nextStep();
  assert.equal(query.script, "f/aave/sources/v3/market_params_query");
  assert.equal(Reflect.get(query, "timeout"), 60);
  assert.equal(Reflect.get(query, "cache_ttl"), undefined);
  assert.deepEqual(query.args, { api, chain_ids: [1, 8453] });
  completed_steps[query.key] = { markets: [market()] };
  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  const snapshot = await main(api);
  assert.deepEqual(Object.keys(snapshot), ["1", "8453"]);
  assert.deepEqual(snapshot["8453"], {});
  assert.equal(snapshot["1"][pool].reserves[asset].supplyInfo.supplyCap, "900719925474099312.345678");
  assert.equal(snapshot["1"][pool].reserves[asset].supplyInfo.maxLTV, "0.8");
  assert.equal(snapshot["1"][pool].reserves[asset].borrowInfo.baseVariableBorrowRate, "0");
  assert.equal(snapshot["1"][pool].reserves[asset].isolationModeConfig.debtCeiling, "123.45");
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
});

test("market, reserve and eMode order, address casing and decimal precision do not produce changes", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const original = market();
  const secondReserve = structuredClone(original.reserves[0]);
  secondReserve.underlyingToken.address = address;
  original.reserves.push(secondReserve);
  const secondCategory = structuredClone(original.eModeCategories[0]);
  secondCategory.id = 2;
  original.eModeCategories.push(secondCategory);
  original.eModeCategories[0].reserves.push({
    underlyingToken: { address }, canBeBorrowed: false, canBeCollateral: true, hasLtvZero: true,
  });
  const before = await collect([original, market(8453)]);
  const reordered = structuredClone(original);
  reordered.address = reordered.address.toUpperCase();
  reordered.reserves.reverse();
  reordered.eModeCategories.reverse();
  for (const reserve of reordered.reserves) {
    reserve.underlyingToken.address = reserve.underlyingToken.address.toUpperCase();
    reserve.aToken.address = reserve.aToken.address.toUpperCase();
    reserve.vToken.address = reserve.vToken.address.toUpperCase();
    reserve.usdOracleAddress = reserve.usdOracleAddress.toUpperCase();
    reserve.interestRateStrategyAddress = reserve.interestRateStrategyAddress.toUpperCase();
    reserve.supplyInfo.maxLTV = percent("80000", 5);
  }
  for (const category of reordered.eModeCategories) {
    category.reserves.reverse();
    for (const reserve of category.reserves) reserve.underlyingToken.address = reserve.underlyingToken.address.toUpperCase();
  }
  assert.deepEqual(jsondiff(before, await collect([market(8453), reordered])), []);
});

test("snapshots retain nullable configuration and expose precise risk, rate and eMode diffs", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const initial = market();
  initial.reserves[0].borrowInfo = null;
  initial.reserves[0].isolationModeConfig = null;
  const snapshot = await collect([initial]);
  assert.equal(snapshot["1"][pool].reserves[asset].borrowInfo, null);
  assert.equal(snapshot["1"][pool].reserves[asset].isolationModeConfig, null);

  const changed = market();
  const before = await collect([changed]);
  changed.reserves[0].supplyInfo.maxLTV = percent("7500");
  changed.reserves[0].supplyInfo.supplyCap = amount("1000000000");
  changed.reserves[0].borrowInfo.variableRateSlope1 = percent("500");
  changed.eModeCategories[0].isolated = true;
  changed.eModeCategories[0].reserves[0].hasLtvZero = true;
  const patch = jsondiff(before, await collect([changed]));
  assert.equal(patch.length, 5);
  assert.ok(patch.some(change => change.path === `/1/${pool}/reserves/${asset}/supplyInfo/maxLTV`
    && change.op === "replace" && change.oldValue === "0.8" && change.value === "0.75"));
  assert.ok(patch.some(change => change.path === `/1/${pool}/reserves/${asset}/borrowInfo/variableRateSlope1`
    && change.op === "replace" && change.oldValue === "0.04" && change.value === "0.05"));
  assert.ok(patch.some(change => change.path === `/1/${pool}/eModeCategories/1/isolated`
    && change.op === "replace" && change.oldValue === false && change.value === true));
  assert.ok(patch.some(change => change.path.endsWith(`/reserves/${asset}/hasLtvZero`)
    && change.op === "replace" && change.value === true));
});

test("volatile API properties are not included in the configuration projection", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const initial = market();
  const before = await collect([initial]);
  const volatile = { ...initial, totalMarketSize: "999", totalAvailableLiquidity: "1", reserves: initial.reserves.map(reserve => ({
    ...reserve, usdExchangeRate: "0.5", size: amount("999"), incentives: [],
    supplyInfo: { ...reserve.supplyInfo, apy: percent("1"), supplyCapReached: true, total: percent("99") },
    borrowInfo: { ...reserve.borrowInfo, apy: percent("500"), utilizationRate: percent("9999"), borrowCapReached: true },
  })) };
  assert.deepEqual(jsondiff(before, await collect([volatile])), []);
});

test("GraphQL task failures propagate and never return a partial snapshot", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const failure = { __wmill_error: true, message: "GraphQL query failed" };
  for (const completed_steps of [{ chains: failure }, { chains, market_params_query: failure }]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
    await assert.rejects(main(api), { name: "TaskError", message: "GraphQL query failed" });
  }
});
