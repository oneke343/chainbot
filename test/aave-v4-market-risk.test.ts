import assert from "node:assert/strict";
import test from "node:test";
import * as wmill from "windmill-client";
import {
  evaluateAaveV4MarketRisk, normalizeAaveV4MarketRisk, main,
} from "../f/aave/scripts/rules/evaluate_aave_v4_market_risk.ts";
import { main as alertPolicy } from "../f/chain_sentinel/scripts/alert_policies/matched_output.ts";
import { main as telegram } from "../f/chain_sentinel/scripts/destinations/send_telegram.ts";

const spokeAddress = `0x${"1".repeat(40)}`;
const hubAddress = `0x${"2".repeat(40)}`;
const tokenAddress = `0x${"3".repeat(40)}`;

function amount(onChainValue: string, decimals = 6, usd = "100") {
  return { amount: { onChainValue, decimals }, exchange: { value: usd } };
}

function reserve(id = "reserve-usdg", spokeId = "spoke-main") {
  return {
    id,
    chain: { chainId: 1, name: "Ethereum" },
    spoke: { id: spokeId, name: "Main", address: spokeAddress },
    asset: {
      onchainAssetId: "1",
      hub: { id: "hub-core", name: "Core", address: hubAddress },
      underlying: { address: tokenAddress, info: { symbol: "USDG", decimals: 6 } },
    },
    summary: {
      supplied: amount("96000000"), borrowed: amount("50000000", 6, "50"),
      suppliable: amount("4000000"), borrowable: amount("50000000"),
    },
    settings: { supplyCap: amount("100000000"), borrowCap: amount("100000000") },
    status: { paused: false, frozen: false, active: true },
    canSupply: true, canBorrow: true,
  };
}

test("Aave V4 cap snapshots are isolated by reserve instead of Spoke totals", () => {
  const markets = normalizeAaveV4MarketRisk({ reserves: [reserve(), reserve("reserve-usdc")] });
  assert.equal(markets.length, 2);
  assert.notEqual(markets[0].id, markets[1].id);
  assert.equal(markets[0].market, "Ethereum / Core / Main / USDG");
  assert.equal(markets[0].supply_cap_used_percent, 96);
  assert.equal(markets[0].borrow_cap_used_percent, 50);
});

test("market risk does not emit parameter-change messages or retain cap baselines", () => {
  const r = reserve();
  const first = evaluateAaveV4MarketRisk({ reserves: [r] });
  r.settings.supplyCap = amount("200000000");
  r.settings.borrowCap = amount("0");
  const changed = evaluateAaveV4MarketRisk({ reserves: [r] }, {}, {}, first.states);
  assert.equal(changed.output.matched, false);
  assert.equal("caps" in changed.states, false);
  assert.equal("cap_changes" in changed.output.fields, false);
});

test("zero and unlimited caps skip fullness checks", () => {
  for (const value of ["0", (((1n << 40n) - 1n) * 10n ** 6n).toString()]) {
    const r = reserve();
    r.settings.supplyCap = amount(value);
    const next = evaluateAaveV4MarketRisk({ reserves: [r] }, { max_supply_cap_used_percent: 95 });
    assert.equal(next.output.matched, false);
  }
});

test("fullness thresholds compare exactly, deduplicate, and rearm independently of cap changes", () => {
  const r = reserve();
  const decimals = 18;
  r.asset.underlying.info.decimals = decimals;
  for (const key of ["supplied", "borrowed", "suppliable", "borrowable"] as const) {
    r.summary[key] = amount("0", decimals);
  }
  r.settings.supplyCap = amount("100000000000000000000", decimals);
  r.settings.borrowCap = amount("100000000000000000000", decimals);
  r.summary.supplied = amount("95000000000000000000", decimals);
  const rules = { max_supply_cap_used_percent: 95, max_borrow_cap_used_percent: 95 };
  const first = evaluateAaveV4MarketRisk({ reserves: [r] }, rules);
  assert.equal(first.output.matched, false); // equal is not above the threshold
  r.summary.supplied = amount("95000000000000000001", decimals);
  const crossed = evaluateAaveV4MarketRisk({ reserves: [r] }, rules, {}, first.states);
  assert.equal(crossed.output.messages.length, 1);
  assert.equal(crossed.output.messages[0].fields.finding_kind, "supply_cap");
  assert.equal(evaluateAaveV4MarketRisk({ reserves: [r] }, rules, {}, crossed.states).output.matched, false);
  r.summary.supplied = amount("94000000000000000000", decimals);
  const recovered = evaluateAaveV4MarketRisk({ reserves: [r] }, rules, {}, crossed.states);
  r.summary.supplied = amount("110000000000000000000", decimals);
  const again = evaluateAaveV4MarketRisk({ reserves: [r] }, rules, {}, recovered.states);
  assert.equal(again.output.messages.length, 1);
  const market = again.output.fields.markets[0] as ReturnType<typeof normalizeAaveV4MarketRisk>[number];
  assert.equal(market.supply_cap_used_percent, 110);
  assert.equal(market.supply_cap_remaining, "0");
});

test("assets on different Spokes alert independently and support per-reserve overrides", () => {
  const a = reserve("reserve-a", "spoke-a");
  const b = reserve("reserve-b", "spoke-b");
  const raw = { reserves: [a, b] };
  const first = evaluateAaveV4MarketRisk(raw, { max_supply_cap_used_percent: 95 }, {
    "reserve-b": { max_supply_cap_used_percent: 99 },
  });
  assert.equal(first.output.messages.length, 1);
  assert.equal(first.output.messages[0].fields.market_id, "reserve-a");
  const selected = evaluateAaveV4MarketRisk(raw, {}, {}, {}, ["spoke-b"], ["reserve-b"]);
  assert.deepEqual(selected.output.fields.markets.map((m) => m.id), ["reserve-b"]);
  assert.throws(() => evaluateAaveV4MarketRisk(raw, {}, {}, {}, ["missing"]), /Missing selected Spoke/);
  assert.throws(() => evaluateAaveV4MarketRisk(raw, {}, {}, {}, [], ["missing"]), /Missing selected reserve/);
  assert.throws(() => evaluateAaveV4MarketRisk(raw, {}, {}, {}, ["spoke-a", "spoke-a"]), /unique/);
});

test("decimal and exponential thresholds work and invalid thresholds fail", () => {
  const r = reserve();
  assert.equal(evaluateAaveV4MarketRisk({ reserves: [r] }, { max_supply_cap_used_percent: 95.5 }).output.matched, true);
  assert.equal(evaluateAaveV4MarketRisk({ reserves: [r] }, { max_supply_cap_used_percent: 1e-7 }).output.matched, true);
  assert.equal(evaluateAaveV4MarketRisk({ reserves: [r] }, { max_supply_cap_used_percent: 1e21 }).output.matched, false);
  for (const bad of [NaN, Infinity, -1, "95", null]) {
    assert.throws(() => evaluateAaveV4MarketRisk({ reserves: [r] }, { max_supply_cap_used_percent: bad as number }), /threshold/);
  }
});

test("existing liquidity, utilization and protocol status risk checks remain available", () => {
  const r = reserve();
  r.status.frozen = true;
  const result = evaluateAaveV4MarketRisk({ reserves: [r] }, {
    min_liquidity_usd: 60, max_utilization_percent: 40,
  });
  assert.deepEqual(result.output.messages.map((message) => message.fields.finding_kind).sort(), [
    "liquidity", "protocol_config", "utilization",
  ]);
});

test("market risk persists thresholds and sends usage messages, not cap changes", async (t) => {
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
  let stored: unknown;
  let writes = 0;
  t.mock.method(wmill.JobService, "getRootJobId", async () => "root-job");
  t.mock.method(wmill.JobService, "getJob", async () => ({ script_path: "u/test/v4-cap" }));
  t.mock.method(wmill.ResourceService, "getResourceValueInterpolated", async () => stored);
  t.mock.method(wmill.ResourceService, "existsResource", async () => false);
  t.mock.method(wmill.ResourceService, "createResource", async ({ requestBody }) => {
    assert.equal(requestBody.path, "u/test/v4-cap/__monitor_state");
    stored = structuredClone(requestBody.value);
    writes++;
  });
  const r = reserve();
  assert.equal((await main({ reserves: [r] })).matched, false);
  const baseline = structuredClone(stored);
  r.settings.supplyCap = amount("invalid");
  await assert.rejects(main({ reserves: [r] }), SyntaxError);
  assert.equal(writes, 1);
  assert.deepEqual(stored, baseline);
  r.settings.supplyCap = amount("200000000");
  r.summary.supplied = amount("196000000");
  const changed = await main({ reserves: [r] }, { max_supply_cap_used_percent: 95 });
  assert.equal(changed.messages.length, 1);
  const { messages } = await alertPolicy(changed);
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
    const { text } = JSON.parse(String(init.body));
    assert.match(text, /cap usage/);
    assert.match(text, /Ethereum \/ Core \/ Main \/ USDG/);
    return Response.json({ ok: true });
  });
  await telegram({ token: "test-only" }, "test-only", messages);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await main({ reserves: [r] }, { max_supply_cap_used_percent: 95 })).matched, false);
  assert.equal(writes, 3);
});
