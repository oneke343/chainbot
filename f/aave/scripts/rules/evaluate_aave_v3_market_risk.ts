//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  evaluateMarketRisk, type MarketRiskRules, type MarketRiskSnapshot, type MarketRiskState,
} from "../../../chain_sentinel/lib/market-risk.ts";

type Amount = { amount?: { value?: string }; usd?: string };
type Result = { markets?: Array<{
  name?: string; address?: string; chain?: { chainId?: number; name?: string };
  reserves?: Array<{
    underlyingToken?: { address?: string; symbol?: string }; usdExchangeRate?: string;
    isFrozen?: boolean; isPaused?: boolean;
    supplyInfo?: { total?: { value?: string }; supplyCap?: Amount; supplyCapReached?: boolean };
    borrowInfo?: { total?: Amount; availableLiquidity?: Amount; utilizationRate?: { value?: string };
      borrowCap?: Amount; borrowCapReached?: boolean } | null;
  }>;
}> };

function number(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${label} must be non-negative`);
  return result;
}

function capPercent(totalAmount: unknown, cap: Amount | undefined): number | undefined {
  const capAmount = number(cap?.amount?.value ?? 0, "cap");
  return capAmount === 0 ? undefined : number(totalAmount, "total") / capAmount * 100;
}

export function normalizeAaveV3MarketRisk(result: Result): MarketRiskSnapshot[] {
  if (!Array.isArray(result?.markets)) throw new Error("Missing Aave V3 markets");
  const observed_at = new Date().toISOString();
  return result.markets.flatMap((market) => {
    if (!market.name || !market.address || !Number.isSafeInteger(market.chain?.chainId)
      || !Array.isArray(market.reserves)) throw new Error("Invalid Aave V3 market");
    return market.reserves.map((reserve) => {
      if (!reserve.underlyingToken?.address || !reserve.underlyingToken.symbol || !reserve.supplyInfo) {
        throw new Error(`Invalid Aave V3 reserve in ${market.name}`);
      }
      const borrow = reserve.borrowInfo;
      const oraclePrice = number(reserve.usdExchangeRate, "usdExchangeRate");
      return {
        id: `${market.chain!.chainId}:${market.address.toLowerCase()}:${reserve.underlyingToken.address.toLowerCase()}`,
        protocol: "Aave V3", chain_id: market.chain!.chainId!,
        market: `${market.chain?.name} / ${market.name} / ${reserve.underlyingToken.symbol}`,
        observed_at,
        liquidity_usd: number(borrow?.availableLiquidity?.usd ?? 0, "available liquidity"),
        utilization_percent: borrow ? number(borrow.utilizationRate?.value, "utilization") * 100 : 0,
        supply_cap_used_percent: capPercent(reserve.supplyInfo.total?.value, reserve.supplyInfo.supplyCap),
        borrow_cap_used_percent: borrow ? capPercent(borrow.total?.amount?.value, borrow.borrowCap) : undefined,
        paused: reserve.isPaused === true || reserve.isFrozen === true,
        warnings: oraclePrice === 0 ? [{ type: "oracle_price_zero", level: "critical" as const }] : [],
      };
    });
  });
}

export async function main(
  inputs: Result,
  default_rules: MarketRiskRules = {},
  market_rules: Record<string, MarketRiskRules> = {},
): Promise<RT.MonitorOutput> {
  const markets = normalizeAaveV3MarketRisk(inputs);
  const previous = await getMonitorState<Result, MarketRiskState>();
  const next = evaluateMarketRisk(markets, default_rules, market_rules, previous.states);
  await setMonitorState(inputs, next.states, next.output);
  return next.output;
}
