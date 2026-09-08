//native

// Plain data and functions shared by the two HF monitors, not a Resource type.
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

function decimal(value: unknown, label: string): string {
  let text = String(value);
  // JSON numbers can stringify as 1e-7; expand those without losing the API precision.
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

/** Compare the API's decimal strings without rounding them to JS floats. */
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
    const breached = position.has_debt && health_factor !== null
      && compareHealthFactor(health_factor, threshold) < 0;
    return { ...position, health_factor, threshold, threshold_source: key ? "market" : "default", breached };
  }).filter((position) => position.has_debt);
  positions.sort((a, b) => Number(b.breached) - Number(a.breached)
    || compareHealthFactor(a.health_factor!, b.health_factor!) || a.id.localeCompare(b.id));
  const breached_positions = positions.filter((position) => position.breached).map((position) => position.id);
  const unused_thresholds = Object.keys(market_thresholds).filter((name) => !used.has(name));
  const cell = (value: string) => value.replace(/[|\r\n]/g, " ");
  const rows = ["| Market | HF | Threshold | From | Status |", "| --- | ---: | ---: | --- | --- |"];
  // Bound description size; full positions and exact configuration names stay in fields.
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
  return {
    positions,
    breached_positions,
    unused_thresholds,
    market_table: rows.join("\n"),
    matched: breached_positions.length > 0,
  };
}
