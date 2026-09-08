//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  assertLiquidationPageCoverage, evaluateLiquidations,
  type LiquidationEvent, type LiquidationState,
} from "../../../chain_sentinel/lib/liquidation-events.ts";

type Result = { userTransactionHistory?: { items?: Array<{
  __typename?: string; txHash?: string; timestamp?: string;
  collateral?: { reserve?: { underlyingToken?: { symbol?: string } }; amount?: { amount?: { value?: string }; usd?: string } };
  debtRepaid?: { reserve?: { underlyingToken?: { symbol?: string } }; amount?: { amount?: { value?: string }; usd?: string } };
}>; pageInfo?: { next?: string | null } } };

export function normalizeAaveV3Liquidations(
  result: Result, user: string, chain_id: number, market: string, market_name: string,
): { events: LiquidationEvent[]; has_more: boolean } {
  const page = result?.userTransactionHistory;
  if (!Array.isArray(page?.items) || !page.pageInfo) throw new Error("Missing Aave V3 liquidation page");
  const events = page.items.map((item) => {
    if (item.__typename !== "UserLiquidationCallTransaction" || !item.txHash || !item.timestamp) {
      throw new Error("Invalid Aave V3 liquidation item");
    }
    const debt = item.debtRepaid?.amount;
    const collateral = item.collateral?.amount;
    return {
      id: [chain_id, item.txHash.toLowerCase(),
        item.debtRepaid?.reserve?.underlyingToken?.symbol ?? "debt",
        item.collateral?.reserve?.underlyingToken?.symbol ?? "collateral",
        debt?.amount?.value ?? "unknown"].join(":"),
      protocol: "Aave V3", chain_id, market: market_name, user,
      transaction_hash: item.txHash, observed_at: item.timestamp,
      repaid_debt: Number(debt?.usd) > 0 ? `$${debt!.usd}`
        : `${debt?.amount?.value ?? "unknown"} ${item.debtRepaid?.reserve?.underlyingToken?.symbol ?? ""}`.trim(),
      seized_collateral: Number(collateral?.usd) > 0 ? `$${collateral!.usd}`
        : `${collateral?.amount?.value ?? "unknown"} ${item.collateral?.reserve?.underlyingToken?.symbol ?? ""}`.trim(),
    };
  });
  return { events, has_more: Boolean(page.pageInfo.next) };
}

export async function main(
  inputs: Result,
  user: string,
  chain_id: number,
  market: string,
  market_name: string,
  notify_on_first_run = false,
): Promise<RT.MonitorOutput> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(user) || !/^0x[0-9a-fA-F]{40}$/.test(market)
    || !Number.isSafeInteger(chain_id) || chain_id <= 0 || !market_name.trim()) {
    throw new Error("Invalid Aave V3 liquidation parameters");
  }
  const previous = await getMonitorState<Result, LiquidationState>();
  const normalized = normalizeAaveV3Liquidations(inputs, user, chain_id, market, market_name);
  assertLiquidationPageCoverage(normalized.events, previous.states, normalized.has_more);
  const next = evaluateLiquidations(normalized.events, previous.states, notify_on_first_run);
  await setMonitorState(inputs, next.states, next.output);
  return next.output;
}
