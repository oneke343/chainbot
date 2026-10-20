//native

import type { Snapshot } from "../sources/account_positions.ts";

export type Config = {
  minLiquidationDistance: string;
  maxMarginRiskRatio: string;
  maxSnapshotAgeMs: number;
};

export type CheckResult = {
  key: string;
  kind: "liquidation-distance" | "margin-ratio" | "data-quality";
  status: "breach" | "clear" | "unknown";
  metric: string | null;
  threshold: string | null;
  reason: string;
};

export async function main(
  snapshot: Snapshot,
  config: Config,
  evaluatedAt: number,
): Promise<CheckResult[]> {
  const minDistance = decimal(config.minLiquidationDistance);
  const maxRatio = decimal(config.maxMarginRiskRatio);
  const prefix = `hyperliquid:${snapshot.network}:${snapshot.address}`;
  const fresh = (time: number) =>
    time <= evaluatedAt && evaluatedAt - time <= config.maxSnapshotAgeMs;
  const allDataFresh =
    fresh(snapshot.startedAt) &&
    fresh(snapshot.completedAt) &&
    snapshot.marginData.dexs.every((m) => fresh(m.stateTime)) &&
    snapshot.positions.every(
      (p) => fresh(p.stateTime) && fresh(p.marketFetchedAt),
    ) &&
    (snapshot.accountMode !== "unifiedAccount" ||
      fresh(snapshot.marginData.spotFetchedAt!));
  const results: CheckResult[] = [
    {
      key: `${prefix}:data`,
      kind: "data-quality",
      status: allDataFresh ? "clear" : "unknown",
      metric: null,
      threshold: null,
      reason: allDataFresh
        ? "Account data is current"
        : "Account data is stale or future-dated",
    },
  ];

  function add(
    key: string,
    kind: CheckResult["kind"],
    threshold: string,
    metric: Fraction | null,
    breach: boolean,
    reason: string,
    known = true,
  ) {
    results.push({
      key,
      kind,
      threshold,
      metric: metric === null ? null : format(metric),
      status: !allDataFresh || !known ? "unknown" : breach ? "breach" : "clear",
      reason: !allDataFresh ? "Account data is stale or future-dated" : reason,
    });
  }

  for (const p of snapshot.positions) {
    const key = `${prefix}:position:${p.dex}:${p.coin}:distance`;
    if (p.liquidationPrice === null) {
      add(
        key,
        "liquidation-distance",
        config.minLiquidationDistance,
        null,
        false,
        "No liquidation price estimate",
        false,
      );
      continue;
    }
    const mark = decimal(p.markPrice);
    const liquidation = decimal(p.liquidationPrice);
    const gap =
      compare(decimal(p.size), ZERO) > 0
        ? subtract(mark, liquidation)
        : subtract(liquidation, mark);
    const distance = divide(gap, mark);
    add(
      key,
      "liquidation-distance",
      config.minLiquidationDistance,
      distance,
      compare(distance, minDistance) <= 0,
      `${p.coin} ${p.marginMode}: mark=${p.markPrice}, liquidation=${p.liquidationPrice}; liquidation price is an estimate`,
    );
  }

  function pool(key: string, maintenance: Fraction, equity: Fraction) {
    if (compare(equity, ZERO) <= 0) {
      add(
        key,
        "margin-ratio",
        config.maxMarginRiskRatio,
        null,
        true,
        "Supporting equity is exhausted or nonpositive while cross exposure exists",
      );
      return;
    }
    const ratio = divide(maintenance, equity);
    add(
      key,
      "margin-ratio",
      config.maxMarginRiskRatio,
      ratio,
      compare(ratio, maxRatio) >= 0,
      `Maintenance=${format(maintenance)}, supporting equity=${format(equity)}`,
    );
  }

  if (snapshot.accountMode === "disabled") {
    for (const margin of snapshot.marginData.dexs) {
      const maintenance = decimal(margin.crossMaintenanceMarginUsed);
      const hasCross = snapshot.positions.some(
        (p) => p.dex === margin.dex && p.marginMode === "cross",
      );
      if (!hasCross && compare(maintenance, ZERO) === 0) continue;
      pool(
        `${prefix}:pool:dex:${margin.dex}:margin`,
        maintenance,
        decimal(margin.crossAccountValue),
      );
    }
  } else if (snapshot.accountMode === "unifiedAccount") {
    const tokens = new Set(
      snapshot.marginData.dexs.map((m) => m.collateralToken),
    );
    for (const token of tokens) {
      const dexs = snapshot.marginData.dexs.filter(
        (m) => m.collateralToken === token,
      );
      const names = new Set(dexs.map((m) => m.dex));
      const positions = snapshot.positions.filter((p) => names.has(p.dex));
      const maintenance = sum(
        dexs.map((m) => decimal(m.crossMaintenanceMarginUsed)),
      );
      const hasCross = positions.some((p) => p.marginMode === "cross");
      if (!hasCross && compare(maintenance, ZERO) === 0) continue;
      // The spot endpoint omits tokens with no balance; absence means zero holdings.
      const balance = snapshot.marginData.spotBalances!.find(
        (b) => b.token === token,
      );
      const equity = subtract(
        decimal(balance?.total ?? "0"),
        sum(
          positions
            .filter((p) => p.marginMode === "isolated")
            .map((p) => decimal(p.marginUsed)),
        ),
      );
      pool(`${prefix}:pool:token:${token}:margin`, maintenance, equity);
    }
  } else {
    add(
      `${prefix}:pool:account:margin`,
      "margin-ratio",
      config.maxMarginRiskRatio,
      null,
      false,
      `No verified pool-risk calculation for account mode '${snapshot.accountMode}'`,
      false,
    );
  }
  return results;
}

// Exact decimal arithmetic keeps comparisons independent of floating-point rounding.
type Fraction = { n: bigint; d: bigint };
const ZERO: Fraction = { n: 0n, d: 1n };

function decimal(value: string): Fraction {
  const [whole, fraction = ""] = value.split(".");
  return { n: BigInt(whole + fraction), d: 10n ** BigInt(fraction.length) };
}

function sum(values: Fraction[]): Fraction {
  return values.reduce(
    (a, b) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d }),
    ZERO,
  );
}

function subtract(a: Fraction, b: Fraction): Fraction {
  return { n: a.n * b.d - b.n * a.d, d: a.d * b.d };
}

function divide(a: Fraction, b: Fraction): Fraction {
  return { n: a.n * b.d, d: a.d * b.n };
}

function compare(a: Fraction, b: Fraction): number {
  const delta = a.n * b.d - b.n * a.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function format(value: Fraction): string {
  const scale = 10n ** 18n;
  const n = value.n < 0n ? -value.n : value.n;
  const scaled = (n * scale + value.d / 2n) / value.d;
  const fraction = (scaled % scale)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${value.n < 0n && scaled !== 0n ? "-" : ""}${scaled / scale}${fraction ? `.${fraction}` : ""}`;
}
