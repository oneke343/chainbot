//native

import {
  getMonitorState,
  setMonitorState,
  type MonitorOutput,
} from "../../../chain_sentinel/lib/monitor-state.ts";
import { renderMessage } from "../../../chain_sentinel/lib/render-message.ts";
import {
  MAX_WINDOW_MINUTES,
  type SpotKline,
  type SpotKlinesResult,
} from "../sources/spot_klines.ts";

const ALERT_DESCRIPTION = `Binance spot pair: {{states.symbol}}

One or more price-change rules entered the alert state.

Current price: {{states.currentPrice}}
Observed at: {{states.observedAtIso}}
Newly triggered rules: {{states.newlyTriggeredRuleIds}}

{{states.ruleTable}}`;

export type PriceChangeDirection = "up" | "down" | "either";

export type PriceChangeRule = {
  id: string;
  window_minutes: number;
  direction: PriceChangeDirection;
  threshold_percent: number;
  rearm_percent?: number;
  min_quote_volume?: number;
  min_trade_count?: number;
};

export type BinancePriceInputs = {
  binance_spot_klines: SpotKlinesResult;
};

export type PriceRuleState = {
  fingerprint: string;
  active: boolean;
  activatedAt?: number;
  lastChangePercent: number;
};

export type BinancePriceStates = {
  symbol: string;
  observedAt: number;
  observedAtIso: string;
  currentPrice: string;
  newlyTriggeredRuleIds: string[];
  activeRuleIds: string[];
  ruleTable: string;
  rules: Record<string, PriceRuleState>;
};

export type PriceRuleInspection = {
  windowMinutes: number;
  direction: PriceChangeDirection;
  referencePrice: string;
  currentPrice: string;
  changePercent: number;
  thresholdPercent: number;
  rearmPercent: number;
  quoteVolume: number;
  tradeCount: number;
  priceMatched: boolean;
  filtersMatched: boolean;
  active: boolean;
  newlyTriggered: boolean;
  status: "triggered" | "active" | "normal";
};

export type BinancePriceOutput = MonitorOutput & {
  fields: {
    symbol: string;
    currentPrice: string;
    observedAt: number;
    newlyTriggeredRuleIds: string[];
    activeRuleIds: string[];
    rules: Record<string, PriceRuleInspection>;
  };
};

export type BinancePriceEvaluation = {
  states: BinancePriceStates;
  output: BinancePriceOutput;
};

type NormalizedRule = Required<PriceChangeRule>;

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function normalizeRules(rules: PriceChangeRule[]): NormalizedRule[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("rules must contain at least one price-change rule");
  }

  const ids = new Set<string>();
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== "object") throw new Error(`rules[${index}] must be an object`);
    const id = typeof rule.id === "string" ? rule.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`rules[${index}].id must contain 1-64 letters, digits, underscores, or dashes`);
    }
    if (ids.has(id)) throw new Error(`rule id is duplicated: ${id}`);
    ids.add(id);

    const windowMinutes = finiteNumber(rule.window_minutes, `rules[${index}].window_minutes`);
    if (
      !Number.isInteger(windowMinutes)
      || windowMinutes < 1
      || windowMinutes > MAX_WINDOW_MINUTES
    ) {
      throw new Error(
        `rules[${index}].window_minutes must be an integer between 1 and ${MAX_WINDOW_MINUTES}`,
      );
    }
    if (!(["up", "down", "either"] as unknown[]).includes(rule.direction)) {
      throw new Error(`rules[${index}].direction must be up, down, or either`);
    }

    const thresholdPercent = finiteNumber(
      rule.threshold_percent,
      `rules[${index}].threshold_percent`,
    );
    if (thresholdPercent <= 0) {
      throw new Error(`rules[${index}].threshold_percent must be greater than zero`);
    }
    const rearmPercent = rule.rearm_percent === undefined
      ? thresholdPercent * 0.8
      : finiteNumber(rule.rearm_percent, `rules[${index}].rearm_percent`);
    if (rearmPercent < 0 || rearmPercent >= thresholdPercent) {
      throw new Error(
        `rules[${index}].rearm_percent must be at least zero and below threshold_percent`,
      );
    }

    const minQuoteVolume = rule.min_quote_volume === undefined
      ? 0
      : finiteNumber(rule.min_quote_volume, `rules[${index}].min_quote_volume`);
    if (minQuoteVolume < 0) {
      throw new Error(`rules[${index}].min_quote_volume must not be negative`);
    }
    const minTradeCount = rule.min_trade_count === undefined
      ? 0
      : finiteNumber(rule.min_trade_count, `rules[${index}].min_trade_count`);
    if (!Number.isInteger(minTradeCount) || minTradeCount < 0) {
      throw new Error(`rules[${index}].min_trade_count must be a non-negative integer`);
    }

    return {
      id,
      window_minutes: windowMinutes,
      direction: rule.direction,
      threshold_percent: thresholdPercent,
      rearm_percent: rearmPercent,
      min_quote_volume: minQuoteVolume,
      min_trade_count: minTradeCount,
    };
  });
}

function ruleFingerprint(rule: NormalizedRule): string {
  return JSON.stringify({
    window_minutes: rule.window_minutes,
    direction: rule.direction,
    threshold_percent: rule.threshold_percent,
    rearm_percent: rule.rearm_percent,
    min_quote_volume: rule.min_quote_volume,
    min_trade_count: rule.min_trade_count,
  });
}

function isPriceMatched(
  changePercent: number,
  direction: PriceChangeDirection,
  thresholdPercent: number,
): boolean {
  if (direction === "up") return changePercent >= thresholdPercent;
  if (direction === "down") return changePercent <= -thresholdPercent;
  return Math.abs(changePercent) >= thresholdPercent;
}

function isRearmed(
  changePercent: number,
  direction: PriceChangeDirection,
  rearmPercent: number,
): boolean {
  if (direction === "up") return changePercent <= rearmPercent;
  if (direction === "down") return changePercent >= -rearmPercent;
  return Math.abs(changePercent) <= rearmPercent;
}

function previousRuleStates(value: unknown): Record<string, PriceRuleState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const rules = (value as { rules?: unknown }).rules;
  return rules && typeof rules === "object" && !Array.isArray(rules)
    ? rules as Record<string, PriceRuleState>
    : {};
}

function sumWindow(
  klines: SpotKline[],
  currentIndex: number,
  windowMinutes: number,
): { quoteVolume: number; tradeCount: number } {
  let quoteVolume = 0;
  let tradeCount = 0;
  for (const kline of klines.slice(currentIndex - windowMinutes + 1, currentIndex + 1)) {
    quoteVolume += finiteNumber(kline.quoteVolume, "kline.quoteVolume");
    tradeCount += finiteNumber(kline.tradeCount, "kline.tradeCount");
  }
  return { quoteVolume, tradeCount };
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(4)}%`;
}

function thresholdLabel(rule: NormalizedRule): string {
  if (rule.direction === "up") return `+${rule.threshold_percent}%`;
  if (rule.direction === "down") return `-${rule.threshold_percent}%`;
  return `±${rule.threshold_percent}%`;
}

function renderRuleTable(
  rules: NormalizedRule[],
  inspections: Record<string, PriceRuleInspection>,
): string {
  const header = [
    "| Rule | Window | Direction | Change | Threshold | Status |",
    "| --- | ---: | --- | ---: | ---: | --- |",
  ];
  const rows = rules.map((rule) => {
    const inspection = inspections[rule.id];
    return `| ${escapeMarkdownCell(rule.id)} | ${rule.window_minutes}m | ${rule.direction} | ${formatPercent(inspection.changePercent)} | ${thresholdLabel(rule)} | ${inspection.status.toUpperCase()} |`;
  });
  return [...header, ...rows].join("\n");
}

function validateInputs(inputs: BinancePriceInputs, maxWindow: number): SpotKlinesResult {
  const source = inputs?.binance_spot_klines;
  if (!source || typeof source !== "object") {
    throw new Error("inputs.binance_spot_klines is required");
  }
  if (!Array.isArray(source.klines) || source.klines.length < maxWindow + 1) {
    throw new Error(`at least ${maxWindow + 1} closed one-minute klines are required`);
  }
  if (!source.symbol || !Number.isFinite(source.observedAt)) {
    throw new Error("Binance source metadata is invalid");
  }
  return source;
}

export function evaluateSpotPriceChange(
  inputs: BinancePriceInputs,
  rules: PriceChangeRule[],
  previousStates: unknown = {},
): BinancePriceEvaluation {
  const normalizedRules = normalizeRules(rules);
  const maxWindow = Math.max(...normalizedRules.map((rule) => rule.window_minutes));
  const source = validateInputs(inputs, maxWindow);
  const currentIndex = source.klines.length - 1;
  const currentPrice = source.klines[currentIndex].close;
  const currentPriceNumber = finiteNumber(currentPrice, "currentPrice");
  if (currentPriceNumber <= 0) throw new Error("currentPrice must be greater than zero");

  const previous = previousRuleStates(previousStates);
  const nextRules: Record<string, PriceRuleState> = {};
  const inspections: Record<string, PriceRuleInspection> = {};
  const newlyTriggeredRuleIds: string[] = [];
  const activeRuleIds: string[] = [];

  for (const rule of normalizedRules) {
    const reference = source.klines[currentIndex - rule.window_minutes];
    const referencePrice = finiteNumber(reference.close, `${rule.id}.referencePrice`);
    if (referencePrice <= 0) throw new Error(`${rule.id}.referencePrice must be greater than zero`);
    const changePercent = (currentPriceNumber / referencePrice - 1) * 100;
    const { quoteVolume, tradeCount } = sumWindow(
      source.klines,
      currentIndex,
      rule.window_minutes,
    );
    const priceMatched = isPriceMatched(
      changePercent,
      rule.direction,
      rule.threshold_percent,
    );
    const filtersMatched = quoteVolume >= rule.min_quote_volume
      && tradeCount >= rule.min_trade_count;
    const fingerprint = ruleFingerprint(rule);
    const previousRule = previous[rule.id];
    const activeBefore = previousRule?.fingerprint === fingerprint
      && previousRule.active === true;
    const newlyTriggered = !activeBefore && priceMatched && filtersMatched;
    const active = activeBefore
      ? !isRearmed(changePercent, rule.direction, rule.rearm_percent)
      : newlyTriggered;

    if (newlyTriggered) newlyTriggeredRuleIds.push(rule.id);
    if (active) activeRuleIds.push(rule.id);
    nextRules[rule.id] = {
      fingerprint,
      active,
      ...(active
        ? { activatedAt: activeBefore ? previousRule.activatedAt ?? source.observedAt : source.observedAt }
        : {}),
      lastChangePercent: changePercent,
    };
    inspections[rule.id] = {
      windowMinutes: rule.window_minutes,
      direction: rule.direction,
      referencePrice: reference.close,
      currentPrice,
      changePercent,
      thresholdPercent: rule.threshold_percent,
      rearmPercent: rule.rearm_percent,
      quoteVolume,
      tradeCount,
      priceMatched,
      filtersMatched,
      active,
      newlyTriggered,
      status: newlyTriggered ? "triggered" : active ? "active" : "normal",
    };
  }

  const states: BinancePriceStates = {
    symbol: source.symbol,
    observedAt: source.observedAt,
    observedAtIso: new Date(source.observedAt).toISOString(),
    currentPrice,
    newlyTriggeredRuleIds,
    activeRuleIds,
    ruleTable: renderRuleTable(normalizedRules, inspections),
    rules: nextRules,
  };
  const matched = newlyTriggeredRuleIds.length > 0;
  const message = matched
    ? {
      title: `Binance ${source.symbol} price movement detected`,
      description: renderMessage(ALERT_DESCRIPTION, { inputs, states }),
    }
    : undefined;

  return {
    states,
    output: {
      matched,
      ...(message ? { message } : {}),
      fields: {
        symbol: source.symbol,
        currentPrice,
        observedAt: source.observedAt,
        newlyTriggeredRuleIds,
        activeRuleIds,
        rules: inspections,
      },
    },
  };
}

export async function main(
  inputs: BinancePriceInputs,
  rules: PriceChangeRule[],
): Promise<BinancePriceOutput> {
  const previous = await getMonitorState<
    BinancePriceInputs,
    BinancePriceStates,
    BinancePriceOutput
  >();
  const { states, output } = evaluateSpotPriceChange(inputs, rules, previous.states);
  await setMonitorState(inputs, states, output);
  return output;
}
