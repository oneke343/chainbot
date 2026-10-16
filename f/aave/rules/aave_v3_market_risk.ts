import { formatUnits } from "viem";
import { main as render } from "../../handlebars/render.ts";
import type {
  Decimal,
  ReserveKey,
  ReserveMetrics,
  ReserveSnapshot,
} from "../sources/v3/market_metrics.ts";

export interface RiskThresholds {
  liquidityChangeBps: number;
  borrowApyRiseBps: number;
  supplyDropBps: number;
  borrowGrowthBps: number;
}

export interface RiskConfig {
  defaults: RiskThresholds;
  overrides: Record<ReserveKey, Partial<RiskThresholds>>;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = {
  liquidityChangeBps: 2000,
  borrowApyRiseBps: 200,
  supplyDropBps: 1000,
  borrowGrowthBps: 1000,
};

export const DEFAULT_CONFIG: RiskConfig = {
  defaults: DEFAULT_THRESHOLDS,
  overrides: {},
};
export const WINDOW_MS = 15 * 60_000;
const BASELINE_TOLERANCE_MS = 3 * 60_000;

export type Metric =
  | "liquidity"
  | "borrow_apy"
  | "supply_total"
  | "borrow_total";

interface MetricFinding {
  metric: Metric;
  direction: "increase" | "decrease";
  before: string;
  current: string;
  // Signed relative change for balances; signed rate difference for APY (1 = 100%).
  change: string;
  thresholdBps: number;
}

export interface Finding {
  reserveKey: ReserveKey;
  marketName: string;
  assetName: string;
  currentValues: Record<string, string>;
  metrics: MetricFinding[];
}

export function findBaseline(
  current: ReserveSnapshot,
  history: ReserveSnapshot[],
): ReserveSnapshot | null {
  const target = Date.parse(current.sampledAt) - WINDOW_MS;
  const earlier = history
    .filter(
      (sample) => Date.parse(sample.sampledAt) < Date.parse(current.sampledAt),
    )
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  return (
    earlier.findLast((sample) => {
      const age = target - Date.parse(sample.sampledAt);
      return age >= 0 && age <= BASELINE_TOLERANCE_MS;
    }) ?? null
  );
}

function aligned(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const decimals = Math.max(a.decimals, b.decimals);
  return [
    BigInt(a.raw) * 10n ** BigInt(decimals - a.decimals),
    BigInt(b.raw) * 10n ** BigInt(decimals - b.decimals),
    decimals,
  ];
}

function value(decimal: Decimal): string {
  return formatUnits(BigInt(decimal.raw), decimal.decimals);
}

function currentValues(
  reserve: ReserveMetrics,
  sampledAt: string,
): Record<string, string> {
  return {
    sampled_at: sampledAt,
    token: reserve.symbol,
    supply_total: value(reserve.totalSupply),
    supply_cap: value(reserve.supplyCap),
    ...(reserve.borrow === null
      ? {}
      : {
          borrow_total: value(reserve.borrow.totalBorrow),
          liquidity: value(reserve.borrow.availableLiquidity),
          utilization: value(reserve.borrow.utilizationRate),
          optimal_usage_rate: value(reserve.borrow.optimalUsageRate),
          borrow_apy: value(reserve.borrow.apy),
          borrow_cap: value(reserve.borrow.borrowCap),
        }),
  };
}

function ratio(numerator: bigint, denominator: bigint): string {
  // Only display values are truncated; threshold comparisons use integer products.
  return formatUnits((numerator * 10n ** 18n) / denominator, 18);
}

function relativeChange(
  metric: Metric,
  before: Decimal,
  current: Decimal,
  thresholdBps: number,
  direction: "increase" | "decrease" | "both",
): MetricFinding[] {
  const [a, b] = aligned(before, current);
  if (a === 0n) return [];
  const delta = b - a;
  const magnitude = delta < 0n ? -delta : delta;
  if (delta === 0n || magnitude * 10000n < a * BigInt(thresholdBps)) return [];
  if (
    (direction === "increase" && delta < 0n) ||
    (direction === "decrease" && delta > 0n)
  )
    return [];
  return [
    {
      metric,
      direction: delta > 0n ? "increase" : "decrease",
      before: value(before),
      current: value(current),
      change: ratio(delta, a),
      thresholdBps,
    },
  ];
}

export function evaluateLiquidity(
  before: ReserveMetrics,
  current: ReserveMetrics,
  thresholds: RiskThresholds,
): MetricFinding[] {
  if (before.borrow === null || current.borrow === null) return [];
  return relativeChange(
    "liquidity",
    before.borrow.availableLiquidity,
    current.borrow.availableLiquidity,
    thresholds.liquidityChangeBps,
    "both",
  );
}

export function evaluateBorrowApy(
  before: ReserveMetrics,
  current: ReserveMetrics,
  thresholds: RiskThresholds,
): MetricFinding[] {
  if (before.borrow === null || current.borrow === null) return [];
  const [a, b, decimals] = aligned(before.borrow.apy, current.borrow.apy);
  const delta = b - a;
  if (
    delta <= 0n ||
    delta * 10000n <
      BigInt(thresholds.borrowApyRiseBps) * 10n ** BigInt(decimals)
  )
    return [];
  return [
    {
      metric: "borrow_apy",
      direction: "increase",
      before: value(before.borrow.apy),
      current: value(current.borrow.apy),
      change: formatUnits(delta, decimals),
      thresholdBps: thresholds.borrowApyRiseBps,
    },
  ];
}

export function evaluateBalances(
  before: ReserveMetrics,
  current: ReserveMetrics,
  thresholds: RiskThresholds,
): MetricFinding[] {
  const findings = relativeChange(
    "supply_total",
    before.totalSupply,
    current.totalSupply,
    thresholds.supplyDropBps,
    "decrease",
  );
  if (before.borrow !== null && current.borrow !== null) {
    findings.push(
      ...relativeChange(
        "borrow_total",
        before.borrow.totalBorrow,
        current.borrow.totalBorrow,
        thresholds.borrowGrowthBps,
        "increase",
      ),
    );
  }
  return findings;
}

export async function main(
  current: ReserveSnapshot,
  history: ReserveSnapshot[],
  config: RiskConfig = DEFAULT_CONFIG,
): Promise<Finding[]> {
  const baseline = findBaseline(current, history);
  const findings: Finding[] = [];
  for (const [key, reserve] of Object.entries(current.reserves)) {
    const thresholds = { ...config.defaults, ...config.overrides[key] };
    const hits: MetricFinding[] = [];
    const before = baseline?.reserves[key];
    if (before !== undefined) {
      hits.push(
        ...evaluateLiquidity(before, reserve, thresholds),
        ...evaluateBorrowApy(before, reserve, thresholds),
        ...evaluateBalances(before, reserve, thresholds),
      );
    }
    if (hits.length === 0) continue;
    findings.push({
      reserveKey: key,
      marketName: reserve.marketName,
      assetName: reserve.assetName,
      currentValues: currentValues(reserve, current.sampledAt),
      metrics: hits,
    });
  }
  return findings;
}

export interface Notification {
  level: "info" | "warning";
  title: string;
  description: string;
}

function formatValue(value: string, unit: "amount" | "percent" | "pp"): string {
  const number = Number(value) * (unit === "amount" ? 1 : 100);
  const maximumFractionDigits = unit === "amount" ? 4 : 2;
  const text =
    number !== 0 && Math.abs(number) < 10 ** -maximumFractionDigits
      ? number.toExponential(2)
      : new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
          number,
        );
  const suffix = unit === "amount" ? "" : unit === "percent" ? "%" : " pp";
  return text + suffix;
}

function formatFinding(finding: Finding) {
  return {
    ...finding,
    metrics: finding.metrics.map((metric) => {
      const unit = metric.metric === "borrow_apy" ? "percent" : "amount";
      return {
        ...metric,
        before: formatValue(metric.before, unit),
        current: formatValue(metric.current, unit),
        change: formatValue(
          metric.change,
          metric.metric === "borrow_apy" ? "pp" : "percent",
        ),
      };
    }),
    currentValues: Object.fromEntries(
      Object.entries(finding.currentValues).map(([key, value]) => {
        if (key === "sampled_at" || key === "token") return [key, value];
        const unit = [
          "utilization",
          "optimal_usage_rate",
          "borrow_apy",
        ].includes(key)
          ? "percent"
          : "amount";
        return [key, formatValue(value, unit)];
      }),
    ),
  };
}

export async function renderNotifications(
  findings: Finding[],
): Promise<Notification[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const marketKey = finding.reserveKey.split("/").slice(0, 2).join("/");
    const group = groups.get(marketKey) ?? [];
    group.push(finding);
    groups.set(marketKey, group);
  }
  return Promise.all(
    Array.from(groups.values(), async (hits) => {
      const warning = hits.some((finding) =>
        finding.metrics.some(
          (hit) => hit.metric !== "liquidity" || hit.direction !== "increase",
        ),
      );
      return {
        level: warning ? "warning" : "info",
        title: await render("Aave V3 {{finding.marketName}} 指标提醒", {
          finding: hits[0],
        }),
        description: await render(NOTIFICATION_TEMPLATE, {
          findings: hits.map(formatFinding),
        }),
      };
    }),
  );
}

const NOTIFICATION_TEMPLATE = `
{{#each findings}}
资产：{{assetName}}

{{#each metrics}}
- {{metric}} ({{direction}}): {{before}} → {{current}}；变化 {{change}}; 阈值 {{thresholdBps}} bps。
{{/each}}

当前指标（金额单位为 token；比率以 % 展示）
{{#each currentValues}}
{{@key}}: {{this}}
{{/each}}

{{/each}}
`;
