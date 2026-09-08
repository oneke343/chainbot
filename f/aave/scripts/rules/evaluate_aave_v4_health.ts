//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  defineHealthPositionAdapter, evaluatePositionHealth, renderPositionHealthMessages, selectChains,
  validateUserAndChains, type HealthInputs, type PositionHealthStates,
  type PositionMessagePolicy, type PositionRiskRule, type PositionRiskOptions,
  type PositionStressRule,
} from "../../../chain_sentinel/lib/health-factor.ts";

type AaveData = {
  chains: { chainId: number; name: string }[];
  userPositions: {
    user: string;
    healthFactor: { current: string | null };
    totalDebt: { current: { value: string } };
    totalCollateral: { current: { value: string } };
    spoke: { address: string; name: string; chain: { chainId: number; name: string } };
  }[];
};

export function normalizeAaveV4Positions(
  result: Record<string, unknown>,
  user: string,
  chain_ids: number[] = [],
): HealthInputs {
  validateUserAndChains(user, chain_ids);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Missing Aave V4 GraphQL result");
  }
  if (Array.isArray(result.errors) && result.errors.length) throw new Error("Aave V4 GraphQL returned errors");
  const data = (Object.hasOwn(result, "data") ? result.data : result) as AaveData;
  if (!Array.isArray(data?.chains)) throw new Error("Missing Aave V4 chains");
  const chains = selectChains(data.chains.map((chain) => ({ id: chain.chainId, name: chain.name })), chain_ids);
  if (!Array.isArray(data.userPositions)) throw new Error("Missing Aave V4 positions");
  const positions = data.userPositions.map((position) => {
    const { spoke } = position;
    if (!spoke?.name || !/^0x[0-9a-fA-F]{40}$/.test(spoke.address)
      || !chains.some((chain) => chain.id === spoke.chain?.chainId)
      || position.user?.toLowerCase() !== user.toLowerCase()) {
      throw new Error("Invalid Aave V4 Spoke or position owner");
    }
    const debt = position.totalDebt?.current?.value;
    if (typeof debt !== "string" || !/^\d+(\.\d+)?$/.test(debt)) {
      throw new Error(`Missing Aave V4 debt for ${spoke.name}`);
    }
    if (!position.healthFactor || position.healthFactor.current === undefined) {
      throw new Error(`Missing Aave V4 health factor for ${spoke.name}`);
    }
    const market_name = `${spoke.chain.name} / ${spoke.name}`;
    return {
      id: `${spoke.chain.chainId}:${spoke.address.toLowerCase()}`,
      name: `${market_name} / ${spoke.address.toLowerCase()}`,
      market_name,
      chain_id: spoke.chain.chainId,
      health_factor: position.healthFactor.current,
      // Keep non-null HF even when the API's displayed USD debt rounds to zero.
      has_debt: position.healthFactor.current !== null || /[1-9]/.test(debt),
      debt_usd: debt,
      collateral_usd: position.totalCollateral?.current?.value ?? null,
    };
  });
  return { user, observed_at: new Date().toISOString(), chains, positions };
}

export const aaveV4HealthAdapter = defineHealthPositionAdapter<Record<string, unknown>>({
  protocol: "Aave V4",
  normalize: (source, context) => normalizeAaveV4Positions(source, context.user, context.chain_ids),
});

export function evaluateAaveV4Health(
  inputs: HealthInputs,
  default_threshold: number | string,
  market_thresholds: Record<string, number | string> = {},
  previous_states: unknown = {},
  risk_rules: PositionRiskRule[] = [],
  stress_rules: PositionStressRule[] = [],
  risk_options: PositionRiskOptions = {},
  message_policy: PositionMessagePolicy = {},
) {
  const inspection = evaluatePositionHealth(
    inputs, default_threshold, market_thresholds, previous_states, risk_rules, stress_rules, risk_options,
  );
  const states = inspection.states;
  const messages = renderPositionHealthMessages(
      "Aave V4", inputs.user, inputs.observed_at, inspection.triggered_findings,
      message_policy,
    );
  const output: RT.MonitorOutput = {
    matched: messages.length > 0,
    messages,
    fields: {
      protocol: "aave-v4", user: inputs.user, observed_at: inputs.observed_at,
      chains: inputs.chains, positions: inspection.positions,
      triggered_findings: inspection.triggered_findings,
      active_findings: inspection.active_findings,
      unused_thresholds: inspection.unused_thresholds,
      triggered_finding_count: inspection.triggered_findings.length,
      message_count: messages.length,
    },
  };
  return { states, output };
}

export async function main(
  inputs: Record<string, unknown>,
  user: string,
  default_threshold: number | string,
  market_thresholds: Record<string, number | string> = {},
  chain_ids: number[] = [],
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
  const normalized = aaveV4HealthAdapter.normalize(inputs, { user, chain_ids });
  evaluateAaveV4Health(normalized, default_threshold, market_thresholds, {}, risk_rules, stress_rules, risk_options, message_policy);
  const previous = await getMonitorState<Record<string, unknown>, PositionHealthStates>();
  const { states, output } = evaluateAaveV4Health(
    normalized, default_threshold, market_thresholds, previous.states, risk_rules, stress_rules, risk_options, message_policy,
  );
  await setMonitorState(inputs, states, output);
  return output;
}
