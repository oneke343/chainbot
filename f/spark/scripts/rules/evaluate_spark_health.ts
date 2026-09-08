//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  defineHealthPositionAdapter, evaluatePositionHealth, renderPositionHealthMessages,
  type HealthInputs, type PositionHealthStates, type PositionMessagePolicy, type PositionRiskRule,
} from "../../../chain_sentinel/lib/health-factor.ts";

type SparkSource = {
  user: string;
  observed_at: string;
  accounts: Array<{
    name: string;
    chain_id: number;
    chain_name: string;
    pool_address: string;
    total_collateral: string;
    total_debt: string;
    health_factor: string | null;
  }>;
};

export const sparkHealthAdapter = defineHealthPositionAdapter<SparkSource>({
  protocol: "SparkLend",
  normalize(source, context): HealthInputs {
    if (source.user.toLowerCase() !== context.user.toLowerCase() || !Array.isArray(source.accounts)) {
      throw new Error("Invalid SparkLend Source result");
    }
    const selected = source.accounts.filter((account) => !context.chain_ids?.length || context.chain_ids.includes(account.chain_id));
    for (const chainId of context.chain_ids ?? []) {
      if (!source.accounts.some((account) => account.chain_id === chainId)) throw new Error(`Unsupported chain: ${chainId}`);
    }
    const chains = [...new Map(selected.map((account) => [account.chain_id, account.chain_name])).entries()]
      .map(([id, name]) => ({ id, name }));
    return {
      user: context.user,
      observed_at: source.observed_at,
      chains,
      positions: selected.map((account) => {
        const marketName = `${account.chain_name} / ${account.name}`;
        return {
          id: `${account.chain_id}:${account.pool_address.toLowerCase()}`,
          name: `${marketName} / ${account.pool_address.toLowerCase()}`,
          market_name: marketName,
          chain_id: account.chain_id,
          health_factor: account.health_factor,
          has_debt: account.health_factor !== null,
          debt_usd: account.total_debt,
          collateral_usd: account.total_collateral,
        };
      }),
    };
  },
});

export function evaluateSparkHealth(
  inputs: HealthInputs,
  default_threshold: number | string,
  market_thresholds: Record<string, number | string> = {},
  previous_states: unknown = {},
  risk_rules: PositionRiskRule[] = [],
  message_policy: PositionMessagePolicy = {},
) {
  const inspection = evaluatePositionHealth(inputs, default_threshold, market_thresholds, previous_states, risk_rules);
  const messages = renderPositionHealthMessages("SparkLend", inputs.user, inputs.observed_at, inspection.triggered_findings, message_policy);
  const output: RT.MonitorOutput = {
    matched: messages.length > 0,
    messages,
    fields: {
      protocol: "spark-lend", user: inputs.user, observed_at: inputs.observed_at,
      chains: inputs.chains, positions: inspection.positions,
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
  inputs: {
    user: string;
    observed_at: string;
    accounts: Array<{
      name: string;
      chain_id: number;
      chain_name: string;
      pool_address: string;
      total_collateral: string;
      total_debt: string;
      health_factor: string | null;
    }>;
  },
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
  }> = [],
  message_policy: { max_messages?: number; overflow?: "summary" | "truncate" } = {},
): Promise<RT.MonitorOutput> {
  const normalized = sparkHealthAdapter.normalize(inputs, { user, chain_ids });
  evaluateSparkHealth(normalized, default_threshold, market_thresholds, {}, risk_rules, message_policy);
  const previous = await getMonitorState<SparkSource, PositionHealthStates>();
  const { states, output } = evaluateSparkHealth(normalized, default_threshold, market_thresholds, previous.states, risk_rules, message_policy);
  await setMonitorState(inputs, states, output);
  return output;
}
