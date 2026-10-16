import { formatUnits } from "viem";
import type {
  Decimal,
  ReserveKey,
  ReserveMetrics,
  ReserveSnapshot,
} from "../sources/v3/market_metrics.ts";

export interface RiskThresholds {
  liquidityChangeBps: number;
  utilizationBufferBps: number;
  borrowApyRiseBps: number;
  supplyDropBps: number;
  borrowGrowthBps: number;
  capUsageBps: number;
}

export interface RiskConfig {
  defaults: RiskThresholds;
  overrides: Record<ReserveKey, Partial<RiskThresholds>>;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = {
  liquidityChangeBps: 2000,
  utilizationBufferBps: 200,
  borrowApyRiseBps: 200,
  supplyDropBps: 1000,
  borrowGrowthBps: 1000,
  capUsageBps: 9500,
};

export const DEFAULT_CONFIG: RiskConfig = {
  defaults: DEFAULT_THRESHOLDS,
  overrides: {},
};
export const WINDOW_MS = 15 * 60_000;
const BASELINE_TOLERANCE_MS = 3 * 60_000;
const MAX_SAMPLE_GAP_MS = 6 * 60_000;

export type Metric =
  | "liquidity"
  | "utilization"
  | "borrow_apy"
  | "supply_total"
  | "borrow_total"
  | "supply_cap_usage"
  | "borrow_cap_usage";

interface MetricFinding {
  metric: Metric;
  direction: "increase" | "decrease" | "above";
  before?: string;
  current: string;
  // Signed relative change for balances; signed rate difference for APY (1 = 100%).
  change?: string;
  thresholdBps: number;
}

export interface Finding extends MetricFinding {
  reserveKey: ReserveKey;
}

export interface ReserveWindow {
  current: ReserveSnapshot;
  baseline: ReserveSnapshot | null;
  samples: ReserveSnapshot[];
  continuous: boolean;
}

export interface ReserveSample {
  sampledAt: string;
  metrics: ReserveMetrics;
}

export function buildWindow(
  current: ReserveSnapshot,
  history: ReserveSnapshot[],
): ReserveWindow {
  const target = Date.parse(current.sampledAt) - WINDOW_MS;
  const earlier = history
    .filter(
      (sample) => Date.parse(sample.sampledAt) < Date.parse(current.sampledAt),
    )
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  const baseline =
    earlier.findLast((sample) => {
      const age = target - Date.parse(sample.sampledAt);
      return age >= 0 && age <= BASELINE_TOLERANCE_MS;
    }) ?? null;
  const samples =
    baseline === null
      ? [current]
      : [
          ...earlier.filter(
            (sample) =>
              Date.parse(sample.sampledAt) >= Date.parse(baseline.sampledAt),
          ),
          current,
        ];
  const continuous =
    baseline !== null &&
    samples.every(
      (sample, index) =>
        index === 0 ||
        Date.parse(sample.sampledAt) -
          Date.parse(samples[index - 1].sampledAt) <=
          MAX_SAMPLE_GAP_MS,
    );
  return { current, baseline, samples, continuous };
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

export function evaluateUtilization(
  samples: ReserveSample[],
  thresholds: RiskThresholds,
): MetricFinding[] {
  for (const { metrics } of samples) {
    if (metrics.borrow === null) return [];
    const [usage, kink, decimals] = aligned(
      metrics.borrow.utilizationRate,
      metrics.borrow.optimalUsageRate,
    );
    if (
      (usage - kink) * 10000n <
      BigInt(thresholds.utilizationBufferBps) * 10n ** BigInt(decimals)
    )
      return [];
  }
  const current = samples[samples.length - 1].metrics.borrow!;
  return [
    {
      metric: "utilization",
      direction: "above",
      current: value(current.utilizationRate),
      thresholdBps: thresholds.utilizationBufferBps,
    },
  ];
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

export function evaluateCaps(
  current: ReserveMetrics,
  thresholds: RiskThresholds,
): MetricFinding[] {
  const caps: [Metric, Decimal, Decimal][] = [
    ["supply_cap_usage", current.totalSupply, current.supplyCap],
  ];
  if (current.borrow !== null)
    caps.push([
      "borrow_cap_usage",
      current.borrow.totalBorrow,
      current.borrow.borrowCap,
    ]);
  return caps.flatMap(([metric, total, cap]): MetricFinding[] => {
    const [used, limit] = aligned(total, cap);
    if (limit === 0n || used * 10000n < limit * BigInt(thresholds.capUsageBps))
      return [];
    return [
      {
        metric,
        direction: "above",
        current: ratio(used, limit),
        thresholdBps: thresholds.capUsageBps,
      },
    ];
  });
}

export async function main(
  current: ReserveSnapshot,
  history: ReserveSnapshot[],
  config: RiskConfig = DEFAULT_CONFIG,
): Promise<Finding[]> {
  const window = buildWindow(current, history);
  const findings: Finding[] = [];
  for (const [key, reserve] of Object.entries(current.reserves)) {
    const thresholds = { ...config.defaults, ...config.overrides[key] };
    const hits = evaluateCaps(reserve, thresholds);
    const before = window.baseline?.reserves[key];
    if (before !== undefined) {
      hits.push(
        ...evaluateLiquidity(before, reserve, thresholds),
        ...evaluateBorrowApy(before, reserve, thresholds),
        ...evaluateBalances(before, reserve, thresholds),
      );
    }
    const samples = window.samples.flatMap((sample) => {
      const metrics = sample.reserves[key];
      return metrics === undefined
        ? []
        : [{ sampledAt: sample.sampledAt, metrics }];
    });
    if (window.continuous && samples.length === window.samples.length)
      hits.push(...evaluateUtilization(samples, thresholds));
    findings.push(...hits.map((hit) => ({ ...hit, reserveKey: key })));
  }
  return findings;
}

export interface Notification {
  level: "info" | "warning";
  title: string;
  description: string;
}

const labels: Record<Metric, string> = {
  liquidity: "可用流动性",
  utilization: "利用率",
  borrow_apy: "借款 APY",
  supply_total: "总供给量",
  borrow_total: "总借款量",
  supply_cap_usage: "Supply Cap 使用率",
  borrow_cap_usage: "Borrow Cap 使用率",
};

function percent(decimal: string): string {
  return `${(Number(decimal) * 100).toFixed(2)}%`;
}

function timestamp(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));
}

export function renderNotifications(
  findings: Finding[],
  current: ReserveSnapshot,
  history: ReserveSnapshot[],
): Notification[] {
  const window = buildWindow(current, history);
  const groups = new Map<ReserveKey, Finding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.reserveKey) ?? [];
    group.push(finding);
    groups.set(finding.reserveKey, group);
  }
  return Array.from(groups, ([key, hits]) => {
    const reserve = current.reserves[key];
    const lines = hits.map((hit) => {
      const threshold = hit.thresholdBps / 100;
      if (hit.metric === "utilization") {
        return `- 利用率：${percent(hit.current)}；拐点 ${percent(value(reserve.borrow!.optimalUsageRate))}；窗口内所有采样均达到各自拐点 + ${threshold} 个百分点。`;
      }
      if (
        hit.metric === "supply_cap_usage" ||
        hit.metric === "borrow_cap_usage"
      ) {
        const total =
          hit.metric === "supply_cap_usage"
            ? reserve.totalSupply
            : reserve.borrow!.totalBorrow;
        const cap =
          hit.metric === "supply_cap_usage"
            ? reserve.supplyCap
            : reserve.borrow!.borrowCap;
        const previous = window.baseline?.reserves[key];
        const oldCap =
          hit.metric === "supply_cap_usage"
            ? previous?.supplyCap
            : previous?.borrow?.borrowCap;
        const capText = oldCap
          ? `${value(oldCap)} → ${value(cap)}`
          : value(cap);
        return `- ${labels[hit.metric]}：${percent(hit.current)}，阈值 ${threshold}%；当前总量 ${value(total)}；Cap ${capText} ${reserve.symbol}。`;
      }
      if (hit.metric === "borrow_apy") {
        return `- 借款 APY：${percent(hit.before!)} → ${percent(hit.current)}；上涨 ${(Number(hit.change!) * 100).toFixed(2)} 个百分点，阈值 ${threshold} 个百分点。`;
      }
      const direction = hit.direction === "increase" ? "增加" : "减少";
      return `- ${labels[hit.metric]}：${hit.before} → ${hit.current} ${reserve.symbol}；${direction} ${percent(String(Math.abs(Number(hit.change!))))}，阈值 ${threshold}%。`;
    });
    const period =
      window.baseline === null
        ? "历史窗口尚未覆盖 15 分钟，当前仅评估 Cap。"
        : `比较时间：${timestamp(window.baseline.sampledAt)} → ${timestamp(current.sampledAt)}（${((Date.parse(current.sampledAt) - Date.parse(window.baseline.sampledAt)) / 60_000).toFixed(1)} 分钟）。`;
    const warning = hits.some(
      (hit) =>
        !hit.metric.endsWith("cap_usage") &&
        !(hit.metric === "liquidity" && hit.direction === "increase"),
    );
    return {
      level: warning ? "warning" : "info",
      title: `Aave V3 ${reserve.marketName} / ${reserve.symbol} 指标提醒`,
      description: `链：${reserve.chainId}\n市场：${reserve.marketAddress}\n资产：${reserve.assetAddress}\n采样：${timestamp(current.sampledAt)}（Asia/Shanghai）\n${period}\n\n${lines.join("\n")}\n\n变化来自 API 采样；供借量为余额变化。`,
    };
  });
}
