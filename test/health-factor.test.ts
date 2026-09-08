import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as wmill from "windmill-client";
import { evaluateAaveV4Health, normalizeAaveV4Positions, main as aaveRule } from "../f/aave/scripts/rules/evaluate_aave_v4_health.ts";
import { evaluateMorphoHealth, normalizeMorphoPositions, main as morphoRule } from "../f/morpho/scripts/rules/evaluate_morpho_health.ts";
import {
  evaluatePositionHealth, inspectHealthFactors, renderPositionHealthMessages,
  type HealthInputs, type HealthPosition, type PositionRiskRule,
} from "../f/chain_sentinel/lib/health-factor.ts";
import {
  assertLiquidationPageCoverage, evaluateLiquidations, type LiquidationEvent,
} from "../f/chain_sentinel/lib/liquidation-events.ts";
import { evaluateMarketRisk } from "../f/chain_sentinel/lib/market-risk.ts";
import { main as graphql } from "../f/chain_sentinel/scripts/sources/graphql.ts";
import { main as alertPolicy } from "../f/chain_sentinel/scripts/alert_policies/matched_output.ts";
import { main as telegram } from "../f/chain_sentinel/scripts/destinations/send_telegram.ts";
import { sparkHealthAdapter } from "../f/spark/scripts/rules/evaluate_spark_health.ts";
import { main as sparkSource } from "../f/spark/scripts/sources/spark_user_positions.ts";

const api = { base_url: "https://example.test/graphql" };
const user = `0x${"1".repeat(40)}`;
const address = `0x${"2".repeat(40)}`;
const marketId = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function position(patch: Partial<HealthPosition> = {}): HealthPosition {
  return {
    id: `1:${address}`, name: `Ethereum / Main / ${address}`,
    market_name: "Ethereum / Main", chain_id: 1, health_factor: "1.10",
    has_debt: true, debt_usd: "100", collateral_usd: "150", ...patch,
  };
}

function inputs(positions: HealthPosition[] = [position()]): HealthInputs {
  return { user, observed_at: "2026-09-05T00:00:00.000Z", chains: [
    { id: 1, name: "Ethereum" }, { id: 8453, name: "Base" },
  ], positions };
}

for (const [name, evaluate] of [["aave-v4", evaluateAaveV4Health], ["morpho", evaluateMorphoHealth]] as const) {
  test(`${name}: market overrides win, new markets use default, output feeds AlertPolicy`, async () => {
    const data = inputs([position(), position({ id: `8453:${address}`, name: "Base / Main / exact",
      market_name: "Base / Main", chain_id: 8453, health_factor: "1.14" })]);
    const { output } = evaluate(data, 1.15, { "Ethereum / Main": 1.05 });
    const inspected = output.fields.positions as Array<HealthPosition & {threshold: string; threshold_source: string}>;
    assert.equal(output.matched, true);
    assert.equal(inspected[0].chain_id, 8453);
    assert.equal(inspected[0].threshold_source, "default");
    assert.equal(inspected[1].threshold, "1.05");
    assert.equal(output.messages?.length, 1);
    assert.match(output.messages![0].description, /1.1400/);
    assert.deepEqual(Object.keys(output).sort(), ["fields", "matched", "messages"]);
    const decision = await alertPolicy(output, "warning");
    assert.equal(decision.messages[0].severity, "warning");
    assert.equal(decision.messages[0].title, output.messages![0].title);
    const first = evaluate(data, 1.15, { "Ethereum / Main": 1.05 });
    assert.equal(evaluate(data, 1.15, { "Ethereum / Main": 1.05 }, first.states).output.matched, false);
  });

  test(`${name}: zero, equality, decimal precision, recovery and closed positions`, () => {
    assert.equal(evaluate(inputs([position({ health_factor: 0 })]), 1.15).output.matched, true);
    assert.equal(evaluate(inputs([position({ health_factor: 1e-8 })]), 1.15).output.matched, true);
    assert.equal(evaluate(inputs([position({ health_factor: 1e21 })]), 1.15).output.matched, false);
    assert.equal(evaluate(inputs([position({ health_factor: "1.15" })]), 1.15).output.matched, false);
    assert.equal(evaluate(inputs([position({ health_factor: "1.149999999999999999" })]), "1.15").output.matched, true);
    assert.deepEqual(evaluate(inputs([position({ health_factor: "1.3" })]), 1.15).output.messages, []);
    const closed = evaluate(inputs([]), 1.15).output;
    assert.deepEqual(closed.fields.positions, []);
    assert.equal(closed.matched, false);
    const supplied = evaluate(inputs([position({ has_debt: false, health_factor: null })]), 1.15).output;
    assert.deepEqual(supplied.fields.positions, []);
  });

  test(`${name}: malformed HF and thresholds fail rather than reporting healthy`, () => {
    for (const hf of [null, undefined, "", "bad", -1, NaN, Infinity]) {
      assert.throws(() => evaluate(inputs([position({ health_factor: hf as never })]), 1.15), /HF/);
    }
    for (const threshold of [null, "", "bad", -1, 0, NaN, Infinity, true]) {
      assert.throws(() => evaluate(inputs(), threshold as never));
      assert.throws(() => evaluate(inputs(), 1.15, { "Ethereum / Main": threshold as never }));
    }
    assert.throws(() => evaluate(inputs(), 1.15, [] as never));
    assert.throws(() => evaluate({ ...inputs(), positions: null } as never, 1.15));
  });
}

test("ambiguous short names fail; exact names select independently and unknown keys are visible", () => {
  const a = position();
  const b = position({ id: "1:other", name: "Ethereum / Main / other" });
  assert.throws(() => inspectHealthFactors(inputs([a, b]), 1.15, { "Ethereum / Main": 1.05 }), /Ambiguous/);
  const result = inspectHealthFactors(inputs([a, b]), 1.15, { [a.name]: 1.05, "Future market": 1.2 });
  assert.deepEqual(result.breached_positions, [b.id]);
  assert.deepEqual(result.unused_thresholds, ["Future market"]);
  assert.equal(inspectHealthFactors(inputs([a]), 1.15, {
    [a.name]: 1.05, [a.market_name]: 1.3,
  }).matched, false);
  assert.throws(() => inspectHealthFactors(inputs([a, a]), 1.15, {}), /duplicate/);
});

test("generic position health state deduplicates, rearms, and emits one message per position", () => {
  const unsafe = inputs([
    position({ id: "1:first", name: "Ethereum / First", market_name: "Ethereum / First" }),
    position({ id: "1:second", name: "Ethereum / Second", market_name: "Ethereum / Second" }),
  ]);
  const first = evaluateMorphoHealth(unsafe, 1.15);
  assert.equal(first.output.matched, true);
  assert.equal(first.output.messages.length, 2);
  assert.notEqual(
    first.output.messages[0].fields?.finding_id,
    first.output.messages[1].fields?.finding_id,
  );

  const repeated = evaluateMorphoHealth(unsafe, 1.15, {}, first.states);
  assert.equal(repeated.output.matched, false);
  assert.deepEqual(repeated.output.messages, []);
  assert.equal((repeated.output.fields.active_findings as unknown[]).length, 2);

  const safe = inputs([
    position({ id: "1:first", name: "Ethereum / First", market_name: "Ethereum / First", health_factor: "1.3" }),
    position({ id: "1:second", name: "Ethereum / Second", market_name: "Ethereum / Second", health_factor: "1.3" }),
  ]);
  const recovered = evaluateMorphoHealth(safe, 1.15, {}, repeated.states);
  assert.equal(recovered.output.matched, false);
  assert.deepEqual(recovered.output.fields.active_findings, []);

  const triggeredAgain = evaluateMorphoHealth(unsafe, 1.15, {}, recovered.states);
  assert.equal(triggeredAgain.output.matched, true);
  assert.equal(triggeredAgain.output.messages.length, 2);
});

test("common engine evaluates HF drop, debt growth and liquidation buffer across runs", () => {
  const rules: PositionRiskRule[] = [
    { id: "hf_drop_5m", kind: "health_factor_drop", window_minutes: 5, threshold_percent: 10 },
    { id: "debt_up_5m", kind: "debt_growth", window_minutes: 5, threshold_percent: 20 },
    { id: "buffer_20", kind: "liquidation_buffer", threshold_percent: 20 },
  ];
  const firstInputs = inputs([position({ health_factor: "1.5", debt_usd: "100" })]);
  const first = evaluatePositionHealth(firstInputs, 1.1, {}, {}, rules);
  assert.equal(first.triggered_findings.length, 0);
  assert.equal(first.states.history[position().id].length, 1);

  const changed = {
    ...firstInputs,
    observed_at: "2026-09-05T00:05:00.000Z",
    positions: [position({ health_factor: "1.2", debt_usd: "130" })],
  };
  const second = evaluatePositionHealth(changed, 1.1, {}, first.states, rules);
  assert.deepEqual(second.triggered_findings.map((finding) => finding.rule_id), [
    "hf_drop_5m", "debt_up_5m", "buffer_20",
  ]);
  assert.deepEqual(second.triggered_findings.map((finding) => finding.value), ["20", "30", "16.6667"]);
  assert.equal(evaluatePositionHealth(changed, 1.1, {}, second.states, rules).triggered_findings.length, 0);
});

test("position engine applies stress scenarios, hysteresis, repeats, and bounded history", () => {
  const start = inputs([position({ health_factor: "1.09" })]);
  const first = evaluatePositionHealth(start, 1.1, {}, {}, [], [{
    id: "collateral_down_10", collateral_change_percent: -10, threshold: 1.1,
  }], { rearm_health_factor_margin: 0.05, repeat_interval_minutes: 60 });
  assert.deepEqual(first.triggered_findings.map((finding) => finding.kind), [
    "health_factor", "stress_health_factor",
  ]);
  assert.equal(first.triggered_findings[1].value, "0.981");
  assert.equal(first.triggered_findings[1].approximate, true);

  const recovering = { ...start, observed_at: "2026-09-05T00:30:00.000Z",
    positions: [position({ health_factor: "1.12" })] };
  const stillActive = evaluatePositionHealth(recovering, 1.1, {}, first.states, [], [{
    id: "collateral_down_10", collateral_change_percent: -10, threshold: 1.1,
  }], { rearm_health_factor_margin: 0.05, repeat_interval_minutes: 60 });
  assert.equal(stillActive.active_findings.some((finding) => finding.kind === "health_factor"), true);
  assert.equal(stillActive.triggered_findings.length, 0);

  const repeated = evaluatePositionHealth({ ...recovering, observed_at: "2026-09-05T01:00:00.000Z" },
    1.1, {}, stillActive.states, [], [{
      id: "collateral_down_10", collateral_change_percent: -10, threshold: 1.1,
    }], { rearm_health_factor_margin: 0.05, repeat_interval_minutes: 60 });
  assert.equal(repeated.triggered_findings.length, 2);

  let states: unknown = {};
  const historyRule: PositionRiskRule[] = [{
    id: "slow", kind: "health_factor_drop", window_minutes: 1440, threshold_percent: 99,
  }];
  for (let minute = 0; minute < 130; minute++) {
    states = evaluatePositionHealth({
      ...start, observed_at: new Date(Date.parse(start.observed_at) + minute * 60_000).toISOString(),
    }, 1, {}, states, historyRule).states;
  }
  assert.equal((states as { history: Record<string, unknown[]> }).history[position().id].length, 120);
});

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

test("message policy bounds output and summarizes overflow", () => {
  const findings = evaluatePositionHealth(inputs([
    position({ id: "1:a", name: "A", market_name: "A" }),
    position({ id: "1:b", name: "B", market_name: "B" }),
    position({ id: "1:c", name: "C", market_name: "C" }),
  ]), 1.15).triggered_findings;
  const summarized = renderPositionHealthMessages("Test", user, inputs().observed_at, findings, {
    max_messages: 2, overflow: "summary",
  });
  assert.equal(summarized.length, 2);
  assert.equal(summarized[1].fields?.finding_kind, "summary");
  assert.equal(summarized[1].fields?.omitted_findings, 2);
  assert.equal(renderPositionHealthMessages("Test", user, inputs().observed_at, findings, {
    max_messages: 2, overflow: "truncate",
  }).length, 2);
});

test("Spark Source decodes getUserAccountData and adapter produces common positions", async (t) => {
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  const result = `0x${[150_00000000n, 100_00000000n, 0n, 0n, 0n, 12n * 10n ** 17n].map(word).join("")}`;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.equal(request.method, "eth_call");
    assert.match(request.params[0].data, /^0xbf92857c/);
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
  const raw = await sparkSource({ markets: [{
    name: "Main", chain_id: 1, chain_name: "Ethereum", pool_address: address,
    rpc_url: "https://rpc.example.test", base_currency_decimals: 8,
  }] }, user);
  const normalized = sparkHealthAdapter.normalize(raw, { user, chain_ids: [1] });
  assert.deepEqual(normalized.positions[0], {
    id: `1:${address}`, name: `Ethereum / Main / ${address}`, market_name: "Ethereum / Main",
    chain_id: 1, health_factor: "1.2", has_debt: true,
    debt_usd: "100", collateral_usd: "150",
  });
});

function aaveResult() {
  return {
    chains: [{ chainId: 1, name: "Ethereum" }, { chainId: 10, name: "OP Mainnet" }],
    userPositions: [
      { user, healthFactor: { current: "0" as string | null }, totalDebt: { current: { value: "100" } },
        totalCollateral: { current: { value: "0" } },
        spoke: { address, name: "Main", chain: { chainId: 1, name: "Ethereum" } } },
      { user, healthFactor: { current: null as string | null }, totalDebt: { current: { value: "0" } },
        totalCollateral: { current: { value: "100" } },
        spoke: { address, name: "Main", chain: { chainId: 10, name: "OP Mainnet" } } },
    ],
  };
}

test("Aave native queries discover mainnets then request explicitly selected chains", () => {
  const chains = readFileSync(new URL("../f/aave/scripts/sources/aave_v4_chains.gql", import.meta.url), "utf8");
  const positions = readFileSync(new URL("../f/aave/scripts/sources/aave_v4_user_positions.gql", import.meta.url), "utf8");
  assert.match(chains, /MAINNET_ONLY/);
  assert.match(positions, /\$chain_ids: \[ChainId!\]!/);
  assert.match(positions, /chainIds: \$chain_ids/);
  assert.match(positions, /healthFactor \{current\}/);
  const v3 = readFileSync(new URL("../f/aave/scripts/sources/aave_market_positions.gql", import.meta.url), "utf8");
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

test("Aave normalizes cross-network Spokes, preserving zero HF and excluding supply-only accounts", () => {
  const data = normalizeAaveV4Positions(aaveResult(), user);
  assert.equal(data.positions.length, 2);
  assert.equal(evaluateAaveV4Health(data, 1.15).output.matched, true);
  assert.equal((evaluateAaveV4Health(data, 1.15).output.fields.positions as unknown[]).length, 1);
  assert.notEqual(data.positions[0].id, data.positions[1].id);
  const selected = aaveResult();
  selected.userPositions = selected.userPositions.slice(0, 1);
  assert.deepEqual(normalizeAaveV4Positions(selected, user, [1]).chains, [{ id: 1, name: "Ethereum" }]);
  assert.throws(() => normalizeAaveV4Positions(selected, user, [999]), /Unsupported chain/);
  assert.throws(() => normalizeAaveV4Positions(selected, user, [10]), /Invalid Aave/);
  assert.throws(() => normalizeAaveV4Positions(selected, address), /owner/);
});

test("Aave rejects missing or partial responses but accepts a genuinely empty account", () => {
  const empty = { ...aaveResult(), userPositions: [] };
  assert.deepEqual(normalizeAaveV4Positions(empty, user).positions, []);
  assert.throws(() => normalizeAaveV4Positions({ ...empty, userPositions: null }, user), /Missing Aave V4 positions/);
  assert.throws(() => normalizeAaveV4Positions({ ...empty, chains: [] }, user), /networks/);
  assert.throws(() => normalizeAaveV4Positions({ data: null }, user), /Missing Aave/);
  assert.throws(() => normalizeAaveV4Positions({ data: empty, errors: [{message: "partial"}] }, user), /GraphQL returned errors/);
  const badDebt = aaveResult();
  badDebt.userPositions[0].totalDebt.current.value = "bad";
  assert.throws(() => normalizeAaveV4Positions(badDebt, user), /debt/);
});

function morphoPosition(index: number, chain = 1) {
  return { user: { address: user }, healthFactor: 1.2, market: { marketId: marketId(index), lltv: "860000000000000000",
    chain: { id: chain, network: chain === 1 ? "Ethereum" : "Base" },
    loanAsset: { symbol: "USDC" }, collateralAsset: { symbol: "wstETH" } },
    state: { borrowShares: "1", borrowAssetsUsd: 100, collateralUsd: 150 } };
}

function morphoResult(items = [morphoPosition(0)]) {
  return {
    chains: [{ id: 1, network: "Ethereum" }, { id: 8453, network: "Base" }],
    marketPositions: { items, pageInfo: { count: items.length, countTotal: items.length, skip: 0, limit: 1000 } },
  };
}

test("Morpho native GraphQL uses a single query, fixed 1000 limit and optional network filter", () => {
  const query = readFileSync(new URL("../f/morpho/scripts/sources/morpho_user_positions.gql", import.meta.url), "utf8");
  assert.match(query, /first: 1000/);
  assert.match(query, /skip: 0/);
  assert.match(query, /\$chain_ids: \[Int!\]/);
  assert.match(query, /chainId_in: \$chain_ids/);
  const liquidations = readFileSync(new URL("../f/morpho/scripts/sources/morpho_user_liquidations.gql", import.meta.url), "utf8");
  assert.match(liquidations, /type_in: \[Liquidation\]/);
  assert.match(liquidations, /logIndex/);
  const marketRisk = readFileSync(new URL("../f/morpho/scripts/sources/morpho_market_risk.gql", import.meta.url), "utf8");
  assert.match(marketRisk, /badDebt/);
  assert.match(marketRisk, /warnings/);
  assert.match(query, /userAddress_in: \[\$user\]/);
  assert.match(query, /borrowShares_gte: "1"/);
  assert.match(query, /pageInfo \{ count countTotal limit skip \}/);
  assert.doesNotMatch(query, /marketListed/);
});

test("Morpho accepts a complete cross-network snapshot and exactly 1000 positions", () => {
  const items = [...Array.from({ length: 100 }, (_, i) => morphoPosition(i)), morphoPosition(0, 8453)];
  const data = normalizeMorphoPositions({ data: morphoResult(items) }, user);
  assert.equal(data.positions.length, 101);
  assert.notEqual(data.positions[0].id, data.positions[100].id);
  assert.match(data.positions[0].market_name, /LLTV 86%/);
  assert.equal(normalizeMorphoPositions(morphoResult(Array.from({ length: 1000 }, (_, i) => morphoPosition(i))), user).positions.length, 1000);
});

test("Morpho validates selected networks, account and empty responses", () => {
  const data = normalizeMorphoPositions(morphoResult([morphoPosition(0, 8453)]), user, [8453]);
  assert.deepEqual(data.chains, [{ id: 8453, name: "Base" }]);
  assert.deepEqual(normalizeMorphoPositions(morphoResult([]), user).positions, []);
  assert.throws(() => normalizeMorphoPositions(morphoResult([]), user, [999]), /Unsupported chain/);
  assert.throws(() => normalizeMorphoPositions(morphoResult(), user, [8453]), /Invalid Morpho/);
  assert.throws(() => normalizeMorphoPositions(morphoResult(), address), /Invalid Morpho/);
  assert.throws(() => normalizeMorphoPositions({ data: null }, user), /Missing Morpho/);
  assert.throws(() => normalizeMorphoPositions({ data: morphoResult(), errors: [{ message: "partial" }] }, user), /GraphQL returned errors/);
});

test("Morpho refuses more than 1000 positions, count mismatch, nonzero offset or a missing page", () => {
  const truncated = morphoResult(Array.from({ length: 1000 }, (_, i) => morphoPosition(i)));
  truncated.marketPositions.pageInfo.countTotal = 1001;
  assert.throws(() => normalizeMorphoPositions(truncated, user), /incomplete/);
  for (const patch of [{ count: 0 }, { countTotal: 2 }, { skip: 1 }, { countTotal: null }]) {
    const result = morphoResult();
    Object.assign(result.marketPositions.pageInfo, patch);
    assert.throws(() => normalizeMorphoPositions(result, user), /incomplete/);
  }
  const empty = morphoResult([]);
  empty.marketPositions.pageInfo.countTotal = 1;
  assert.throws(() => normalizeMorphoPositions(empty, user), /incomplete/);
  assert.throws(() => normalizeMorphoPositions({ ...morphoResult(), marketPositions: null }, user), /incomplete/);
});

test("Morpho rejects invalid positions, and duplicate IDs are rejected by the evaluator", () => {
  assert.throws(() => normalizeMorphoPositions(morphoResult([{ ...morphoPosition(0), state: null } as never]), user), /Invalid Morpho/);
  const duplicated = normalizeMorphoPositions(morphoResult([morphoPosition(0), morphoPosition(0)]), user);
  assert.throws(() => evaluateMorphoHealth(duplicated, 1.15), /duplicate/);
  const result = morphoResult();
  result.marketPositions.items = null as never;
  assert.throws(() => normalizeMorphoPositions(result, user), /incomplete/);
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

test("Rule validation fails before reaching state persistence", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected state write"); });
  const badAave = aaveResult();
  badAave.userPositions[0].healthFactor.current = null;
  await assert.rejects(aaveRule(badAave, user, 1.15), /HF/);
  const bad = morphoResult();
  bad.marketPositions.items[0].healthFactor = null as never;
  await assert.rejects(morphoRule(bad, user, 1.15), /HF/);
  const truncated = morphoResult();
  truncated.marketPositions.pageInfo.countTotal = 1001;
  await assert.rejects(morphoRule(truncated, user, 1.15), /incomplete/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("both Rules persist Source inputs and MonitorOutput under their respective root Flow", async (t) => {
  const oldWorkspace = process.env.WM_WORKSPACE;
  const oldJob = process.env.WM_JOB_ID;
  process.env.WM_WORKSPACE = "test-only";
  process.env.WM_JOB_ID = "rule-job";
  t.after(() => {
    if (oldWorkspace === undefined) delete process.env.WM_WORKSPACE;
    else process.env.WM_WORKSPACE = oldWorkspace;
    if (oldJob === undefined) delete process.env.WM_JOB_ID;
    else process.env.WM_JOB_ID = oldJob;
  });
  let root = "u/test/aave";
  const saved: Array<{ path: string; value: unknown }> = [];
  t.mock.method(wmill.JobService, "getRootJobId", async () => "root-job");
  t.mock.method(wmill.JobService, "getJob", async () => ({ script_path: root }));
  t.mock.method(wmill.ResourceService, "getResourceValueInterpolated", async () => undefined);
  t.mock.method(wmill.ResourceService, "existsResource", async () => false);
  t.mock.method(wmill.ResourceService, "createResource", async ({ requestBody }: {
    requestBody: { path: string; value: unknown; resource_type: string };
  }) => {
    assert.equal(requestBody.resource_type, "monitor_state");
    saved.push(requestBody);
  });
  const rawAave = aaveResult();
  const aave = await aaveRule(rawAave, user, 1.15);
  root = "u/test/morpho";
  const rawMorpho = { data: morphoResult() };
  const morpho = await morphoRule(rawMorpho, user, 1.15);
  assert.deepEqual(saved.map((entry) => entry.path), [
    "u/test/aave/__monitor_state", "u/test/morpho/__monitor_state",
  ]);
  for (const [i, output] of [aave, morpho].entries()) {
    const state = saved[i].value as { inputs: HealthInputs; states: unknown; outputs: RT.MonitorOutput };
    assert.deepEqual(state.inputs, i === 0 ? rawAave : rawMorpho);
    assert.deepEqual(state.outputs, output);
    assert.deepEqual(Object.keys(state).sort(), ["inputs", "outputs", "states"]);
  }
});

test("large snapshots keep full fields and produce bounded per-position messages", async (t) => {
  const data = inputs(Array.from({ length: 150 }, (_, i) => position({
    id: `1:${marketId(i)}`, name: `Ethereum / Market ${i}`, market_name: `Ethereum / Market ${i}`,
  })));
  const { output } = evaluateMorphoHealth(data, 1.15);
  assert.equal((output.fields.positions as unknown[]).length, 150);
  assert.equal(output.messages?.length, 20);
  assert.equal(output.messages.at(-1)?.fields?.finding_kind, "summary");
  assert.ok(output.messages!.every((message) => message.description.length < 3500));
  const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { text } = JSON.parse(String(init.body));
    assert.ok(text.length <= 4096);
    assert.match(text, /Market: Ethereum \/ Market 0/);
    assert.match(text, /Full fields/);
    return Response.json({ ok: true });
  });
  const { messages } = await alertPolicy(output);
  await telegram({ token: "test-only" }, "test-only", [messages[0]]);
  assert.equal(fetch.mock.callCount(), 1);
});
