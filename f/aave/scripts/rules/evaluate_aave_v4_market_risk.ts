//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  evaluateMarketRisk, type MarketRiskRules, type MarketRiskSnapshot, type MarketRiskState,
} from "../../../chain_sentinel/lib/market-risk.ts";

type Result = { spokes?: Array<{
  id?: string; name?: string; address?: string; chain?: { chainId?: number; name?: string };
  summary?: { totalBorrowed?: { value?: string }; totalBorrowCap?: { value?: string };
    totalSupplied?: { value?: string }; totalSupplyCap?: { value?: string } };
}> };

function number(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${label} must be non-negative`);
  return result;
}

function capPercent(used: number, cap: number): number | undefined {
  return cap === 0 ? undefined : used / cap * 100;
}

export function normalizeAaveV4MarketRisk(result: Result): MarketRiskSnapshot[] {
  if (!Array.isArray(result?.spokes)) throw new Error("Missing Aave V4 Spokes");
  const observed_at = new Date().toISOString();
  return result.spokes.map((spoke) => {
    if (!spoke.id || !spoke.name || !spoke.address || !Number.isSafeInteger(spoke.chain?.chainId)
      || !spoke.summary) throw new Error("Invalid Aave V4 Spoke");
    const supplied = number(spoke.summary.totalSupplied?.value, "total supplied");
    const borrowed = number(spoke.summary.totalBorrowed?.value, "total borrowed");
    const supplyCap = number(spoke.summary.totalSupplyCap?.value, "total supply cap");
    const borrowCap = number(spoke.summary.totalBorrowCap?.value, "total borrow cap");
    return {
      id: spoke.id, protocol: "Aave V4", chain_id: spoke.chain!.chainId!,
      market: `${spoke.chain?.name} / ${spoke.name}`, observed_at,
      liquidity_usd: Math.max(0, supplied - borrowed),
      utilization_percent: supplied === 0 ? 0 : borrowed / supplied * 100,
      supply_cap_used_percent: capPercent(supplied, supplyCap),
      borrow_cap_used_percent: capPercent(borrowed, borrowCap),
    };
  });
}

export async function main(
  inputs: Result,
  default_rules: MarketRiskRules = {},
  market_rules: Record<string, MarketRiskRules> = {},
): Promise<RT.MonitorOutput> {
  const markets = normalizeAaveV4MarketRisk(inputs);
  const previous = await getMonitorState<Result, MarketRiskState>();
  const next = evaluateMarketRisk(markets, default_rules, market_rules, previous.states);
  await setMonitorState(inputs, next.states, next.output);
  return next.output;
}
