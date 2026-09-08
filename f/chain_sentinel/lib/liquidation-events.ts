//native

import type { RuleMessage } from "./monitor-state.ts";

export type LiquidationEvent = {
  id: string;
  protocol: string;
  chain_id: number;
  market: string;
  user: string;
  transaction_hash: string;
  log_index?: number;
  block_number?: string;
  repaid_debt?: string;
  seized_collateral?: string;
  bad_debt?: string;
  observed_at: string;
};

export type LiquidationState = {
  initialized: boolean;
  seen_ids: string[];
  last_processed_block: Record<string, string>;
};

export function assertLiquidationPageCoverage(
  events: LiquidationEvent[],
  previous: unknown,
  has_more: boolean,
): void {
  if (!has_more || !previous || typeof previous !== "object" || Array.isArray(previous)
    || (previous as Partial<LiquidationState>).initialized !== true) return;
  const seen = new Set((previous as Partial<LiquidationState>).seen_ids ?? []);
  if (events.length > 0 && !events.some((event) => seen.has(event.id))) {
    throw new Error("Liquidation result page no longer overlaps saved cursor; refusing to skip events");
  }
}

function validEvent(event: LiquidationEvent): void {
  if (!event.id || !event.protocol || !event.market
    || !Number.isSafeInteger(event.chain_id) || event.chain_id <= 0
    || !/^0x[0-9a-fA-F]{40}$/.test(event.user)
    || !/^0x[0-9a-fA-F]{64}$/.test(event.transaction_hash)
    || !Number.isFinite(Date.parse(event.observed_at))) {
    throw new Error("Invalid liquidation event");
  }
}

export function evaluateLiquidations(
  events: LiquidationEvent[],
  previous: unknown = {},
  notify_on_first_run = false,
) {
  if (!Array.isArray(events)) throw new Error("liquidation events must be an array");
  events.forEach(validEvent);
  const old = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Partial<LiquidationState> : {};
  const initialized = old.initialized === true;
  const seen = new Set(Array.isArray(old.seen_ids) ? old.seen_ids.filter((id) => typeof id === "string") : []);
  const unique = [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const new_events = unique.filter((event) => !seen.has(event.id));
  const notified_events = initialized || notify_on_first_run ? new_events : [];
  const allIds = [...seen, ...unique.map((event) => event.id)].slice(-1000);
  const lastBlocks = { ...(old.last_processed_block ?? {}) };
  for (const event of unique) {
    if (!event.block_number) continue;
    const key = String(event.chain_id);
    if (!lastBlocks[key] || BigInt(event.block_number) > BigInt(lastBlocks[key])) {
      lastBlocks[key] = event.block_number;
    }
  }
  const messages: RuleMessage[] = notified_events.map((event) => ({
    title: `${event.protocol} liquidation detected`,
    description: [
      `Account: ${event.user}`,
      `Chain: ${event.chain_id}`,
      `Market: ${event.market}`,
      `Repaid debt: ${event.repaid_debt ?? "unknown"}`,
      `Seized collateral: ${event.seized_collateral ?? "unknown"}`,
      ...(event.bad_debt ? [`Bad debt: ${event.bad_debt}`] : []),
      `Transaction: ${event.transaction_hash}`,
      `Observed: ${event.observed_at}`,
    ].join("\n"),
    fields: { ...event, finding_kind: "liquidation" },
  }));
  return {
    states: { initialized: true, seen_ids: allIds, last_processed_block: lastBlocks } satisfies LiquidationState,
    output: {
      matched: messages.length > 0,
      messages,
      fields: {
        event_count: unique.length,
        new_event_count: new_events.length,
        notified_event_count: notified_events.length,
        events: notified_events,
        last_processed_block: lastBlocks,
      },
    } satisfies RT.MonitorOutput,
  };
}
