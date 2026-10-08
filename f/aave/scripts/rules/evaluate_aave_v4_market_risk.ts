//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  evaluateMarketRisk, type MarketRiskRules, type MarketRiskSnapshot, type MarketRiskState,
} from "../../../chain_sentinel/lib/market-risk.ts";

type Amount = { amount: { onChainValue: string; decimals: number } };
type PricedAmount = Amount & { exchange: { value: string } };
type Reserve = {
  id: string;
  chain: { chainId: number; name: string };
  spoke: { id: string; name: string; address: string };
  asset: {
    hub: { id: string; name: string; address: string };
    underlying: { address: string; info: { symbol: string; decimals: number } };
  };
  summary: { supplied: PricedAmount; borrowed: PricedAmount; suppliable: Amount; borrowable: Amount };
  settings: { supplyCap: Amount; borrowCap: Amount };
  status: { paused: boolean; frozen: boolean; active: boolean };
  canSupply: boolean;
  canBorrow: boolean;
};
type Result = { reserves: Reserve[] };
type CapBaseline = { supply: string; borrow: string; decimals: number };
type State = MarketRiskState & { caps: Record<string, CapBaseline> };
type Snapshot = MarketRiskSnapshot & {
  spoke_id: string;
  spoke_address: string;
  hub_address: string;
  asset_address: string;
  symbol: string;
  decimals: number;
  supplied: string;
  borrowed: string;
  supply_cap: string;
  borrow_cap: string;
  supply_cap_remaining: string | null;
  borrow_cap_remaining: string | null;
  suppliable: string;
  borrowable: string;
  can_supply: boolean;
  can_borrow: boolean;
};

const MAX_SPOKE_CAP = (1n << 40n) - 1n;

function baselineCap(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Previous cap must be a non-negative integer string");
  }
  return BigInt(value);
}

function unlimited(cap: bigint, decimals: number): boolean {
  return cap === MAX_SPOKE_CAP * 10n ** BigInt(decimals);
}

function percent(used: bigint, cap: bigint): number {
  // Display percentages are rounded down; cap thresholds use exact integer comparisons.
  return Number(used * 100_000_000n / cap) / 1_000_000;
}

function remaining(used: bigint, cap: bigint, decimals: number): string | null {
  return unlimited(cap, decimals) ? null : (cap > used ? cap - used : 0n).toString();
}

function tokenAmount(value: string | null, decimals: number): string {
  if (value === null) return "unlimited";
  const padded = value.padStart(decimals + 1, "0");
  if (decimals === 0) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}

function capLabel(value: string, decimals: number): string {
  return tokenAmount(unlimited(BigInt(value), decimals) ? null : value, decimals);
}

export function normalizeAaveV4MarketRisk(result: Result): Snapshot[] {
  const observed_at = new Date().toISOString();
  return result.reserves.map((reserve) => {
    const { id, chain, spoke, asset, status, summary, settings } = reserve;
    const { decimals, symbol } = asset.underlying.info;
    const supplied = BigInt(summary.supplied.amount.onChainValue);
    const borrowed = BigInt(summary.borrowed.amount.onChainValue);
    const supplyCap = BigInt(settings.supplyCap.amount.onChainValue);
    const borrowCap = BigInt(settings.borrowCap.amount.onChainValue);
    const suppliedUsd = Number(summary.supplied.exchange.value);
    const borrowedUsd = Number(summary.borrowed.exchange.value);
    return {
      id, protocol: "Aave V4", chain_id: chain.chainId, observed_at,
      market: `${chain.name} / ${asset.hub.name} / ${spoke.name} / ${symbol}`,
      spoke_id: spoke.id, spoke_address: spoke.address, hub_address: asset.hub.address,
      asset_address: asset.underlying.address, symbol, decimals,
      supplied: supplied.toString(), borrowed: borrowed.toString(),
      supply_cap: supplyCap.toString(), borrow_cap: borrowCap.toString(),
      supply_cap_remaining: remaining(supplied, supplyCap, decimals), borrow_cap_remaining: remaining(borrowed, borrowCap, decimals),
      suppliable: summary.suppliable.amount.onChainValue,
      borrowable: summary.borrowable.amount.onChainValue,
      can_supply: reserve.canSupply, can_borrow: reserve.canBorrow,
      liquidity_usd: Math.max(0, suppliedUsd - borrowedUsd),
      utilization_percent: supplied === 0n ? 0 : percent(borrowed, supplied),
      supply_cap_used_percent: supplyCap === 0n || unlimited(supplyCap, decimals) ? undefined : percent(supplied, supplyCap),
      borrow_cap_used_percent: borrowCap === 0n || unlimited(borrowCap, decimals) ? undefined : percent(borrowed, borrowCap),
      paused: status.paused || status.frozen || !status.active,
    };
  });
}

function selectedIds(value: string[], label: string): Set<string> {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())
    || new Set(value).size !== value.length) throw new Error(`${label} must contain unique non-empty IDs`);
  return new Set(value);
}

function withoutCapRules(rules: MarketRiskRules): MarketRiskRules {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("Invalid market risk rules");
  const { max_supply_cap_used_percent, max_borrow_cap_used_percent, ...other } = rules;
  return other;
}

function exceedsPercent(used: bigint, cap: bigint, limit: number): boolean {
  const [coefficient, exponent = "0"] = String(limit).toLowerCase().split("e");
  const [integer, fraction = ""] = coefficient.split(".");
  const shift = Number(exponent) - fraction.length;
  const numerator = BigInt(integer + fraction) * 10n ** BigInt(Math.max(shift, 0));
  const denominator = 10n ** BigInt(Math.max(-shift, 0));
  return used * 100n * denominator > cap * numerator;
}

export function evaluateAaveV4MarketRisk(
  inputs: Result,
  default_rules: MarketRiskRules = {},
  market_rules: Record<string, MarketRiskRules> = {},
  previous: Partial<State> = {},
  spoke_ids: string[] = [],
  reserve_ids: string[] = [],
) {
  const all = normalizeAaveV4MarketRisk(inputs);
  const spokes = selectedIds(spoke_ids, "spoke_ids");
  const reserves = selectedIds(reserve_ids, "reserve_ids");
  const markets = all.filter((market) => (!spokes.size || spokes.has(market.spoke_id))
    && (!reserves.size || reserves.has(market.id)));
  for (const id of spokes) {
    if (!markets.some((market) => market.spoke_id === id)) throw new Error(`Missing selected Spoke: ${id}`);
  }
  for (const id of reserves) {
    if (!markets.some((market) => market.id === id)) throw new Error(`Missing selected reserve: ${id}`);
  }
  if (!market_rules || typeof market_rules !== "object" || Array.isArray(market_rules)) {
    throw new Error("Invalid market_rules");
  }
  const risk = evaluateMarketRisk(markets, withoutCapRules(default_rules),
    Object.fromEntries(Object.entries(market_rules).map(([id, rules]) => [id, withoutCapRules(rules)])), previous);
  if (previous.caps !== undefined && (!previous.caps || typeof previous.caps !== "object" || Array.isArray(previous.caps))) {
    throw new Error("Invalid cap baselines");
  }
  const caps = { ...previous.caps };
  const changes: Array<Record<string, unknown>> = [];

  for (const market of markets) {
    const old = caps[market.id];
    if (Object.hasOwn(caps, market.id) && (!old || typeof old !== "object" || Array.isArray(old))) {
      throw new Error(`Invalid cap baseline: ${market.id}`);
    }
    if (old && old.decimals !== market.decimals) throw new Error(`Cap baseline decimals mismatch: ${market.id}`);
    const rules = { ...default_rules, ...(market_rules[market.id] ?? market_rules[market.market] ?? {}) };
    for (const side of ["supply", "borrow"] as const) {
      const cap = market[`${side}_cap`];
      const shared = {
        market_id: market.id, market: market.market, cap_type: side, symbol: market.symbol,
        chain_id: market.chain_id, hub_address: market.hub_address, spoke_address: market.spoke_address,
        asset_address: market.asset_address, decimals: market.decimals,
      };
      if (old && baselineCap(old[side]).toString() !== cap) {
        const change = { ...shared, kind: "cap_change", old_cap: old[side], new_cap: cap };
        changes.push(change);
        risk.output.messages.push({
          title: `Aave V4 ${market.symbol} ${side} cap changed`,
          description: `Market: ${market.market}\n${side} cap: ${capLabel(old[side], market.decimals)} → ${capLabel(cap, market.decimals)} ${market.symbol}`,
          fields: { ...change, finding_kind: "cap_change" },
        });
      }
      const limit = rules[`max_${side}_cap_used_percent`];
      if (limit === undefined) continue;
      if (!Number.isFinite(limit) || limit < 0) throw new Error("Cap threshold must be non-negative and finite");
      // Zero closes new capacity; the Hub's uint40 maximum bypasses the cap check.
      const finite = BigInt(cap) !== 0n && !unlimited(BigInt(cap), market.decimals);
      const used = side === "supply" ? market.supplied : market.borrowed;
      const breached = finite && exceedsPercent(BigInt(used), BigInt(cap), limit);
      const kind: "supply_cap" | "borrow_cap" = side === "supply" ? "supply_cap" : "borrow_cap";
      const id = `${kind}:${market.id}`;
      const fingerprint = `${kind}:${limit}`;
      const oldSignal = previous.signals?.[id];
      const newly_triggered = breached && !(oldSignal?.active && oldSignal.fingerprint === fingerprint);
      risk.states.signals[id] = { active: breached, fingerprint };
      const finding = { ...shared, id, kind, value: market[`${side}_cap_used_percent`],
        threshold: limit, level: "warning" as const, active: breached, newly_triggered };
      if (breached) risk.output.fields.active_findings.push(finding);
      if (newly_triggered) {
        risk.output.fields.triggered_findings.push(finding);
        risk.output.messages.push({
          title: `Aave V4 ${market.symbol} ${side} cap usage`,
          description: `Market: ${market.market}\n${side} cap usage: ~${finding.value}%\nThreshold: ${limit}%\nUsed: ${tokenAmount(used, market.decimals)} ${market.symbol}\nCap: ${capLabel(cap, market.decimals)} ${market.symbol}\nCap remaining: ${tokenAmount(market[`${side}_cap_remaining`], market.decimals)} ${market.symbol}`,
          fields: { ...finding, finding_kind: kind },
        });
      }
    }
    caps[market.id] = { supply: market.supply_cap, borrow: market.borrow_cap, decimals: market.decimals };
  }
  return {
    states: { ...risk.states, caps } satisfies State,
    output: {
      ...risk.output, matched: risk.output.messages.length > 0,
      fields: { ...risk.output.fields, cap_changes: changes, message_count: risk.output.messages.length },
    },
  };
}

export async function main(
  inputs: Result,
  default_rules: MarketRiskRules = {},
  market_rules: Record<string, MarketRiskRules> = {},
  spoke_ids: string[] = [],
  reserve_ids: string[] = [],
): Promise<RT.MonitorOutput> {
  const previous = await getMonitorState<Result, State>();
  const next = evaluateAaveV4MarketRisk(inputs, default_rules, market_rules, previous.states, spoke_ids, reserve_ids);
  await setMonitorState(inputs, next.states, next.output);
  return next.output;
}
