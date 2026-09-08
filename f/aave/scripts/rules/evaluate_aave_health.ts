//native

import {
  setMonitorState,
  type MonitorOutput,
} from "../../../chain_sentinel/lib/monitor-state.ts";
import { renderMessage } from "../../../chain_sentinel/lib/render-message.ts";

const ALERT_TITLE = "Aave health factor below threshold";
const ALERT_DESCRIPTION = `Aave account: {{states.user}}

One or more configured markets are below their health-factor thresholds.

{{states.marketTable}}

Triggered markets: {{states.breachedMarkets}}`;

type MarketThreshold = string | number;

type AaveMarket = {
  name?: string;
  userState?: {
    healthFactor?: string | number | null;
  } | null;
};

type MarketInspection = {
  found: boolean;
  threshold: string;
  healthFactor: string | null;
  breached: boolean;
};

type AaveHealthInputs = {
  aave_market_positions: {
    markets?: AaveMarket[];
  };
};

type AaveHealthStates = {
  user: string;
  breachedMarkets: string[];
  marketTable: string;
};

type AaveHealthOutput = MonitorOutput & {
  fields: {
    user: string;
    markets: Record<string, MarketInspection>;
  };
};

export type AaveHealthRuleResult = {
  states: AaveHealthStates;
  output: AaveHealthOutput;
};

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function renderMarketTable(markets: Record<string, MarketInspection>): string {
  const header = [
    "| Market | Current HF | Threshold | Status |",
    "| --- | ---: | ---: | --- |",
  ];
  const rows = Object.entries(markets).map(([name, market]) => {
    const status = !market.found
      ? "NOT FOUND"
      : market.healthFactor === null
      ? "NO HEALTH FACTOR"
      : market.breached
      ? "BELOW THRESHOLD"
      : "HEALTHY";
    return `| ${escapeMarkdownCell(name)} | ${market.healthFactor ?? "N/A"} | ${market.threshold} | ${status} |`;
  });
  return [...header, ...rows].join("\n");
}

export function evaluateAaveHealth(
  inputs: AaveHealthInputs,
  user: string,
  market_thresholds: Record<string, MarketThreshold>,
): AaveHealthRuleResult {
  const thresholds = market_thresholds && typeof market_thresholds === "object"
    ? market_thresholds
    : {};
  const markets = Array.isArray(inputs?.aave_market_positions?.markets)
    ? inputs.aave_market_positions.markets
    : [];
  const inspected: Record<string, MarketInspection> = Object.fromEntries(
    Object.entries(thresholds).map(([name, threshold]) => [name, {
      found: false,
      threshold: String(threshold),
      healthFactor: null,
      breached: false,
    }]),
  );
  let matched = false;

  for (const market of markets) {
    const name = market.name ?? "";
    if (!Object.prototype.hasOwnProperty.call(thresholds, name)) continue;

    const threshold = Number(thresholds[name]);
    const rawHealthFactor = market.userState?.healthFactor;
    const healthFactor = Number(rawHealthFactor);
    const breached = Number.isFinite(threshold)
      && threshold > 0
      && rawHealthFactor !== null
      && rawHealthFactor !== undefined
      && Number.isFinite(healthFactor)
      && healthFactor > 0
      && healthFactor < threshold;

    inspected[name] = {
      found: true,
      threshold: String(thresholds[name]),
      healthFactor: rawHealthFactor == null ? null : String(rawHealthFactor),
      breached,
    };
    matched ||= breached;
  }

  const states: AaveHealthStates = {
    user,
    breachedMarkets: Object.entries(inspected)
      .filter(([, market]) => market.breached)
      .map(([name]) => name),
    marketTable: renderMarketTable(inspected),
  };
  const message = matched
    ? {
      title: ALERT_TITLE,
      description: renderMessage(ALERT_DESCRIPTION, { inputs, states }),
    }
    : undefined;

  return {
    states,
    output: {
      matched,
      ...(message ? { message } : {}),
      fields: { user, markets: inspected },
    },
  };
}

export async function main(
  inputs: AaveHealthInputs,
  user: string,
  market_thresholds: Record<string, MarketThreshold>,
): Promise<AaveHealthOutput> {
  const { states, output } = evaluateAaveHealth(
    inputs,
    user,
    market_thresholds,
  );
  await setMonitorState(inputs, states, output);
  return output;
}
