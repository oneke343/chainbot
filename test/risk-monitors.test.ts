import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertLiquidationPageCoverage, evaluateLiquidations, type LiquidationEvent,
} from "../f/chain_sentinel/lib/liquidation-events.ts";
import { evaluateMarketRisk } from "../f/chain_sentinel/lib/market-risk.ts";
import { main as graphql } from "../f/chain_sentinel/scripts/sources/graphql.ts";
import { normalizeAaveV3MarketRisk } from "../f/aave/scripts/rules/evaluate_aave_v3_market_risk.ts";

const api = { base_url: "https://example.test/graphql" };
const user = `0x${"1".repeat(40)}`;
const address = `0x${"2".repeat(40)}`;
const marketId = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

test("liquidation state bootstraps, deduplicates and refuses a cursor gap", () => {
  const event = (id: string, block = "10"): LiquidationEvent => ({
    id, protocol: "Morpho", chain_id: 1, market: "ETH / WETH-USDC", user,
    transaction_hash: marketId(Number(id)), log_index: Number(id), block_number: block,
    observed_at: "2026-09-05T00:00:00.000Z",
  });
  const first = evaluateLiquidations([event("1")]);
  assert.equal(first.output.matched, false);
  const second = evaluateLiquidations([event("1"), event("2", "11")], first.states);
  assert.equal(second.output.messages.length, 1);
  assert.equal(evaluateLiquidations([event("2", "11")], second.states).output.matched, false);
  assert.throws(() => assertLiquidationPageCoverage([event("3")], second.states, true), /overlaps/);
});

test("market risk evaluates independent metrics and rearms each market signal", () => {
  const snapshot = {
    id: "1:market", protocol: "Morpho", chain_id: 1, market: "Ethereum / market",
    observed_at: "2026-09-05T00:00:00.000Z", liquidity_usd: 10,
    utilization_percent: 99, bad_debt_usd: 5,
    warnings: [{ type: "oracle_unusable", level: "critical" as const }],
  };
  const rules = { min_liquidity_usd: 100, max_utilization_percent: 95, max_bad_debt_usd: 0 };
  const first = evaluateMarketRisk([snapshot], rules);
  assert.deepEqual(first.output.messages.map((message) => message.fields?.finding_kind), [
    "liquidity", "utilization", "bad_debt", "oracle",
  ]);
  assert.equal(evaluateMarketRisk([snapshot], rules, {}, first.states).output.matched, false);
  const safe = evaluateMarketRisk([{ ...snapshot, liquidity_usd: 200, utilization_percent: 50,
    bad_debt_usd: 0, warnings: [] }], rules, {}, first.states);
  assert.equal(safe.output.fields.active_findings.length, 0);
  assert.equal(evaluateMarketRisk([snapshot], rules, {}, safe.states).output.messages.length, 4);
});

test("market risk skips cap rules when a market has no configured cap", () => {
  const result = evaluateMarketRisk([{
    id: "1:uncapped", protocol: "Aave", chain_id: 1, market: "Ethereum / uncapped",
    observed_at: "2026-09-05T00:00:00.000Z", liquidity_usd: 200, utilization_percent: 50,
  }], {
    max_supply_cap_used_percent: 90,
    max_borrow_cap_used_percent: 90,
  });
  assert.equal(result.output.matched, false);
  assert.deepEqual(result.output.fields.active_findings, []);
});

test("Aave V3 market risk calculates cap usage in token units on both sides", () => {
  const [market] = normalizeAaveV3MarketRisk({ markets: [{
    name: "Main", address, chain: { chainId: 1, name: "Ethereum" },
    reserves: [{
      underlyingToken: { address, symbol: "TOKEN" }, usdExchangeRate: "2",
      supplyInfo: {
        total: { value: "100" },
        supplyCap: { amount: { value: "200" }, usd: "400" },
      },
      borrowInfo: {
        total: { amount: { value: "50" }, usd: "100" },
        availableLiquidity: { amount: { value: "50" }, usd: "100" },
        utilizationRate: { value: "0.5" },
        borrowCap: { amount: { value: "100" }, usd: "200" },
      },
    }],
  }] });
  assert.equal(market.supply_cap_used_percent, 50);
  assert.equal(market.borrow_cap_used_percent, 50);
});

test("Aave native queries discover mainnets then request explicitly selected chains", () => {
  const chains = readFileSync(new URL("../f/aave/sources/v4/chains.gql", import.meta.url), "utf8");
  const positions = readFileSync(new URL("../f/aave/sources/v4/user_positions.gql", import.meta.url), "utf8");
  assert.match(chains, /MAINNET_ONLY/);
  assert.match(positions, /\$chain_ids: \[ChainId!\]!/);
  assert.match(positions, /chainIds: \$chain_ids/);
  assert.match(positions, /healthFactor \{current\}/);
  const v3 = readFileSync(new URL("../f/aave/sources/v3/user_positions.gql", import.meta.url), "utf8");
  assert.match(v3, /totalDebtBase/);
  assert.match(v3, /totalCollateralBase/);
  assert.match(v3, /address/);
  const v3Liquidations = readFileSync(new URL("../f/aave/scripts/sources/aave_v3_user_liquidations.gql", import.meta.url), "utf8");
  assert.match(v3Liquidations, /LIQUIDATION_CALL/);
  const v4Liquidations = readFileSync(new URL("../f/aave/scripts/sources/aave_v4_user_liquidations.gql", import.meta.url), "utf8");
  assert.match(v4Liquidations, /LIQUIDATED/);
  const v3MarketRisk = readFileSync(new URL("../f/aave/scripts/sources/aave_v3_market_risk.gql", import.meta.url), "utf8");
  assert.match(v3MarketRisk, /availableLiquidity/);
  assert.match(v3MarketRisk, /borrowCap/);
});

test("Morpho liquidation and market-risk queries retain their required fields", () => {
  const liquidations = readFileSync(new URL("../f/morpho/scripts/sources/morpho_user_liquidations.gql", import.meta.url), "utf8");
  assert.match(liquidations, /type_in: \[Liquidation\]/);
  assert.match(liquidations, /logIndex/);
  const marketRisk = readFileSync(new URL("../f/morpho/scripts/sources/morpho_market_risk.gql", import.meta.url), "utf8");
  assert.match(marketRisk, /badDebt/);
  assert.match(marketRisk, /warnings/);
});

test("GraphQL rejects partial errors and missing data, and uses the existing resource schema", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-only");
    assert.equal(new Headers(init.headers).get("X-Test"), "yes");
    return Response.json({ data: { positions: [] }, errors: [{ message: "indexer failed" }] });
  });
  await assert.rejects(graphql({ ...api, bearer_token: "test-only", custom_headers: { "X-Test": "yes" } }, "query {x}"), /indexer failed/);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: null }));
  await assert.rejects(graphql(api, "query {x}"), /Missing GraphQL data/);
});
