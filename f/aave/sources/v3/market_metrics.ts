// The Bun runner initializes the checkpoint context required by workflow().
import { taskScript, workflow, step } from "windmill-client";
import type { AaveV3ChainsQuery, AaveV3MarketMetricsQuery } from "../../lib/v3-types.ts";

export type Decimal = { raw: string; decimals: number };
export type ReserveKey = string;

export interface ReserveMetrics {
  chainId: number;
  marketAddress: string;
  marketName: string;
  assetAddress: string;
  symbol: string;
  totalSupply: Decimal;
  supplyCap: Decimal;
  borrow: {
    totalBorrow: Decimal;
    availableLiquidity: Decimal;
    utilizationRate: Decimal;
    optimalUsageRate: Decimal;
    apy: Decimal;
    borrowCap: Decimal;
  } | null;
}

export interface ReserveSnapshot {
  sampledAt: string;
  reserves: Record<ReserveKey, ReserveMetrics>;
}

export function reserveKey(reserve: ReserveMetrics): ReserveKey {
  return `${reserve.chainId}/${reserve.marketAddress}/${reserve.assetAddress}`;
}

const queryChains = taskScript("f/aave/sources/v3/chains", { cache_ttl: 86400 });
const queryMetrics = taskScript("f/aave/sources/v3/market_metrics_query", { timeout: 60 });

export const main = workflow(async (api: RT.Graphql): Promise<ReserveSnapshot> => {
  const { chains }: AaveV3ChainsQuery = await queryChains({ api });
  const { markets }: AaveV3MarketMetricsQuery = await queryMetrics({
    api, chain_ids: chains.map((chain) => chain.chainId),
  });
  const sampledAt = await step("sampled_at", () => new Date().toISOString());
  const reserves: Record<ReserveKey, ReserveMetrics> = {};
  for (const market of markets) {
    for (const reserve of market.reserves) {
      const borrow = reserve.borrowInfo;
      const metrics: ReserveMetrics = {
        chainId: market.chain.chainId,
        marketAddress: market.address.toLowerCase(),
        marketName: market.name,
        assetAddress: reserve.underlyingToken.address.toLowerCase(),
        symbol: reserve.underlyingToken.symbol,
        totalSupply: reserve.supplyInfo.total,
        supplyCap: reserve.supplyInfo.supplyCap.amount,
        borrow: borrow === null ? null : {
          totalBorrow: borrow.total.amount,
          availableLiquidity: borrow.availableLiquidity.amount,
          utilizationRate: borrow.utilizationRate,
          optimalUsageRate: borrow.optimalUsageRate,
          apy: borrow.apy,
          borrowCap: borrow.borrowCap.amount,
        },
      };
      reserves[reserveKey(metrics)] = metrics;
    }
  }
  return { sampledAt, reserves };
});
