//native

import type { RuleMessage } from "./monitor-state.ts";

export type MarketRiskSnapshot = {
  id: string;
  protocol: string;
  chain_id: number;
  market: string;
  observed_at: string;
  liquidity_usd?: number;
  utilization_percent?: number;
  supply_cap_used_percent?: number;
  borrow_cap_used_percent?: number;
  bad_debt_usd?: number;
  paused?: boolean;
  warnings?: Array<{ type: string; level: "warning" | "critical"; value?: number }>;
};

export type MarketRiskRules = {
  min_liquidity_usd?: number;
  max_utilization_percent?: number;
  max_supply_cap_used_percent?: number;
  max_borrow_cap_used_percent?: number;
  max_bad_debt_usd?: number;
  alert_oracle_warnings?: boolean;
  alert_paused?: boolean;
};

export type MarketRiskState = {
  signals: Record<string, { active: boolean; fingerprint: string }>;
};

export type MarketRiskFinding = {
  id: string;
  kind: "oracle" | "bad_debt" | "liquidity" | "utilization" | "supply_cap" | "borrow_cap" | "protocol_config";
  market_id: string;
  market: string;
  value: number | string | boolean;
  threshold?: number | string;
  level: "warning" | "critical";
  newly_triggered: boolean;
  active: boolean;
};

function threshold(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || Number(value) < 0) throw new Error(`${label} must be non-negative`);
  return Number(value);
}

function rulesFor(market: MarketRiskSnapshot, defaults: MarketRiskRules, overrides: Record<string, MarketRiskRules>) {
  const selected = overrides[market.id] ?? overrides[market.market] ?? {};
  return { ...defaults, ...selected };
}

export function evaluateMarketRisk(
  markets: MarketRiskSnapshot[],
  default_rules: MarketRiskRules = {},
  market_rules: Record<string, MarketRiskRules> = {},
  previous_states: unknown = {},
) {
  if (!Array.isArray(markets) || !market_rules || typeof market_rules !== "object" || Array.isArray(market_rules)) {
    throw new Error("Invalid market risk inputs");
  }
  const previous = previous_states && typeof previous_states === "object" && !Array.isArray(previous_states)
    && (previous_states as { signals?: unknown }).signals
    && typeof (previous_states as { signals: unknown }).signals === "object"
    ? (previous_states as MarketRiskState).signals : {};
  const signals: MarketRiskState["signals"] = {};
  const findings: MarketRiskFinding[] = [];
  const ids = new Set<string>();

  const add = (market: MarketRiskSnapshot, finding: Omit<MarketRiskFinding, "newly_triggered" | "active">, active: boolean) => {
    const fingerprint = `${finding.kind}:${finding.threshold ?? ""}`;
    const old = previous[finding.id];
    const activeBefore = old?.fingerprint === fingerprint && old.active;
    findings.push({ ...finding, active, newly_triggered: active && !activeBefore });
    signals[finding.id] = { active, fingerprint };
  };

  for (const market of markets) {
    if (!market.id || ids.has(market.id) || !market.market || !market.protocol
      || !Number.isSafeInteger(market.chain_id) || market.chain_id <= 0
      || !Number.isFinite(Date.parse(market.observed_at))) throw new Error("Invalid or duplicate market snapshot");
    ids.add(market.id);
    const rules = rulesFor(market, default_rules, market_rules);
    const minLiquidity = threshold(rules.min_liquidity_usd, "min_liquidity_usd");
    const maxUtilization = threshold(rules.max_utilization_percent, "max_utilization_percent");
    const maxSupplyCap = threshold(rules.max_supply_cap_used_percent, "max_supply_cap_used_percent");
    const maxBorrowCap = threshold(rules.max_borrow_cap_used_percent, "max_borrow_cap_used_percent");
    const maxBadDebt = threshold(rules.max_bad_debt_usd, "max_bad_debt_usd");
    const numeric = [
      ["liquidity", market.liquidity_usd, minLiquidity, (v: number, t: number) => v < t],
      ["utilization", market.utilization_percent, maxUtilization, (v: number, t: number) => v > t],
      ["supply_cap", market.supply_cap_used_percent, maxSupplyCap, (v: number, t: number) => v > t],
      ["borrow_cap", market.borrow_cap_used_percent, maxBorrowCap, (v: number, t: number) => v > t],
      ["bad_debt", market.bad_debt_usd, maxBadDebt, (v: number, t: number) => v > t],
    ] as const;
    for (const [kind, value, limit, match] of numeric) {
      if (limit === undefined) continue;
      if (value === undefined || !Number.isFinite(value)) throw new Error(`${kind} is missing for ${market.market}`);
      add(market, {
        id: `${kind}:${market.id}`, kind, market_id: market.id, market: market.market,
        value, threshold: limit, level: kind === "bad_debt" ? "critical" : "warning",
      }, match(value, limit));
    }
    if (rules.alert_paused ?? true) {
      add(market, {
        id: `protocol_config:${market.id}`, kind: "protocol_config", market_id: market.id,
        market: market.market, value: market.paused ?? false, level: "critical",
      }, market.paused === true);
    }
    if (rules.alert_oracle_warnings ?? true) {
      for (const warning of market.warnings ?? []) {
        const oracle = /oracle|price/i.test(warning.type);
        if (!oracle) continue;
        add(market, {
          id: `oracle:${warning.type}:${market.id}`, kind: "oracle", market_id: market.id,
          market: market.market, value: warning.value ?? warning.type,
          level: warning.level,
        }, true);
      }
    }
  }
  const triggered = findings.filter((finding) => finding.newly_triggered);
  const active = findings.filter((finding) => finding.active);
  const messages: RuleMessage[] = triggered.map((finding) => ({
    title: `${markets.find((market) => market.id === finding.market_id)?.protocol} market risk: ${finding.kind}`,
    description: [
      `Market: ${finding.market}`,
      `Risk: ${finding.kind}`,
      `Current value: ${finding.value}`,
      ...(finding.threshold === undefined ? [] : [`Threshold: ${finding.threshold}`]),
    ].join("\n"),
    fields: { ...finding, finding_kind: finding.kind },
  }));
  return {
    states: { signals } satisfies MarketRiskState,
    output: {
      matched: messages.length > 0,
      messages,
      fields: { markets, triggered_findings: triggered, active_findings: active, message_count: messages.length },
    } satisfies RT.MonitorOutput,
  };
}
