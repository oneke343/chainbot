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
  before?: string;
  current: string;
  // Signed relative change for balances; signed rate difference for APY (1 = 100%).
  change?: string;
  thresholdBps: number;
}

export interface Finding extends MetricFinding {
  reserveKey: ReserveKey;
  marketName: string;
  assetName: string;
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
    findings.push(
      ...hits.map((hit) => ({
        ...hit,
        reserveKey: key,
        marketName: reserve.marketName,
        assetName: reserve.assetName,
      })),
    );
  }
  return findings;
}

export interface Notification {
  level: "info" | "warning";
  title: string;
  description: string;
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
      const warning = hits.some(
        (hit) => hit.metric !== "liquidity" || hit.direction !== "increase",
      );
      return {
        level: warning ? "warning" : "info",
        title: await render("Aave V3 {{finding.marketName}} 指标提醒", {
          finding: hits[0],
        }),
        description: await render(NOTIFICATION_TEMPLATE, {
          reserves: Object.values(
            Object.groupBy(hits, (hit) => hit.reserveKey),
          ),
        }),
      };
    }),
  );
}

const NOTIFICATION_TEMPLATE = `
{{#each reserves}}
资产：{{this.[0].assetName}}

{{#each this}}
- {{metric}} ({{direction}}): {{#if before}}{{before}} → {{/if}}{{current}}{{#if change}}；变化 {{change}}{{/if}}; 阈值 {{thresholdBps}} bps。
{{/each}}

{{/each}}
`;
