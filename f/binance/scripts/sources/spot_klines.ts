//native

import { main as requestJson } from "../../../chain_sentinel/scripts/sources/http_json.ts";

export const KLINE_INTERVAL_MS = 60_000;
export const MAX_WINDOW_MINUTES = 998;

export type SpotKline = {
  openTime: number;
  closeTime: number;
  close: string;
  high: string;
  low: string;
  quoteVolume: string;
  tradeCount: number;
};

export type SpotKlinesResult = {
  symbol: string;
  interval: "1m";
  observedAt: number;
  klines: SpotKline[];
};

function normalizeSymbol(symbol: string): string {
  const normalized = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{2,30}$/.test(normalized)) {
    throw new Error("symbol must contain 2-30 ASCII letters or digits");
  }
  return normalized;
}

function normalizeMaxWindow(maxWindowMinutes: number): number {
  if (
    !Number.isInteger(maxWindowMinutes)
    || maxWindowMinutes < 1
    || maxWindowMinutes > MAX_WINDOW_MINUTES
  ) {
    throw new Error(`max_window_minutes must be an integer between 1 and ${MAX_WINDOW_MINUTES}`);
  }
  return maxWindowMinutes;
}

function asFiniteNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function asPositiveDecimal(value: unknown, label: string): string {
  const number = asFiniteNumber(value, label);
  if (number <= 0) throw new Error(`${label} must be greater than zero`);
  return String(value);
}

function asNonNegativeDecimal(value: unknown, label: string): string {
  const number = asFiniteNumber(value, label);
  if (number < 0) throw new Error(`${label} must not be negative`);
  return String(value);
}

function normalizeKline(value: unknown, index: number): SpotKline {
  if (!Array.isArray(value) || value.length < 11) {
    throw new Error(`Binance kline at index ${index} must contain at least 11 fields`);
  }

  const openTime = asFiniteNumber(value[0], `kline[${index}].openTime`);
  const closeTime = asFiniteNumber(value[6], `kline[${index}].closeTime`);
  const tradeCount = asFiniteNumber(value[8], `kline[${index}].tradeCount`);
  if (!Number.isInteger(openTime) || !Number.isInteger(closeTime)) {
    throw new Error(`Binance kline at index ${index} has an invalid timestamp`);
  }
  if (!Number.isInteger(tradeCount) || tradeCount < 0) {
    throw new Error(`kline[${index}].tradeCount must be a non-negative integer`);
  }

  return {
    openTime,
    closeTime,
    close: asPositiveDecimal(value[4], `kline[${index}].close`),
    high: asPositiveDecimal(value[2], `kline[${index}].high`),
    low: asPositiveDecimal(value[3], `kline[${index}].low`),
    quoteVolume: asNonNegativeDecimal(value[7], `kline[${index}].quoteVolume`),
    tradeCount,
  };
}

export function normalizeSpotKlines(
  value: unknown,
  symbol: string,
  maxWindowMinutes: number,
  nowMs: number,
): SpotKlinesResult {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedMaxWindow = normalizeMaxWindow(maxWindowMinutes);
  if (!Array.isArray(value)) throw new Error("Binance klines response must be an array");
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("nowMs must be a valid timestamp");

  const closed = value
    .map(normalizeKline)
    .filter((kline) => kline.closeTime < nowMs)
    .sort((left, right) => left.openTime - right.openTime);
  const requiredCount = normalizedMaxWindow + 1;
  if (closed.length < requiredCount) {
    throw new Error(
      `Binance returned ${closed.length} closed klines; ${requiredCount} are required`,
    );
  }

  const klines = closed.slice(-requiredCount);
  for (let index = 1; index < klines.length; index += 1) {
    if (klines[index].openTime - klines[index - 1].openTime !== KLINE_INTERVAL_MS) {
      throw new Error("Binance returned a gap in the one-minute kline series");
    }
  }

  const latest = klines[klines.length - 1];
  if (nowMs - latest.closeTime > KLINE_INTERVAL_MS * 2 + 5_000) {
    throw new Error("Latest closed Binance kline is stale");
  }

  return {
    symbol: normalizedSymbol,
    interval: "1m",
    observedAt: latest.closeTime,
    klines,
  };
}

export async function main(
  connection: RT.HttpConnection,
  symbol: string,
  max_window_minutes: number,
): Promise<SpotKlinesResult> {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedMaxWindow = normalizeMaxWindow(max_window_minutes);
  const nowMs = Date.now();
  const response = await requestJson(
    connection,
    "api/v3/klines",
    "GET",
    {
      symbol: normalizedSymbol,
      interval: "1m",
      limit: normalizedMaxWindow + 2,
    },
  );
  return normalizeSpotKlines(response, normalizedSymbol, normalizedMaxWindow, nowMs);
}
