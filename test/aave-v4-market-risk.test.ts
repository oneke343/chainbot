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

test("first observation establishes both cap baselines without change alerts", () => {
  const first = evaluateAaveV4MarketRisk({ reserves: [reserve()] });
  assert.equal(first.output.matched, false);
  assert.deepEqual(first.output.fields.cap_changes, []);
  assert.deepEqual(first.states.caps["reserve-usdg"], {
    supply: "100000000", borrow: "100000000", decimals: 6,
  });
  // An existing instance with Spoke-level signals gets a new reserve baseline.
  assert.equal(evaluateAaveV4MarketRisk({ reserves: [reserve()] }, {}, {}, { signals: {} }).output.matched, false);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test("supply and borrow changes report old/new values and each observed change alerts once", () => {
  const r = reserve();
  const first = evaluateAaveV4MarketRisk({ reserves: [r] });
  r.settings.supplyCap = amount("200000000");
  r.settings.borrowCap = amount("80000000");
  const changed = evaluateAaveV4MarketRisk({ reserves: [r] }, {}, {}, first.states);
  assert.equal(changed.output.messages.length, 2);
  assert.deepEqual(changed.output.fields.cap_changes.map((c) => [c.cap_type, c.old_cap, c.new_cap]), [
    ["supply", "100000000", "200000000"], ["borrow", "100000000", "80000000"],
  ]);
  assert.match(changed.output.messages[0].description, /100 → 200 USDG/);
  assert.equal(changed.output.messages[0].fields.hub_address, hubAddress);
  assert.equal(changed.output.messages[0].fields.spoke_address, spokeAddress);
  assert.equal(evaluateAaveV4MarketRisk({ reserves: [r] }, {}, {}, changed.states).output.matched, false);
  r.settings.supplyCap = amount("300000000");
  const again = evaluateAaveV4MarketRisk({ reserves: [r] }, {}, {}, changed.states);
  assert.equal(again.output.messages.length, 1);
  assert.match(again.output.messages[0].description, /200 → 300 USDG/);
  assert.equal(first.states.caps["reserve-usdg"].supply, "100000000");
});

test("balances, prices and API capacity changes do not trigger cap-change alerts", () => {
  const r = reserve();
  const first = evaluateAaveV4MarketRisk({ reserves: [r] });
  r.summary.supplied = amount("97000000", 6, "5000");
  r.summary.borrowed = amount("60000000", 6, "4000");
  r.summary.borrowable = amount("0");
  r.canBorrow = false;
  r.settings.supplyCap = amount("0100000000", 6, "99999");
  const next = evaluateAaveV4MarketRisk({ reserves: [r] }, {}, {}, first.states);
  assert.equal(next.output.matched, false);
  const market = next.output.fields.markets[0] as ReturnType<typeof normalizeAaveV4MarketRisk>[number];
  assert.equal(market.borrow_cap_remaining, "40000000");
  assert.equal(market.borrowable, "0");
});

test("cap comparisons preserve one-unit changes above Number's safe integer range", () => {
  const r = reserve();
  r.settings.supplyCap = amount("9007199254740992");
  const first = evaluateAaveV4MarketRisk({ reserves: [r] });
  r.settings.supplyCap = amount("9007199254740993");
  const next = evaluateAaveV4MarketRisk({ reserves: [r] }, {}, {}, first.states);
  assert.equal(next.output.fields.cap_changes[0].new_cap, "9007199254740993");
  assert.match(next.output.messages[0].description, /9007199254\.740992 → 9007199254\.740993/);
});

test("cap changes include zero and unlimited transitions without dividing by zero", () => {
  const r = reserve();
  let previous = evaluateAaveV4MarketRisk({ reserves: [r] }).states;
  const unlimited = (((1n << 40n) - 1n) * 10n ** 6n).toString();
  for (const [value, label] of [["0", "0"], [unlimited, "unlimited"], ["100000000", "100"]]) {
    r.settings.supplyCap = amount(value);
    const next = evaluateAaveV4MarketRisk({ reserves: [r] }, { max_supply_cap_used_percent: 99 }, {}, previous);
    assert.equal(next.output.fields.cap_changes.length, 1);
    assert.match(next.output.messages[0].description, new RegExp(`→ ${label} USDG`));
    const market = next.output.fields.markets[0] as ReturnType<typeof normalizeAaveV4MarketRisk>[number];
    if (value === "0") assert.equal(market.supply_cap_remaining, "0");
    if (value === unlimited) assert.equal(market.supply_cap_remaining, null);
    previous = next.states;
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
  assert.deepEqual(crossed.output.fields.cap_changes, []);
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
  b.settings.borrowCap = amount("110000000");
  const next = evaluateAaveV4MarketRisk(raw, {}, {}, first.states);
  assert.equal(next.output.messages.length, 1);
  assert.equal(next.output.messages[0].fields.market_id, "reserve-b");
  const selected = evaluateAaveV4MarketRisk(raw, {}, {}, {}, ["spoke-b"], ["reserve-b"]);
  assert.deepEqual(Object.keys(selected.states.caps), ["reserve-b"]);
  assert.throws(() => evaluateAaveV4MarketRisk(raw, {}, {}, {}, ["missing"]), /Missing selected Spoke/);
  assert.throws(() => evaluateAaveV4MarketRisk(raw, {}, {}, {}, [], ["missing"]), /Missing selected reserve/);
  assert.throws(() => evaluateAaveV4MarketRisk(raw, {}, {}, {}, ["spoke-a", "spoke-a"]), /unique/);
});

test("temporary missing reserves preserve the last successful cap baseline; new assets start silently", () => {
  const r = reserve();
  const first = evaluateAaveV4MarketRisk({ reserves: [r] });
  const absent = evaluateAaveV4MarketRisk({ reserves: [] }, {}, {}, first.states);
  assert.deepEqual(absent.states.caps, first.states.caps);
  r.settings.borrowCap = amount("90000000");
  const returned = evaluateAaveV4MarketRisk({ reserves: [r, reserve("new-reserve")] }, {}, {}, absent.states);
  assert.equal(returned.output.messages.length, 1);
  assert.equal(returned.output.messages[0].fields.market_id, r.id);
});

test("failed calculations and invalid stored baselines do not mutate the supplied state", () => {
  const r = reserve();
  const state = evaluateAaveV4MarketRisk({ reserves: [r] }).states;
  const before = structuredClone(state);
  r.settings.supplyCap = amount("1.5");
  assert.throws(() => evaluateAaveV4MarketRisk({ reserves: [r] }, {}, {}, state), SyntaxError);
  assert.deepEqual(state, before);
  const corrupted = structuredClone(state);
  corrupted.caps["reserve-usdg"] = null;
  assert.throws(() => evaluateAaveV4MarketRisk({ reserves: [reserve()] }, {}, {}, corrupted), /Invalid cap baseline/);
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

test("main persists successful baselines, failed reads do not overwrite them, and cap messages reach Telegram", async (t) => {
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
  const changed = await main({ reserves: [r] });
  assert.equal(changed.messages.length, 1);
  const { messages } = await alertPolicy(changed);
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
    const { text } = JSON.parse(String(init.body));
    assert.match(text, /100 → 200 USDG/);
    assert.match(text, /Ethereum \/ Core \/ Main \/ USDG/);
    return Response.json({ ok: true });
  });
  await telegram({ token: "test-only" }, "test-only", messages);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await main({ reserves: [r] })).matched, false);
  assert.equal(writes, 3);
});
