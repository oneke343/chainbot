import assert from "node:assert/strict";
import test from "node:test";
import {
  main, buildWindow, renderNotifications, DEFAULT_CONFIG, DEFAULT_THRESHOLDS,
  evaluateLiquidity, evaluateBorrowApy, evaluateBalances, evaluateCaps,
} from "../f/aave/rules/aave_v3_market_risk.ts";
import { key, decimal, rate, reserve, snapshot, history } from "./fixtures/aave-v3-reserves.ts";

test("liquidity is bidirectional, percentage-only and inclusive at the threshold", () => {
  const before = reserve();
  before.borrow!.availableLiquidity = decimal(100, 6);
  const current = structuredClone(before);
  current.borrow!.availableLiquidity = decimal(80, 6);
  assert.equal(evaluateLiquidity(before, current, DEFAULT_THRESHOLDS)[0].change, "-0.2");
  current.borrow!.availableLiquidity = decimal(120, 6);
  assert.equal(evaluateLiquidity(before, current, DEFAULT_THRESHOLDS)[0].direction, "increase");
  current.borrow!.availableLiquidity = decimal(119, 6);
  assert.deepEqual(evaluateLiquidity(before, current, DEFAULT_THRESHOLDS), []);
});

test("balance thresholds retain integer precision and align token decimals", () => {
  const before = reserve();
  before.totalSupply = decimal("100000000000000000000");
  const current = structuredClone(before);
  current.totalSupply = decimal("90000000000000000001");
  assert.deepEqual(evaluateBalances(before, current, DEFAULT_THRESHOLDS), []);
  current.totalSupply = decimal("9000000000000000000000", 2);
  assert.equal(evaluateBalances(before, current, DEFAULT_THRESHOLDS)[0].change, "-0.1");
});

test("only supply decreases and borrow increases alert, without an amount floor", () => {
  const before = reserve();
  before.totalSupply = decimal(10, 6);
  before.borrow!.totalBorrow = decimal(10, 6);
  const current = structuredClone(before);
  current.totalSupply = decimal(9, 6);
  current.borrow!.totalBorrow = decimal(11, 6);
  assert.deepEqual(evaluateBalances(before, current, DEFAULT_THRESHOLDS).map((hit) => hit.metric), ["supply_total", "borrow_total"]);
  current.totalSupply = decimal(11, 6);
  current.borrow!.totalBorrow = decimal(9, 6);
  assert.deepEqual(evaluateBalances(before, current, DEFAULT_THRESHOLDS), []);
});

test("APY compares percentage points, only fast rises and not a high current rate", () => {
  const before = reserve();
  const current = reserve();
  current.borrow!.apy = decimal("7000000", 8);
  assert.equal(evaluateBorrowApy(before, current, DEFAULT_THRESHOLDS)[0].change, "0.02");
  current.borrow!.apy = rate(699);
  assert.deepEqual(evaluateBorrowApy(before, current, DEFAULT_THRESHOLDS), []);
  before.borrow!.apy = rate(3000);
  current.borrow!.apy = rate(3000);
  assert.deepEqual(evaluateBorrowApy(before, current, DEFAULT_THRESHOLDS), []);
  current.borrow!.apy = rate(1000);
  assert.deepEqual(evaluateBorrowApy(before, current, DEFAULT_THRESHOLDS), []);
});

test("Cap has one inclusive threshold, permits usage above 100%, and skips unlimited caps", () => {
  const current = reserve();
  current.supplyCap = decimal(1000);
  current.totalSupply = decimal(950);
  current.borrow!.borrowCap = decimal(400);
  const hits = evaluateCaps(current, DEFAULT_THRESHOLDS);
  assert.deepEqual(hits.map((hit) => hit.current), ["0.95", "1.25"]);
  current.totalSupply = decimal(949);
  current.borrow!.borrowCap = decimal(0);
  assert.deepEqual(evaluateCaps(current, DEFAULT_THRESHOLDS), []);
});

test("window chooses a timestamp at or before the target, excludes current/future and sorts history", () => {
  const current = snapshot(18);
  const window = buildWindow(current, [snapshot(19), snapshot(18), snapshot(4), snapshot(1), snapshot(7), snapshot(10), snapshot(13), snapshot(16)]);
  assert.equal(window.baseline?.sampledAt, snapshot(1).sampledAt);
  assert.equal(window.samples.length, 7);
  assert.equal(window.continuous, true);
  assert.equal(buildWindow(current, [snapshot(-1), snapshot(4)]).baseline, null);
  assert.equal(buildWindow(current, [snapshot(0)]).baseline?.sampledAt, snapshot(0).sampledAt);
});

test("utilization needs the buffer throughout a covered window, not merely a high endpoint", async () => {
  const high = reserve();
  high.borrow!.utilizationRate = rate(9200);
  const current = snapshot(15, high);
  assert.deepEqual((await main(current, history(high))).map((hit) => hit.metric), ["utilization"]);
  const low = structuredClone(high);
  low.borrow!.utilizationRate = rate(9050);
  assert.deepEqual(await main(snapshot(15, low), history(low)), []);
  const interrupted = history(high);
  interrupted[2].reserves[key].borrow!.utilizationRate = rate(9199);
  assert.deepEqual(await main(current, interrupted), []);
  assert.deepEqual(await main(current, [snapshot(0, high), snapshot(9, high), snapshot(12, high)]), []);
  assert.deepEqual(await main(current, [snapshot(3, high), snapshot(6, high), snapshot(9, high), snapshot(12, high)]), []);
});

test("utilization uses each sample's own kink and requires that reserve in every sample", async () => {
  const high = reserve();
  high.borrow!.utilizationRate = rate(9200);
  const samples = history(high);
  samples[1].reserves[key].borrow!.optimalUsageRate = rate(9100);
  assert.deepEqual(await main(snapshot(15, high), samples), []);
  samples[1].reserves = {};
  assert.deepEqual(await main(snapshot(15, high), samples), []);
});

test("endpoints still evaluate across a gap but utilization does not", async () => {
  const before = reserve();
  before.borrow!.utilizationRate = rate(9200);
  const current = structuredClone(before);
  current.borrow!.availableLiquidity = decimal(400);
  assert.deepEqual((await main(snapshot(15, current), [snapshot(0, before)])).map((hit) => hit.metric), ["liquidity"]);
});

test("first sample evaluates Cap; supply-only reserves and zero baselines remain meaningful", async () => {
  const supplyOnly = reserve();
  supplyOnly.borrow = null;
  supplyOnly.supplyCap = decimal(1000);
  assert.deepEqual((await main(snapshot(15, supplyOnly), [])).map((hit) => hit.metric), ["supply_cap_usage"]);
  const before = reserve();
  before.totalSupply = decimal(0);
  before.borrow!.totalBorrow = decimal(0);
  before.borrow!.availableLiquidity = decimal(0);
  assert.deepEqual(await main(snapshot(15), [snapshot(0, before)]), []);
  const current = structuredClone(supplyOnly);
  current.totalSupply = decimal(800);
  assert.deepEqual((await main(snapshot(15, current), [snapshot(0, supplyOnly)])).map((hit) => hit.metric), ["supply_total"]);
});

test("Reserve overrides affect only that Reserve and leave defaults unchanged", async () => {
  const current = reserve();
  current.borrow!.availableLiquidity = decimal(400);
  const now = snapshot(15, current);
  now.reserves.other = structuredClone(current);
  const old = snapshot(0);
  old.reserves.other = reserve();
  const hits = await main(now, [old], { defaults: DEFAULT_THRESHOLDS, overrides: { [key]: { liquidityChangeBps: 2500 } } });
  assert.deepEqual(hits.map((hit) => hit.reserveKey), ["other"]);
  assert.equal(DEFAULT_CONFIG.defaults.liquidityChangeBps, 2000);
});

test("notifications aggregate by Reserve, show units, cap changes and actual interval", async () => {
  const before = reserve();
  const current = reserve();
  current.borrow!.availableLiquidity = decimal(400);
  current.borrow!.apy = rate(700);
  current.supplyCap = decimal(1000);
  const now = snapshot(17, current);
  const old = [snapshot(0, before)];
  const hits = await main(now, old);
  const messages = renderNotifications(hits, now, old);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "warning");
  assert.match(messages[0].description, /17\.0 分钟/);
  assert.match(messages[0].description, /减少 20\.00%/);
  assert.match(messages[0].description, /上涨 2\.00 个百分点/);
  assert.match(messages[0].description, /Cap 10000 → 1000 USDC/);
  assert.match(messages[0].description, /Asia\/Shanghai/);
  const capOnly = renderNotifications(await main(now, []), now, []);
  assert.equal(capOnly[0].level, "info");
  assert.match(capOnly[0].description, /当前仅评估 Cap/);
  const increased = reserve();
  increased.borrow!.availableLiquidity = decimal(600);
  assert.equal(renderNotifications(await main(snapshot(15, increased), [snapshot(0)]), snapshot(15, increased), [snapshot(0)])[0].level, "info");
});
