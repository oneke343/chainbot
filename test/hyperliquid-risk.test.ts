import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { HttpRequestError } from "@nktkas/hyperliquid";
import { main as collect } from "../f/hyperliquid/sources/account_positions.ts";
import { main as evaluate } from "../f/hyperliquid/rules/liquidation_risk.ts";

const address = "0x1111111111111111111111111111111111111111";
const now = 1_800_000_000_000;
const config = {
  minLiquidationDistance: "0.05",
  maxMarginRiskRatio: "0.8",
  maxSnapshotAgeMs: 60_000,
};

function position(coin: string, mode = "cross", size = "1", liq = "90") {
  return {
    type: "oneWay",
    position: {
      coin,
      leverage: { type: mode, value: 10, rawUsd: "0" },
      szi: size,
      entryPx: "100",
      liquidationPx: liq,
      marginUsed: "10",
      positionValue: "100",
      unrealizedPnl: "0",
    },
  };
}

function state(
  positions = [position("BTC"), position("ETH", "isolated", "-1", "103")],
) {
  return {
    assetPositions: positions,
    crossMaintenanceMarginUsed: "10",
    crossMarginSummary: { accountValue: "100" },
    time: now,
  };
}

function installApi(
  t: TestContext,
  options: {
    mode?: string;
    failDex?: boolean;
    failMarket?: boolean;
    empty?: boolean;
    balances?: (
      { token: number; total: string } | { coin: string; total: string }
    )[];
  } = {},
) {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(String(url), "https://api.hyperliquid.xyz/info");
    const body = JSON.parse(String(init.body));
    requests.push(body);
    let data: unknown;
    switch (body.type) {
      case "userAbstraction":
        data = options.mode ?? "disabled";
        break;
      case "perpDexs":
        data = [null, { name: "xyz" }];
        break;
      case "spotClearinghouseState":
        data = { balances: options.balances ?? [{ token: 0, total: "40" }] };
        break;
      case "clearinghouseState":
        if (body.dex === "xyz" && options.failDex)
          return new Response("unavailable", { status: 503 });
        data = options.empty
          ? { ...state([]), crossMaintenanceMarginUsed: "0" }
          : body.dex === "xyz"
            ? state([position("xyz:ABC", "isolated", "1", "99")])
            : state();
        break;
      case "metaAndAssetCtxs":
        if (options.failMarket)
          return new Response("unavailable", { status: 503 });
        data = [
          {
            collateralToken: 0,
            universe:
              body.dex === "xyz"
                ? [{ name: "xyz:ABC" }]
                : [{ name: "BTC" }, { name: "ETH" }],
          },
          body.dex === "xyz"
            ? [{ markPx: "100" }]
            : [{ markPx: "100" }, { markPx: "100" }],
        ];
        break;
      default:
        throw new Error(`Unexpected request ${body.type}`);
    }
    return Response.json(data);
  });
  return requests;
}

test("collects all DEXs and mixed cross/isolated positions; evaluates each position", async (t) => {
  const requests = installApi(t);
  const snapshot = await collect(address);
  assert.deepEqual(
    snapshot.marginData.dexs.map((m) => m.dex),
    ["", "xyz"],
  );
  assert.deepEqual(
    snapshot.positions.map((p) => [p.coin, p.marginMode]),
    [
      ["BTC", "cross"],
      ["ETH", "isolated"],
      ["xyz:ABC", "isolated"],
    ],
  );
  assert.ok(
    requests
      .filter((r) => r.type === "clearinghouseState")
      .every((r) => r.user === address),
  );
  const checks = await evaluate(snapshot, config, now);
  const distances = checks.filter((c) => c.kind === "liquidation-distance");
  assert.deepEqual(
    distances.map((c) => [c.metric, c.status]),
    [
      ["0.1", "clear"],
      ["0.03", "breach"],
      ["0.01", "breach"],
    ],
  );
  assert.equal(
    checks.find((c) => c.kind === "margin-ratio" && c.key.includes("dex:"))
      ?.metric,
    "0.1",
  );
});

test("DEX failure rejects collection instead of returning a partial snapshot", async (t) => {
  installApi(t, { failDex: true });
  await assert.rejects(collect(address), (error: unknown) => {
    assert.ok(error instanceof HttpRequestError);
    assert.equal(error.response?.status, 503);
    return true;
  });
});

test("null liquidation price and stale state never produce clear", async (t) => {
  installApi(t);
  const snapshot = await collect(address);
  snapshot.positions[0].liquidationPrice = null;
  let checks = await evaluate(snapshot, config, now);
  assert.equal(
    checks.find((c) => c.kind === "liquidation-distance")?.status,
    "unknown",
  );
  checks = await evaluate(snapshot, config, now + 60_001);
  assert.ok(checks.every((c) => c.status === "unknown"));
});

test("unified account aggregates collateral across DEXs and subtracts isolated margin", async (t) => {
  installApi(t, { mode: "unifiedAccount" });
  const snapshot = await collect(address);
  const checks = await evaluate(
    snapshot,
    { ...config, maxMarginRiskRatio: "0.9" },
    now,
  );
  const pools = checks.filter((c) => c.kind === "margin-ratio");
  assert.equal(pools.length, 1);
  // 10 + 10 maintenance; 40 balance minus 10 + 10 isolated allocation.
  assert.equal(pools[0].metric, "1");
  assert.equal(pools[0].status, "breach");
});

test("exhausted collateral breaches; portfolio mode is explicitly unknown", async (t) => {
  installApi(t, {
    mode: "unifiedAccount",
    balances: [{ token: 0, total: "5" }],
  });
  const snapshot = await collect(address);
  let checks = await evaluate(snapshot, config, now);
  assert.equal(checks.find((c) => c.kind === "margin-ratio")?.status, "breach");
  snapshot.accountMode = "portfolioMargin";
  checks = await evaluate(snapshot, config, now);
  assert.equal(
    checks.find((c) => c.kind === "margin-ratio")?.status,
    "unknown",
  );
});

test("outcome balances are excluded from collateral token balances", async (t) => {
  installApi(t, {
    mode: "unifiedAccount",
    balances: [
      { token: 0, total: "40" },
      { coin: "+1230", total: "1000000" },
    ],
  });
  const snapshot = await collect(address);
  assert.deepEqual(snapshot.marginData.spotBalances, [
    { token: 0, total: "40" },
  ]);
  const checks = await evaluate(snapshot, config, now);
  assert.equal(checks.find((c) => c.kind === "margin-ratio")?.metric, "1");
});

test("thresholds are inclusive and calculated without floating point boundary errors", async (t) => {
  installApi(t);
  const snapshot = await collect(address);
  snapshot.positions[0].markPrice = "0.1";
  snapshot.positions[0].liquidationPrice = "0.095";
  const checks = await evaluate(snapshot, config, now);
  assert.equal(
    checks.find((c) => c.kind === "liquidation-distance")?.status,
    "breach",
  );
  await assert.rejects(
    evaluate(snapshot, { ...config, minLiquidationDistance: "NaN" }, now),
  );
});

test("market failure rejects collection", async (t) => {
  installApi(t, { failMarket: true });
  await assert.rejects(collect(address), (error: unknown) => {
    assert.ok(error instanceof HttpRequestError);
    assert.equal(error.response?.status, 503);
    return true;
  });
});

test("a completely collected empty account has no position or pool checks", async (t) => {
  installApi(t, { empty: true });
  const snapshot = await collect(address);
  assert.equal(snapshot.positions.length, 0);
  const checks = await evaluate(snapshot, config, now);
  assert.deepEqual(
    checks.map((c) => [c.kind, c.status]),
    [["data-quality", "clear"]],
  );
});

test("freshly received stale account data remains unknown; negative distances breach", async (t) => {
  installApi(t);
  const snapshot = await collect(address);
  snapshot.positions[0].liquidationPrice = "105";
  const checks = await evaluate(snapshot, config, now);
  assert.equal(
    checks.find((c) => c.kind === "liquidation-distance")?.metric,
    "-0.05",
  );
  assert.equal(
    checks.find((c) => c.kind === "liquidation-distance")?.status,
    "breach",
  );
  for (const p of snapshot.positions) p.stateTime = now - 60_001;
  for (const m of snapshot.marginData.dexs) m.stateTime = now - 60_001;
  assert.ok(
    (await evaluate(snapshot, config, now)).every(
      (c) => c.status === "unknown",
    ),
  );
});
