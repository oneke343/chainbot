//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  evaluateMarketRisk, type MarketRiskRules, type MarketRiskSnapshot, type MarketRiskState,
} from "../../../chain_sentinel/lib/market-risk.ts";

type Result = { markets?: { items?: Array<{
  marketId?: string; chain?: { id?: number; network?: string };
  loanAsset?: { symbol?: string }; collateralAsset?: { symbol?: string } | null;
  state?: { liquidityAssetsUsd?: number | null; utilization?: number } | null;
  badDebt?: { usd?: number | null } | null; realizedBadDebt?: { usd?: number | null } | null;
  warnings?: Array<{ type?: string; level?: string; metadata?: { deviationFactor?: number; badDebtUsd?: number | null } | null }>;
}>; pageInfo?: { count?: number; countTotal?: number; limit?: number; skip?: number } } };

export function normalizeMorphoMarketRisk(result: Result, market_ids: string[]): MarketRiskSnapshot[] {
  const page = result?.markets;
  if (!Array.isArray(page?.items) || !page.pageInfo || page.pageInfo.skip !== 0
    || page.pageInfo.count !== page.items.length || page.pageInfo.countTotal !== page.items.length
    || !market_ids.every((id) => page.items!.some((market) => market.marketId?.toLowerCase() === id.toLowerCase()))) {
    throw new Error("Morpho market result is incomplete; no state saved");
  }
  const observed_at = new Date().toISOString();
  return page.items.map((market) => {
    if (!market.marketId || !Number.isSafeInteger(market.chain?.id) || !market.loanAsset?.symbol
      || !market.collateralAsset?.symbol || !market.state || !Array.isArray(market.warnings)) {
      throw new Error("Invalid Morpho market");
    }
    const warnings = market.warnings.map((warning) => {
      if (!warning.type || !["YELLOW", "RED"].includes(warning.level ?? "")) throw new Error("Invalid Morpho warning");
      return {
        type: warning.type,
        level: warning.level === "RED" ? "critical" as const : "warning" as const,
        value: warning.metadata?.deviationFactor ?? warning.metadata?.badDebtUsd ?? undefined,
      };
    });
    const badDebt = market.badDebt?.usd ?? 0;
    return {
      id: `${market.chain!.id}:${market.marketId.toLowerCase()}`, protocol: "Morpho",
      chain_id: market.chain!.id!,
      market: `${market.chain?.network} / ${market.collateralAsset.symbol}-${market.loanAsset.symbol} / ${market.marketId}`,
      observed_at,
      liquidity_usd: market.state.liquidityAssetsUsd ?? undefined,
      utilization_percent: market.state.utilization * 100,
      bad_debt_usd: badDebt,
      warnings,
    };
  });
}

export async function main(
  inputs: Result,
  market_ids: string[],
  default_rules: MarketRiskRules = {},
  market_rules: Record<string, MarketRiskRules> = {},
): Promise<RT.MonitorOutput> {
  if (!Array.isArray(market_ids) || !market_ids.length
    || market_ids.some((id) => !/^0x[0-9a-fA-F]{64}$/.test(id))
    || new Set(market_ids.map((id) => id.toLowerCase())).size !== market_ids.length) {
    throw new Error("market_ids must contain unique Morpho market IDs");
  }
  const markets = normalizeMorphoMarketRisk(inputs, market_ids);
  const previous = await getMonitorState<Result, MarketRiskState>();
  const next = evaluateMarketRisk(markets, default_rules, market_rules, previous.states);
  await setMonitorState(inputs, next.states, next.output);
  return next.output;
}
