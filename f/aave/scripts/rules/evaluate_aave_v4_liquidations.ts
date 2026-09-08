//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  assertLiquidationPageCoverage, evaluateLiquidations,
  type LiquidationEvent, type LiquidationState,
} from "../../../chain_sentinel/lib/liquidation-events.ts";

type Result = { activities?: { items?: Array<{
  __typename?: string; id?: string; user?: string; timestamp?: string; txHash?: string;
  chain?: { chainId?: number; name?: string }; spoke?: { address?: string; name?: string };
  collateral?: { amount?: { value?: string }; token?: { info?: { symbol?: string } } };
  debt?: { amount?: { value?: string }; token?: { info?: { symbol?: string } } };
}>; pageInfo?: { next?: string | null } } };

export function normalizeAaveV4Liquidations(result: Result, user: string) {
  const page = result?.activities;
  if (!Array.isArray(page?.items) || !page.pageInfo) throw new Error("Missing Aave V4 liquidation page");
  const events: LiquidationEvent[] = page.items.map((item) => {
    if (item.__typename !== "LiquidatedActivity" || !item.id || !item.txHash || !item.timestamp
      || !Number.isSafeInteger(item.chain?.chainId) || !item.spoke?.name
      || item.user?.toLowerCase() !== user.toLowerCase()) {
      throw new Error("Invalid Aave V4 liquidation item");
    }
    return {
      id: item.id, protocol: "Aave V4", chain_id: item.chain!.chainId!,
      market: `${item.chain?.name} / ${item.spoke.name}`, user,
      transaction_hash: item.txHash, observed_at: item.timestamp,
      repaid_debt: `${item.debt?.amount?.value ?? "unknown"} ${item.debt?.token?.info?.symbol ?? ""}`.trim(),
      seized_collateral: `${item.collateral?.amount?.value ?? "unknown"} ${item.collateral?.token?.info?.symbol ?? ""}`.trim(),
    };
  });
  return { events, has_more: Boolean(page.pageInfo.next) };
}

export async function main(inputs: Result, user: string, notify_on_first_run = false): Promise<RT.MonitorOutput> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("user must be an EVM address");
  const previous = await getMonitorState<Result, LiquidationState>();
  const normalized = normalizeAaveV4Liquidations(inputs, user);
  assertLiquidationPageCoverage(normalized.events, previous.states, normalized.has_more);
  const next = evaluateLiquidations(normalized.events, previous.states, notify_on_first_run);
  await setMonitorState(inputs, next.states, next.output);
  return next.output;
}
