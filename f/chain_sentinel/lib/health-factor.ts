//native

import type { RuleMessage } from "./monitor-state.ts";

export type HealthPosition = {
  id: string;
  name: string;
  market_name: string;
  chain_id: number;
  health_factor: string | number | null;
  has_debt: boolean;
  debt_usd: string | number | null;
  collateral_usd: string | number | null;
};

export type HealthInputs = {
  user: string;
  observed_at: string;
  chains: { id: number; name: string }[];
  positions: HealthPosition[];
};

export type HealthAdapterContext = {
  user: string;
  chain_ids?: number[];
  market_names?: string[];
};

/** The protocol boundary: Sources stay raw; adapters produce this common model. */
export type HealthPositionAdapter<Source> = {
  protocol: string;
  normalize(source: Source, context: HealthAdapterContext): HealthInputs;
};

export function defineHealthPositionAdapter<Source>(
  adapter: HealthPositionAdapter<Source>,
): HealthPositionAdapter<Source> {
  if (!adapter.protocol.trim()) throw new Error("Health adapter protocol is required");
  return adapter;
}

export type PositionRiskRule = {
  id: string;
  kind: "health_factor_drop" | "debt_growth" | "liquidation_buffer";
  threshold_percent: number;
  window_minutes?: number;
  min_debt_usd?: number;
};

export type PositionMessagePolicy = {
  max_messages?: number;
  overflow?: "summary" | "truncate";
};

export type PositionRiskSnapshot = {
  observed_at: string;
  health_factor: string;
  debt_usd: string | null;
};

export type PositionHealthSignalState = {
  fingerprint: string;
  active: boolean;
  activated_at?: string;
  last_health_factor: string;
};

export type PositionHealthStates = {
  position_count: number;
  breached_count: number;
  active_risk_count: number;
  market_table: string;
  signals: Record<string, PositionHealthSignalState>;
  history: Record<string, PositionRiskSnapshot[]>;
};

export type PositionHealthFinding = {
  id: string;
  kind: "health_factor" | PositionRiskRule["kind"];
  rule_id: string;
  position_id: string;
  market: string;
  health_factor: string;
  threshold: string;
  value: string;
  window_minutes?: number;
  baseline?: string;
  newly_triggered: boolean;
  active: boolean;
};

function decimal(value: unknown, label: string): string {
  let text = String(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && text.includes("e")) {
    const [coefficient, exponent] = text.split("e");
    const [whole, fraction = ""] = coefficient.split(".");
    const digits = whole + fraction;
    const point = whole.length + Number(exponent);
    text = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
      : digits.padEnd(point, "0").slice(0, point) + (point < digits.length ? `.${digits.slice(point)}` : "");
  }
  if ((typeof value !== "string" && typeof value !== "number")
    || !/^\d+(\.\d+)?$/.test(text) || text.length > 400) {
    throw new Error(`${label} must be a non-negative plain decimal`);
  }
  return text;
}

export function compareHealthFactor(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const left = BigInt(ai + af.padEnd(scale, "0"));
  const right = BigInt(bi + bf.padEnd(scale, "0"));
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateUserAndChains(user: string, chain_ids: number[]): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("user must be an EVM address");
  if (!Array.isArray(chain_ids) || chain_ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("chain_ids must contain positive integer IDs");
  }
}

export function selectChains(chains: HealthInputs["chains"], requested: number[]) {
  if (!Array.isArray(chains) || !chains.length
    || chains.some((chain) => !Number.isSafeInteger(chain.id) || chain.id <= 0 || !chain.name)) {
    throw new Error("API returned no valid supported networks");
  }
  for (const id of requested) {
    if (!chains.some((chain) => chain.id === id)) throw new Error(`Unsupported chain: ${id}`);
  }
  return chains.filter((chain) => !requested.length || requested.includes(chain.id));
}

export function inspectHealthFactors(
  inputs: HealthInputs,
  default_threshold: number | string,
  market_thresholds: Record<string, number | string>,
) {
  const fallback = decimal(default_threshold, "default_threshold");
  if (compareHealthFactor(fallback, "0") <= 0) throw new Error("default_threshold must be positive");
  if (!market_thresholds || typeof market_thresholds !== "object" || Array.isArray(market_thresholds)) {
    throw new Error("market_thresholds must be an object");
  }
  for (const [name, value] of Object.entries(market_thresholds)) {
    if (!name.trim() || compareHealthFactor(decimal(value, `Threshold for ${name}`), "0") <= 0) {
      throw new Error(`Invalid threshold for ${name}`);
    }
  }
  if (!Array.isArray(inputs?.positions) || !Array.isArray(inputs.chains)) {
    throw new Error("Missing positions or chains from Source");
  }
  const used = new Set<string>();
  const ids = new Set<string>();
  const positions = inputs.positions.map((position) => {
    if (!position.id || !position.name || !position.market_name || ids.has(position.id)
      || typeof position.has_debt !== "boolean"
      || !inputs.chains.some((chain) => chain.id === position.chain_id)) {
      throw new Error("Invalid or duplicate position from Source");
    }
    ids.add(position.id);
    const exact = Object.hasOwn(market_thresholds, position.name);
    const named = Object.hasOwn(market_thresholds, position.market_name);
    if (named && inputs.positions.filter((p) => p.market_name === position.market_name).length > 1) {
      throw new Error(`Ambiguous market: ${position.market_name}; use the exact name including its ID`);
    }
    if (named) used.add(position.market_name);
    const key = exact ? position.name : named ? position.market_name : undefined;
    if (key) used.add(key);
    const threshold = key ? decimal(market_thresholds[key], `Threshold for ${key}`) : fallback;
    const health_factor = position.health_factor === null && !position.has_debt
      ? null : decimal(position.health_factor, `HF for ${position.name}`);
    const debt_usd = position.debt_usd === null ? null : decimal(position.debt_usd, `Debt for ${position.name}`);
    const breached = position.has_debt && health_factor !== null
      && compareHealthFactor(health_factor, threshold) < 0;
    return { ...position, health_factor, debt_usd, threshold, threshold_source: key ? "market" : "default", breached };
  }).filter((position) => position.has_debt);
  positions.sort((a, b) => Number(b.breached) - Number(a.breached)
    || compareHealthFactor(a.health_factor!, b.health_factor!) || a.id.localeCompare(b.id));
  const breached_positions = positions.filter((position) => position.breached).map((position) => position.id);
  const unused_thresholds = Object.keys(market_thresholds).filter((name) => !used.has(name));
  const cell = (value: string) => value.replace(/[|\r\n]/g, " ");
  const rows = ["| Market | HF | Threshold | From | Status |", "| --- | ---: | ---: | --- | --- |"];
  let shown = 0;
  for (const p of positions) {
    const duplicateName = positions.some((other) => other.id !== p.id && other.market_name === p.market_name);
    const label = cell(p.market_name).slice(0, 100)
      + (duplicateName ? ` (${p.id.split(":")[1].slice(0, 12)})` : "");
    const row = `| ${label} | ${Number(p.health_factor).toFixed(4)} | ${p.threshold} | ${p.threshold_source} | ${p.breached ? "BELOW" : "OK"} |`;
    if (rows.join("\n").length + row.length > 2600) break;
    rows.push(row);
    shown++;
  }
  if (shown < positions.length) rows.push(`Showing ${shown}/${positions.length}; see fields.positions for all positions.`);
  return { positions, breached_positions, unused_thresholds, market_table: rows.join("\n"), matched: breached_positions.length > 0 };
}

function stateRecord(value: unknown, key: "signals" | "history"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = (value as Record<string, unknown>)[key];
  return record && typeof record === "object" && !Array.isArray(record) ? record as Record<string, unknown> : {};
}

function validateRiskRules(rules: PositionRiskRule[]): void {
  if (!Array.isArray(rules)) throw new Error("risk_rules must be an array");
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(rule.id) || ids.has(rule.id)) throw new Error("risk_rules require unique valid IDs");
    ids.add(rule.id);
    if (!["health_factor_drop", "debt_growth", "liquidation_buffer"].includes(rule.kind)) {
      throw new Error(`Unsupported risk rule kind: ${rule.kind}`);
    }
    if (!Number.isFinite(rule.threshold_percent) || rule.threshold_percent <= 0) {
      throw new Error(`threshold_percent for ${rule.id} must be positive`);
    }
    if (rule.kind !== "liquidation_buffer"
      && (!Number.isInteger(rule.window_minutes) || rule.window_minutes! <= 0 || rule.window_minutes! > 1440)) {
      throw new Error(`window_minutes for ${rule.id} must be between 1 and 1440`);
    }
    if (rule.kind === "liquidation_buffer" && rule.window_minutes !== undefined) {
      throw new Error(`window_minutes is not used by ${rule.id}`);
    }
    if (rule.kind !== "debt_growth" && rule.threshold_percent > 100) {
      throw new Error(`threshold_percent for ${rule.id} must not exceed 100`);
    }
    if (rule.min_debt_usd !== undefined && (!Number.isFinite(rule.min_debt_usd) || rule.min_debt_usd < 0)) {
      throw new Error(`min_debt_usd for ${rule.id} must be non-negative`);
    }
  }
}

function percent(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, "");
}

function trendBaseline(history: PositionRiskSnapshot[], cutoff: number): PositionRiskSnapshot | undefined {
  return history.filter((sample) => Date.parse(sample.observed_at) <= cutoff).at(-1);
}

function transitionFinding(
  finding: Omit<PositionHealthFinding, "newly_triggered" | "active">,
  active: boolean,
  fingerprint: string,
  observedAt: string,
  old: PositionHealthSignalState | undefined,
): { finding: PositionHealthFinding; state: PositionHealthSignalState } {
  const activeBefore = old?.fingerprint === fingerprint && old.active === true;
  return {
    finding: { ...finding, newly_triggered: active && !activeBefore, active },
    state: {
      fingerprint,
      active,
      ...(active ? { activated_at: activeBefore ? old.activated_at ?? observedAt : observedAt } : {}),
      last_health_factor: finding.health_factor,
    },
  };
}

export function evaluatePositionHealth(
  inputs: HealthInputs,
  default_threshold: number | string,
  market_thresholds: Record<string, number | string> = {},
  previous_states: unknown = {},
  risk_rules: PositionRiskRule[] = [],
) {
  validateRiskRules(risk_rules);
  const observedAt = Date.parse(inputs.observed_at);
  if (!Number.isFinite(observedAt)) throw new Error("observed_at must be an ISO timestamp");
  const inspection = inspectHealthFactors(inputs, default_threshold, market_thresholds);
  const previous = stateRecord(previous_states, "signals") as Record<string, PositionHealthSignalState>;
  const oldHistory = stateRecord(previous_states, "history") as Record<string, PositionRiskSnapshot[]>;
  const signals: Record<string, PositionHealthSignalState> = {};
  const findings: PositionHealthFinding[] = [];
  const history: Record<string, PositionRiskSnapshot[]> = {};
  const maxWindow = Math.max(0, ...risk_rules.map((rule) => rule.window_minutes ?? 0));

  for (const position of inspection.positions) {
    const samples = Array.isArray(oldHistory[position.id]) ? oldHistory[position.id].filter((sample) =>
      Number.isFinite(Date.parse(sample.observed_at)) && Date.parse(sample.observed_at) < observedAt) : [];
    const current: PositionRiskSnapshot = {
      observed_at: inputs.observed_at,
      health_factor: position.health_factor!,
      debt_usd: position.debt_usd,
    };
    const byMinute = new Map<number, PositionRiskSnapshot>();
    for (const sample of [...samples, current]) byMinute.set(Math.floor(Date.parse(sample.observed_at) / 60_000), sample);
    const allSamples = [...byMinute.values()].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
    if (maxWindow > 0) {
      const retentionCutoff = observedAt - maxWindow * 60_000;
      const anchor = trendBaseline(allSamples, retentionCutoff);
      history[position.id] = allSamples.filter((sample) => Date.parse(sample.observed_at) > retentionCutoff);
      if (anchor && !history[position.id].includes(anchor)) history[position.id].unshift(anchor);
    }

    const thresholdId = `health_factor:${position.id}`;
    const thresholdTransition = transitionFinding({
      id: thresholdId, kind: "health_factor", rule_id: "health_factor_threshold",
      position_id: position.id, market: position.market_name,
      health_factor: position.health_factor!, threshold: position.threshold,
      value: position.health_factor!,
    }, position.breached, position.threshold, inputs.observed_at, previous[thresholdId]);
    signals[thresholdId] = thresholdTransition.state;
    findings.push(thresholdTransition.finding);

    for (const rule of risk_rules) {
      const id = `${rule.kind}:${rule.id}:${position.id}`;
      let value: number | undefined;
      let baseline: string | undefined;
      if (rule.kind === "liquidation_buffer") {
        const hf = Number(position.health_factor);
        if (!Number.isFinite(hf)) throw new Error(`HF for ${position.name} is too large for trend rules`);
        value = hf <= 0 ? 0 : (1 - 1 / hf) * 100;
      } else {
        const sample = trendBaseline(samples, observedAt - rule.window_minutes! * 60_000);
        if (sample) {
          const beforeValue = rule.kind === "health_factor_drop" ? sample.health_factor : sample.debt_usd;
          const nowValue = rule.kind === "health_factor_drop" ? position.health_factor : position.debt_usd;
          const before = Number(beforeValue);
          const now = Number(nowValue);
          if (beforeValue !== null && nowValue !== null && (!Number.isFinite(before) || !Number.isFinite(now))) {
            throw new Error(`Value for ${position.name} is too large for trend rules`);
          }
          if (beforeValue !== null && nowValue !== null && before > 0) {
            value = rule.kind === "health_factor_drop" ? (before - now) / before * 100 : (now - before) / before * 100;
            baseline = String(beforeValue);
          }
        }
      }
      const debtPasses = rule.min_debt_usd === undefined
        || (position.debt_usd !== null && Number(position.debt_usd) >= rule.min_debt_usd);
      const active = value !== undefined && debtPasses && (rule.kind === "liquidation_buffer"
        ? value <= rule.threshold_percent : value >= rule.threshold_percent);
      const fingerprint = `${rule.kind}:${rule.threshold_percent}:${rule.window_minutes ?? ""}:${rule.min_debt_usd ?? ""}`;
      const transition = transitionFinding({
        id, kind: rule.kind, rule_id: rule.id, position_id: position.id,
        market: position.market_name, health_factor: position.health_factor!,
        threshold: String(rule.threshold_percent), value: value === undefined ? "unavailable" : percent(value),
        ...(rule.window_minutes ? { window_minutes: rule.window_minutes } : {}),
        ...(baseline ? { baseline } : {}),
      }, active, fingerprint, inputs.observed_at, previous[id]);
      signals[id] = transition.state;
      findings.push(transition.finding);
    }
  }

  const triggered_findings = findings.filter((finding) => finding.newly_triggered);
  const active_findings = findings.filter((finding) => finding.active);
  const states: PositionHealthStates = {
    position_count: inspection.positions.length,
    breached_count: active_findings.filter((finding) => finding.kind === "health_factor").length,
    active_risk_count: active_findings.length,
    market_table: inspection.market_table,
    signals,
    history,
  };
  return { ...inspection, states, findings, triggered_findings, active_findings };
}

function findingDescription(protocol: string, user: string, observedAt: string, finding: PositionHealthFinding): string {
  const details = finding.kind === "health_factor"
    ? [`Current HF: ${Number(finding.health_factor).toFixed(4)}`, `HF threshold: ${finding.threshold}`]
    : finding.kind === "health_factor_drop"
      ? [`Current HF: ${Number(finding.health_factor).toFixed(4)}`, `HF dropped: ${finding.value}% in ${finding.window_minutes}m`, `Rule threshold: ${finding.threshold}%`]
      : finding.kind === "debt_growth"
        ? [`Current HF: ${Number(finding.health_factor).toFixed(4)}`, `Debt grew: ${finding.value}% in ${finding.window_minutes}m`, `Rule threshold: ${finding.threshold}%`]
        : [`Current HF: ${Number(finding.health_factor).toFixed(4)}`, `Estimated collateral-price buffer: ${finding.value}%`, `Rule threshold: ${finding.threshold}%`];
  return [`${protocol} account: ${user}`, `Checked: ${observedAt}`, `Market: ${finding.market}`, ...details].join("\n");
}

export function renderPositionHealthMessages(
  protocol: string,
  user: string,
  observed_at: string,
  findings: PositionHealthFinding[],
  policy: PositionMessagePolicy = {},
): RuleMessage[] {
  const max = policy.max_messages ?? 20;
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error("max_messages must be between 1 and 100");
  const overflow = policy.overflow ?? "summary";
  if (!["summary", "truncate"].includes(overflow)) throw new Error("overflow must be summary or truncate");
  const render = (finding: PositionHealthFinding): RuleMessage => ({
    title: `${protocol} position risk: ${finding.rule_id}`,
    description: findingDescription(protocol, user, observed_at, finding),
    fields: {
      finding_id: finding.id, finding_kind: finding.kind, rule_id: finding.rule_id,
      position_id: finding.position_id, market: finding.market,
      health_factor: finding.health_factor, value: finding.value, threshold: finding.threshold,
      ...(finding.window_minutes ? { window_minutes: finding.window_minutes } : {}),
      ...(finding.baseline ? { baseline: finding.baseline } : {}),
    },
  });
  if (findings.length <= max) return findings.map(render);
  if (overflow === "truncate") return findings.slice(0, max).map(render);
  const detailed = findings.slice(0, Math.max(0, max - 1)).map(render);
  const omitted = findings.slice(detailed.length);
  return [...detailed, {
    title: `${protocol} position risk summary`,
    description: [
      `${protocol} account: ${user}`, `Checked: ${observed_at}`,
      `${findings.length} new risks matched; ${omitted.length} are summarized because max_messages=${max}.`,
      ...omitted.slice(0, 20).map((finding) => `- ${finding.market}: ${finding.rule_id} (${finding.value})`),
    ].join("\n"),
    fields: {
      finding_id: `summary:${protocol.toLowerCase().replace(/\W+/g, "-")}`,
      finding_kind: "summary", total_findings: findings.length,
      omitted_findings: omitted.length, omitted_finding_ids: omitted.map((finding) => finding.id),
    },
  }];
}
