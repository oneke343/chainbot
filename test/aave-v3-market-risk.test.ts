import assert from "node:assert/strict";
import test from "node:test";
import {
  main,
  findBaseline,
  renderNotifications,
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  evaluateLiquidity,
  evaluateBorrowApy,
  evaluateBalances,
  type Finding,
} from "../f/aave/rules/aave_v3_market_risk.ts";
import {
  key,
  decimal,
  rate,
  reserve,
  snapshot,
  history,
} from "./fixtures/aave-v3-reserves.ts";

const values: Finding["currentValues"] = {
  sampled_at: "2026-10-16T04:15:00.000Z",
  token: "USDC",
  supply_total: "900",
  supply_cap: "10000",
  borrow_total: "550",
  liquidity: "400",
  utilization: "0.61",
  optimal_usage_rate: "0.9",
  borrow_apy: "0.07",
  borrow_cap: "10000",
};

test("liquidity is bidirectional, percentage-only and inclusive at the threshold", () => {
  const before = reserve();
  before.borrow!.availableLiquidity = decimal(100, 6);
  const current = structuredClone(before);
  current.borrow!.availableLiquidity = decimal(80, 6);
  assert.equal(
    evaluateLiquidity(before, current, DEFAULT_THRESHOLDS)[0].change,
    "-0.2",
  );
  current.borrow!.availableLiquidity = decimal(120, 6);
  assert.equal(
    evaluateLiquidity(before, current, DEFAULT_THRESHOLDS)[0].direction,
    "increase",
  );
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
  assert.equal(
    evaluateBalances(before, current, DEFAULT_THRESHOLDS)[0].change,
    "-0.1",
  );
});

test("only supply decreases and borrow increases alert, without an amount floor", () => {
  const before = reserve();
  before.totalSupply = decimal(10, 6);
  before.borrow!.totalBorrow = decimal(10, 6);
  const current = structuredClone(before);
  current.totalSupply = decimal(9, 6);
  current.borrow!.totalBorrow = decimal(11, 6);
  assert.deepEqual(
    evaluateBalances(before, current, DEFAULT_THRESHOLDS).map(
      (hit) => hit.metric,
    ),
    ["supply_total", "borrow_total"],
  );
  current.totalSupply = decimal(11, 6);
  current.borrow!.totalBorrow = decimal(9, 6);
  assert.deepEqual(evaluateBalances(before, current, DEFAULT_THRESHOLDS), []);
});

test("APY compares percentage points, only fast rises and not a high current rate", () => {
  const before = reserve();
  const current = reserve();
  current.borrow!.apy = decimal("7000000", 8);
  assert.equal(
    evaluateBorrowApy(before, current, DEFAULT_THRESHOLDS)[0].change,
    "0.02",
  );
  current.borrow!.apy = rate(699);
  assert.deepEqual(evaluateBorrowApy(before, current, DEFAULT_THRESHOLDS), []);
  before.borrow!.apy = rate(3000);
  current.borrow!.apy = rate(3000);
  assert.deepEqual(evaluateBorrowApy(before, current, DEFAULT_THRESHOLDS), []);
  current.borrow!.apy = rate(1000);
  assert.deepEqual(evaluateBorrowApy(before, current, DEFAULT_THRESHOLDS), []);
});

test("near-full and exceeded caps do not alert; balance changes still do", async () => {
  const current = reserve();
  for (const [supplyCap, borrowCap] of [
    [1050, 525],
    [1000, 500],
    [900, 400],
    [0, 0],
  ]) {
    current.supplyCap = decimal(supplyCap);
    current.borrow!.borrowCap = decimal(borrowCap);
    assert.deepEqual(await main(snapshot(15, current), history()), []);
    assert.deepEqual(await main(snapshot(15, current), []), []);
  }
  current.supplyCap = decimal(900);
  current.borrow!.borrowCap = decimal(400);
  current.borrow!.totalBorrow = decimal(550);
  assert.deepEqual(
    (await main(snapshot(15, current), history()))[0].metrics.map(
      (hit) => hit.metric,
    ),
    ["borrow_total"],
  );
});

test("baseline chooses a timestamp at or before the target, excludes current/future and sorts history", () => {
  const current = snapshot(18);
  const baseline = findBaseline(current, [
    snapshot(19),
    snapshot(18),
    snapshot(4),
    snapshot(1),
    snapshot(7),
    snapshot(10),
    snapshot(13),
    snapshot(16),
  ]);
  assert.equal(baseline?.sampledAt, snapshot(1).sampledAt);
  assert.equal(findBaseline(current, [snapshot(-1), snapshot(4)]), null);
  assert.equal(
    findBaseline(current, [snapshot(0)])?.sampledAt,
    snapshot(0).sampledAt,
  );
});

test("persistently high utilization stays quiet while other risk metrics still alert", async () => {
  const high = reserve();
  high.borrow!.utilizationRate = rate(10000);
  const samples = history(high);
  for (const minute of [15, 18, 21]) {
    const current = snapshot(minute, structuredClone(high));
    assert.deepEqual(await main(current, samples), []);
    samples.push(current);
  }
  const changed = structuredClone(high);
  changed.borrow!.availableLiquidity = decimal(400);
  changed.borrow!.apy = rate(700);
  changed.totalSupply = decimal(900);
  changed.borrow!.totalBorrow = decimal(550);
  const findings = await main(snapshot(24, changed), samples);
  assert.equal(findings.length, 1);
  assert.deepEqual(
    findings[0].metrics.map((hit) => hit.metric),
    ["liquidity", "borrow_apy", "supply_total", "borrow_total"],
  );
  assert.equal(JSON.stringify(findings).match(/"currentValues":/g)?.length, 1);
});

test("endpoint changes still evaluate across sampling gaps", async () => {
  const before = reserve();
  before.borrow!.utilizationRate = rate(9200);
  const current = structuredClone(before);
  current.borrow!.availableLiquidity = decimal(400);
  assert.deepEqual(
    (await main(snapshot(15, current), [snapshot(0, before)]))[0].metrics.map(
      (hit) => hit.metric,
    ),
    ["liquidity"],
  );
});

test("first sample is quiet; supply-only reserves and zero baselines remain meaningful", async () => {
  const supplyOnly = reserve();
  supplyOnly.borrow = null;
  supplyOnly.supplyCap = decimal(1000);
  assert.deepEqual(await main(snapshot(15, supplyOnly), []), []);
  const before = reserve();
  before.totalSupply = decimal(0);
  before.borrow!.totalBorrow = decimal(0);
  before.borrow!.availableLiquidity = decimal(0);
  assert.deepEqual(await main(snapshot(15), [snapshot(0, before)]), []);
  const current = structuredClone(supplyOnly);
  current.totalSupply = decimal(800);
  assert.deepEqual(
    (
      await main(snapshot(15, current), [snapshot(0, supplyOnly)])
    )[0].metrics.map((hit) => hit.metric),
    ["supply_total"],
  );
});

test("Reserve overrides affect only that Reserve and leave defaults unchanged", async () => {
  const current = reserve();
  current.borrow!.availableLiquidity = decimal(400);
  const now = snapshot(15, current);
  now.reserves.other = structuredClone(current);
  const old = snapshot(0);
  old.reserves.other = reserve();
  const hits = await main(now, [old], {
    defaults: DEFAULT_THRESHOLDS,
    overrides: { [key]: { liquidityChangeBps: 2500 } },
  });
  assert.deepEqual(
    hits.map((hit) => hit.reserveKey),
    ["other"],
  );
  assert.equal(DEFAULT_CONFIG.defaults.liquidityChangeBps, 2000);
});

test("notifications consume only findings and preserve values, units and severity", async () => {
  const before = reserve();
  const current = reserve();
  current.borrow!.availableLiquidity = decimal(400);
  current.borrow!.apy = rate(700);
  const now = snapshot(17, current);
  const old = [snapshot(0, before)];
  const hits = await main(now, old);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].metrics.length, 2);
  const messages = await renderNotifications(hits);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "warning");
  assert.match(messages[0].description, /资产：USD Coin/);
  assert.equal(messages[0].title, "Aave V3 Core 指标提醒");
  assert.ok(!messages[0].description.includes(key));
  assert.match(
    messages[0].description,
    /liquidity \(decrease\): 500 → 400；变化 -20%; 阈值 2000 bps/,
  );
  assert.match(
    messages[0].description,
    /borrow_apy \(increase\): 5% → 7%；变化 2 pp; 阈值 200 bps/,
  );
  assert.match(
    messages[0].description,
    /当前指标（金额单位为 token；比率以 % 展示）/,
  );
  assert.match(messages[0].description, /supply_total: 1,000/);
  assert.match(messages[0].description, /borrow_total: 500/);
  assert.match(messages[0].description, /liquidity: 400/);
  assert.match(messages[0].description, /borrow_apy: 7%/);
  assert.match(messages[0].description, /utilization: 50%/);
  assert.match(messages[0].description, /optimal_usage_rate: 90%/);
  assert.match(messages[0].description, /supply_cap: 10,000/);
  assert.match(messages[0].description, /borrow_cap: 10,000/);
  assert.match(
    messages[0].description,
    /sampled_at: 2026-10-16T04:17:00\.000Z/,
  );
  assert.equal(messages[0].description.match(/当前指标/g)?.length, 1);
  const increased = reserve();
  increased.borrow!.availableLiquidity = decimal(600);
  assert.equal(
    (
      await renderNotifications(
        await main(snapshot(15, increased), [snapshot(0)]),
      )
    )[0].level,
    "info",
  );
});

test("supply-only alerts carry precise current values without borrow metrics", async () => {
  const before = reserve();
  before.borrow = null;
  before.totalSupply = decimal("1000000000000000001000", 18);
  before.supplyCap = decimal("2000000000000000000000", 18);
  const current = structuredClone(before);
  current.totalSupply = decimal("900000000000000000900", 18);
  const findings = await main(snapshot(15, current), [snapshot(0, before)]);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].currentValues, {
    sampled_at: "2026-10-16T04:15:00.000Z",
    token: "USDC",
    supply_total: "900.0000000000000009",
    supply_cap: "2000",
  });
  const [message] = await renderNotifications(findings);
  assert.match(message.description, /supply_total: 900\n/);
  assert.match(message.description, /supply_cap: 2,000/);
  assert.doesNotMatch(
    message.description,
    /borrow_|liquidity|utilization|optimal_usage_rate|undefined/,
  );
});

test("notifications round long decimals while findings retain their original values", async () => {
  const before = reserve();
  before.borrow!.availableLiquidity = decimal("1000000123456789", 9);
  const current = structuredClone(before);
  current.borrow!.availableLiquidity = decimal("800000098765431", 9);
  current.borrow!.apy = decimal("7006912", 8);
  current.borrow!.utilizationRate = decimal("9123456789", 10);
  const findings = await main(snapshot(15, current), [snapshot(0, before)]);
  const original = structuredClone(findings);
  const [message] = await renderNotifications(findings);
  assert.match(
    message.description,
    /1,000,000\.1235 → 800,000\.0988；变化 -20%/,
  );
  assert.match(
    message.description,
    /borrow_apy \(increase\): 5% → 7\.01%；变化 2\.01 pp/,
  );
  assert.match(message.description, /liquidity: 800,000\.0988/);
  assert.match(message.description, /utilization: 91\.23%/);
  assert.match(message.description, /borrow_apy: 7\.01%/);
  assert.deepEqual(findings, original);
  assert.equal(findings[0].currentValues.liquidity, "800000.098765431");
});

test("Handlebars renders standalone findings and groups reserves without changing their contents", async () => {
  const names = {
    marketName: "Core <risk>",
    assetName: "USD Coin & token",
    currentValues: values,
  };
  const findings: Finding[] = [
    {
      ...names,
      reserveKey: key,
      metrics: [
        {
          metric: "liquidity",
          direction: "decrease",
          before: "500",
          current: "400",
          change: "-0.2",
          thresholdBps: 2000,
        },
        {
          metric: "borrow_apy",
          direction: "increase",
          before: "0.05",
          current: "0.07",
          change: "0.02",
          thresholdBps: 200,
        },
        {
          metric: "supply_total",
          direction: "decrease",
          before: "1000",
          current: "900",
          change: "-0.1",
          thresholdBps: 1000,
        },
        {
          metric: "borrow_total",
          direction: "increase",
          before: "500",
          current: "550",
          change: "0.1",
          thresholdBps: 1000,
        },
      ],
    },
    {
      ...names,
      reserveKey: "8453/<pool>&/asset",
      metrics: [
        {
          metric: "liquidity",
          direction: "increase",
          before: "500",
          current: "600",
          change: "0.2",
          thresholdBps: 2000,
        },
      ],
    },
  ];
  const before = structuredClone(findings);
  const messages = await renderNotifications(findings);
  assert.equal(messages.length, 2);
  const [message, other] = messages;
  assert.equal(message.title, "Aave V3 Core <risk> 指标提醒");
  assert.equal(message.level, "warning");
  assert.equal(other.level, "info");
  assert.match(other.description, /资产：USD Coin & token/);
  assert.ok(!other.description.includes("8453/<pool>&/asset"));
  assert.doesNotMatch(
    other.description,
    /^- (borrow_apy|supply_total|borrow_total)/m,
  );
  assert.equal(
    message.description.split("\n").filter((line) => line.startsWith("- "))
      .length,
    4,
  );
  for (const line of [
    "- liquidity (decrease): 500 → 400；变化 -20%; 阈值 2000 bps。",
    "- borrow_apy (increase): 5% → 7%；变化 2 pp; 阈值 200 bps。",
    "- supply_total (decrease): 1,000 → 900；变化 -10%; 阈值 1000 bps。",
    "- borrow_total (increase): 500 → 550；变化 10%; 阈值 1000 bps。",
  ])
    assert.ok(message.description.includes(line), line);
  assert.doesNotMatch(message.description, /&amp;|&lt;|undefined/);
  assert.match(message.description, /\n\n- liquidity/);
  assert.deepEqual(findings, before);
  assert.deepEqual(await renderNotifications([]), []);
});

test("notifications group assets by chain and market, with the highest severity per market", async () => {
  const liquidity: Finding = {
    reserveKey: key,
    marketName: "Core",
    assetName: "USD Coin",
    currentValues: { ...values, liquidity: "600" },
    metrics: [
      {
        metric: "liquidity",
        direction: "increase",
        before: "500",
        current: "600",
        change: "0.2",
        thresholdBps: 2000,
      },
    ],
  };
  const findings: Finding[] = [
    {
      ...liquidity,
      metrics: [
        ...liquidity.metrics,
        {
          metric: "borrow_total",
          direction: "increase",
          before: "500",
          current: "550",
          change: "0.1",
          thresholdBps: 1000,
        },
      ],
    },
    {
      ...liquidity,
      reserveKey: "1/0xpool/0xweth",
      assetName: "Wrapped Ether",
      currentValues: { ...values, token: "WETH", liquidity: "400" },
      metrics: [
        {
          metric: "liquidity",
          direction: "decrease",
          before: "500",
          current: "400",
          change: "-0.2",
          thresholdBps: 2000,
        },
      ],
    },
    { ...liquidity, reserveKey: "8453/0xpool/0xasset" },
    { ...liquidity, reserveKey: "1/0xotherpool/0xasset" },
  ];
  const before = structuredClone(findings);
  const messages = await renderNotifications(findings);
  assert.equal(messages.length, 3);
  assert.deepEqual(
    messages.map((message) => message.level),
    ["warning", "info", "info"],
  );
  assert.equal(messages[0].title, "Aave V3 Core 指标提醒");
  assert.match(
    messages[0].description,
    /资产：USD Coin\n\n- liquidity[^]*- borrow_total[^]*资产：Wrapped Ether\n\n- liquidity \(decrease\)/,
  );
  assert.equal(messages[0].description.match(/资产：USD Coin/g)?.length, 1);
  assert.equal(messages[0].description.match(/当前指标/g)?.length, 2);
  assert.match(
    messages[0].description,
    /token: USDC[^]*liquidity: 600[^]*资产：Wrapped Ether[^]*token: WETH[^]*liquidity: 400/,
  );
  assert.doesNotMatch(messages[0].description, /市场：Core/);
  for (const message of messages.slice(1)) {
    assert.doesNotMatch(message.description, /Wrapped Ether|^- borrow_total/m);
    assert.match(message.description, /资产：USD Coin/);
  }
  assert.deepEqual(findings, before);
});
