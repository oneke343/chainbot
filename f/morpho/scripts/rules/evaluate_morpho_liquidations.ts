//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  assertLiquidationPageCoverage, evaluateLiquidations,
  type LiquidationEvent, type LiquidationState,
} from "../../../chain_sentinel/lib/liquidation-events.ts";

type Result = { marketTransactions?: { items?: Array<{
  chain?: { id?: number; network?: string }; txHash?: string; timestamp?: string;
  blockNumber?: string; logIndex?: number; type?: string; user?: { address?: string };
  market?: { marketId?: string; loanAsset?: { symbol?: string }; collateralAsset?: { symbol?: string } | null };
  data?: { repaidAssets?: string; seizedAssets?: string; badDebtAssets?: string };
}>; pageInfo?: { count?: number; countTotal?: number; limit?: number; skip?: number } } };

export function normalizeMorphoLiquidations(result: Result, user: string) {
  const page = result?.marketTransactions;
  if (!Array.isArray(page?.items) || !page.pageInfo || page.pageInfo.skip !== 0
    || page.pageInfo.count !== page.items.length) throw new Error("Missing Morpho liquidation page");
  const events: LiquidationEvent[] = page.items.map((item) => {
    if (item.type !== "Liquidation" || !item.txHash || !item.timestamp || !item.blockNumber
      || !Number.isSafeInteger(item.logIndex) || !Number.isSafeInteger(item.chain?.id)
      || !item.market?.marketId || item.user?.address?.toLowerCase() !== user.toLowerCase()) {
      throw new Error("Invalid Morpho liquidation item");
    }
    return {
      id: `${item.chain!.id}:${item.txHash.toLowerCase()}:${item.logIndex}`,
      protocol: "Morpho", chain_id: item.chain!.id!,
      market: `${item.chain?.network} / ${item.market.collateralAsset?.symbol ?? "unknown"}-${item.market.loanAsset?.symbol ?? "unknown"} / ${item.market.marketId}`,
      user, transaction_hash: item.txHash, log_index: item.logIndex,
      block_number: item.blockNumber, observed_at: new Date(Number(item.timestamp) * 1000).toISOString(),
      repaid_debt: `${item.data?.repaidAssets ?? "unknown"} ${item.market.loanAsset?.symbol ?? ""}`.trim(),
      seized_collateral: `${item.data?.seizedAssets ?? "unknown"} ${item.market.collateralAsset?.symbol ?? ""}`.trim(),
      ...(item.data?.badDebtAssets && item.data.badDebtAssets !== "0" ? { bad_debt: item.data.badDebtAssets } : {}),
    };
  });
  return { events, has_more: Number(page.pageInfo.countTotal) > page.items.length };
}

export async function main(inputs: Result, user: string, notify_on_first_run = false): Promise<RT.MonitorOutput> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("user must be an EVM address");
  const previous = await getMonitorState<Result, LiquidationState>();
  const normalized = normalizeMorphoLiquidations(inputs, user);
  assertLiquidationPageCoverage(normalized.events, previous.states, normalized.has_more);
  const next = evaluateLiquidations(normalized.events, previous.states, notify_on_first_run);
  await setMonitorState(inputs, next.states, next.output);
  return next.output;
}
