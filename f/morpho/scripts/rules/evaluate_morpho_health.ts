//native

import { getMonitorState, setMonitorState } from "../../../chain_sentinel/lib/monitor-state.ts";
import {
  defineHealthPositionAdapter, evaluatePositionHealth, renderPositionHealthMessages, selectChains,
  validateUserAndChains, type HealthInputs, type PositionHealthStates,
  type PositionMessagePolicy, type PositionRiskRule,
} from "../../../chain_sentinel/lib/health-factor.ts";

type MorphoData = {
  chains: { id: number; network: string }[];
  marketPositions: {
    items: {
      user: { address: string };
      healthFactor: number | null;
      market: {
        marketId: string;
        lltv: string;
        chain: { id: number; network: string };
        loanAsset: { symbol: string };
        collateralAsset: { symbol: string } | null;
      };
      state: { borrowShares: string; borrowAssetsUsd: number | null; collateralUsd: number | null } | null;
    }[] | null;
    pageInfo: { count: number; countTotal: number; limit: number; skip: number } | null;
  };
};

export function normalizeMorphoPositions(
  result: Record<string, unknown>,
  user: string,
  chain_ids: number[] = [],
): HealthInputs {
  validateUserAndChains(user, chain_ids);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Missing Morpho GraphQL result");
  }
  // Native GraphQL returns data directly; also accept an HTTP GraphQL envelope.
  if (Array.isArray(result.errors) && result.errors.length) throw new Error("Morpho GraphQL returned errors");
  const data = (Object.hasOwn(result, "data") ? result.data : result) as MorphoData;
  if (!Array.isArray(data?.chains)) throw new Error("Missing Morpho chains");
  const chains = selectChains(data.chains.map((chain) => ({ id: chain.id, name: chain.network })), chain_ids);
  const items = data.marketPositions?.items;
  const info = data.marketPositions?.pageInfo;
  if (!Array.isArray(items) || !info || info.skip !== 0 || info.count !== items.length
    || !Number.isSafeInteger(info.countTotal) || info.countTotal !== items.length || items.length > 1000) {
    throw new Error("Morpho positions are incomplete (single-query limit: 1000); no state saved");
  }
  const positions = items.map((position) => {
    const { market, state } = position;
    if (!market || !/^0x[0-9a-fA-F]{64}$/.test(market.marketId)
      || !chains.some((chain) => chain.id === market.chain?.id)
      || position.user?.address?.toLowerCase() !== user.toLowerCase()
      || !market.loanAsset?.symbol || !market.collateralAsset?.symbol
      || !/^\d+$/.test(market.lltv)
      || !state || !/^\d+$/.test(state.borrowShares) || BigInt(state.borrowShares) <= 0n
      || position.healthFactor === undefined) {
      throw new Error("Invalid Morpho borrowing position");
    }
    const market_name = `${market.chain.network} / ${market.collateralAsset.symbol}-${market.loanAsset.symbol} / LLTV ${Number(market.lltv) / 1e16}%`;
    return {
      id: `${market.chain.id}:${market.marketId.toLowerCase()}`,
      name: `${market_name} / ${market.marketId.toLowerCase()}`,
      market_name,
      chain_id: market.chain.id,
      health_factor: position.healthFactor,
      has_debt: true,
      debt_usd: state.borrowAssetsUsd,
      collateral_usd: state.collateralUsd,
    };
  });
  return { user, observed_at: new Date().toISOString(), chains, positions };
}

export const morphoHealthAdapter = defineHealthPositionAdapter<Record<string, unknown>>({
  protocol: "Morpho",
  normalize: (source, context) => normalizeMorphoPositions(source, context.user, context.chain_ids),
});

export function evaluateMorphoHealth(
  inputs: HealthInputs,
  default_threshold: number | string,
  market_thresholds: Record<string, number | string> = {},
  previous_states: unknown = {},
  risk_rules: PositionRiskRule[] = [],
  message_policy: PositionMessagePolicy = {},
) {
  const inspection = evaluatePositionHealth(
    inputs, default_threshold, market_thresholds, previous_states, risk_rules,
  );
  const states = inspection.states;
  const messages = renderPositionHealthMessages(
      "Morpho", inputs.user, inputs.observed_at, inspection.triggered_findings,
      message_policy,
    );
  const output: RT.MonitorOutput = {
    matched: messages.length > 0,
    messages,
    fields: {
      protocol: "morpho", user: inputs.user, observed_at: inputs.observed_at,
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
  }> = [],
  message_policy: { max_messages?: number; overflow?: "summary" | "truncate" } = {},
): Promise<RT.MonitorOutput> {
  const normalized = morphoHealthAdapter.normalize(inputs, { user, chain_ids });
  evaluateMorphoHealth(normalized, default_threshold, market_thresholds, {}, risk_rules, message_policy);
  const previous = await getMonitorState<Record<string, unknown>, PositionHealthStates>();
  const { states, output } = evaluateMorphoHealth(
    normalized, default_threshold, market_thresholds, previous.states, risk_rules, message_policy,
  );
  await setMonitorState(inputs, states, output);
  return output;
}
