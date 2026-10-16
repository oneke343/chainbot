import type {
  ReserveMetrics,
  ReserveSnapshot,
} from "../../f/aave/sources/v3/market_metrics.ts";

export const key = "1/0xpool/0xasset";
export const decimal = (raw: string | number, decimals = 0) => ({
  raw: String(raw),
  decimals,
});
export const rate = (bps: number) => decimal(bps, 4);

export function reserve(): ReserveMetrics {
  return {
    chainId: 1,
    marketAddress: "0xpool",
    marketName: "Core",
    assetAddress: "0xasset",
    symbol: "USDC",
    totalSupply: decimal(1000),
    supplyCap: decimal(10000),
    borrow: {
      totalBorrow: decimal(500),
      availableLiquidity: decimal(500),
      utilizationRate: rate(5000),
      optimalUsageRate: rate(9000),
      apy: rate(500),
      borrowCap: decimal(10000),
    },
  };
}

export function snapshot(
  minutes: number,
  metrics = reserve(),
): ReserveSnapshot {
  return {
    sampledAt: new Date(Date.UTC(2026, 9, 16, 4, minutes)).toISOString(),
    reserves: { [key]: metrics },
  };
}

export function history(metrics = reserve()): ReserveSnapshot[] {
  return [0, 3, 6, 9, 12].map((minute) =>
    snapshot(minute, structuredClone(metrics)),
  );
}
