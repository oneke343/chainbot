//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  evaluatePositionHealth,
  defineHealthPositionAdapter,
  renderPositionHealthMessages,
  type HealthInputs,
  type PositionMessagePolicy,
  type PositionRiskRule,
  type PositionRiskOptions,
  type PositionStressRule,
  type PositionHealthStates,
} from "../../../chain_sentinel/lib/health-factor.ts";

type MarketThreshold = string | number;

type AaveMarket = {
  name?: string;
  address?: string;
  chain?: { chainId?: number; name?: string } | null;
  userState?: {
    healthFactor?: string | number | null;
    totalDebtBase?: string | number;
    totalCollateralBase?: string | number;
  } | null;
};

type AaveHealthInputs = {
  aave_market_positions: { markets?: AaveMarket[] };
};

export function normalizeAaveV3Positions(
  inputs: AaveHealthInputs,
  user: string,
  market_thresholds: Record<string, MarketThreshold> = {},
  use_default_threshold = true,
): HealthInputs {
  if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("user must be an EVM address");
  const markets = inputs?.aave_market_positions?.markets;
  if (!Array.isArray(markets)) throw new Error("Missing Aave V3 markets");
  const selected = markets.filter((market) => market.name && market.userState
    && (use_default_threshold || Object.hasOwn(market_thresholds, market.name)));
  const chains = new Map<number, string>();
  const positions = selected.map((market) => {
    const name = market.name!;
    const chainId = market.chain?.chainId;
    const chainName = market.chain?.name;
    if (!Number.isSafeInteger(chainId) || Number(chainId) <= 0 || !chainName
      || !market.address || !/^0x[0-9a-fA-F]{40}$/.test(market.address)) {
      throw new Error(`Invalid Aave V3 chain for ${name}`);
    }
    chains.set(chainId!, chainName);
    const healthFactor = market.userState?.healthFactor;
    if (healthFactor === undefined) throw new Error(`Missing Aave V3 health factor for ${name}`);
    const debt = market.userState?.totalDebtBase ?? null;
    return {
      id: `${chainId}:${market.address.toLowerCase()}`,
      name,
      market_name: name,
      chain_id: chainId!,
      health_factor: healthFactor ?? null,
      has_debt: healthFactor !== null || (debt !== null && Number(debt) > 0),
      debt_usd: debt,
      collateral_usd: market.userState?.totalCollateralBase ?? null,
    };
  });
  return {
    user,
    observed_at: new Date().toISOString(),
    chains: [...chains].map(([id, name]) => ({ id, name })),
    positions,
  };
}

export const aaveV3HealthAdapter = defineHealthPositionAdapter<AaveHealthInputs>({
  protocol: "Aave V3",
  normalize: (source, context) => normalizeAaveV3Positions(
    source, context.user, Object.fromEntries((context.market_names ?? []).map((name) => [name, 1])), true,
  ),
});

export function evaluateAaveHealth(
  inputs: AaveHealthInputs,
  user: string,
  market_thresholds: Record<string, MarketThreshold>,
  default_threshold: MarketThreshold | undefined = undefined,
  previous_states: unknown = {},
  risk_rules: PositionRiskRule[] = [],
  stress_rules: PositionStressRule[] = [],
  risk_options: PositionRiskOptions = {},
  message_policy: PositionMessagePolicy = {},
) {
  if (!market_thresholds || typeof market_thresholds !== "object" || Array.isArray(market_thresholds)) {
    throw new Error("market_thresholds must be an object");
  }
  const normalized = normalizeAaveV3Positions(
    inputs, user, market_thresholds, default_threshold !== undefined,
  );
  const inspection = evaluatePositionHealth(
    normalized, default_threshold ?? 1, market_thresholds, previous_states,
    risk_rules, stress_rules, risk_options,
  );
  const messages = renderPositionHealthMessages(
      "Aave V3", user, normalized.observed_at, inspection.triggered_findings,
      message_policy,
    );
  const output: RT.MonitorOutput = {
    matched: messages.length > 0,
    messages,
    fields: {
      protocol: "aave-v3",
      user,
      observed_at: normalized.observed_at,
      chains: normalized.chains,
      positions: inspection.positions,
      triggered_findings: inspection.triggered_findings,
      active_findings: inspection.active_findings,
      unused_thresholds: inspection.unused_thresholds,
      triggered_finding_count: inspection.triggered_findings.length,
      message_count: messages.length,
    },
  };
  return { states: inspection.states, output };
}

export async function main(
  inputs: AaveHealthInputs,
  user: string,
  market_thresholds: Record<string, MarketThreshold>,
  default_threshold: MarketThreshold | undefined = undefined,
  risk_rules: Array<{
    id: string;
    kind: "health_factor_drop" | "debt_growth" | "liquidation_buffer";
    threshold_percent: number;
    window_minutes?: number;
    min_debt_usd?: number;
    rearm_percent?: number;
  }> = [],
  stress_rules: Array<{
    id: string;
    collateral_change_percent: number;
    debt_change_percent?: number;
    threshold: number;
    min_debt_usd?: number;
  }> = [],
  risk_options: { rearm_health_factor_margin?: number; repeat_interval_minutes?: number } = {},
  message_policy: { max_messages?: number; overflow?: "summary" | "truncate" } = {},
): Promise<RT.MonitorOutput> {
  evaluateAaveHealth(
    inputs, user, market_thresholds, default_threshold, {},
    risk_rules, stress_rules, risk_options, message_policy,
  );
  const previous = await getMonitorState<AaveHealthInputs, PositionHealthStates>();
  const { states, output } = evaluateAaveHealth(
    inputs, user, market_thresholds, default_threshold, previous.states,
    risk_rules, stress_rules, risk_options, message_policy,
  );
  await setMonitorState(inputs, states, output);
  return output;
}
