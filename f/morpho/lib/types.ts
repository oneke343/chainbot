/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type MarketTransactionType =
  | 'Borrow'
  | 'Liquidation'
  | 'Repay'
  | 'Supply'
  | 'SupplyCollateral'
  | 'Withdraw'
  | 'WithdrawCollateral';

export type WarningLevel =
  | 'RED'
  | 'YELLOW';

export type MorphoMarketRiskQueryVariables = Exact<{
  market_ids: Array<string> | string;
  chain_ids?: Array<number> | number | null | undefined;
}>;


export type MorphoMarketRiskQuery = {
  markets: {
    items: Array<{
      marketId: string, chain: { id: number, network: string }, loanAsset: { symbol: string }, collateralAsset: { symbol: string } | null, state: { liquidityAssetsUsd: number | null, utilization: number } | null, badDebt: { usd: number | null } | null, realizedBadDebt: { usd: number | null } | null, warnings: Array<{
        type: string, level: WarningLevel, metadata:
          | { badDebtUsd: number | null }
          | { badDebtUsd: number | null }
          | { deviationFactor: number }
          | Record<PropertyKey, never>
          | null
      }>
    }> | null, pageInfo: { count: number, countTotal: number, limit: number, skip: number } | null
  }
};

export type MorphoUserLiquidationsQueryVariables = Exact<{
  user: string;
  chain_ids?: Array<number> | number | null | undefined;
}>;


export type MorphoUserLiquidationsQuery = {
  marketTransactions: {
    items: Array<{
      txHash: string, timestamp: string, blockNumber: string, logIndex: number, type: MarketTransactionType, chain: { id: number, network: string }, user: { address: string }, market: { marketId: string, loanAsset: { symbol: string }, collateralAsset: { symbol: string } | null }, data:
        | { repaidAssets: string, seizedAssets: string, badDebtAssets: string, liquidator: string }
        | Record<PropertyKey, never>
    }> | null, pageInfo: { count: number, countTotal: number, limit: number, skip: number } | null
  }
};

export type MorphoUserPositionsQueryVariables = Exact<{
  user: string;
  chain_ids?: Array<number> | number | null | undefined;
}>;


export type MorphoUserPositionsQuery = { chains: Array<{ id: number, network: string }>, marketPositions: { items: Array<{ healthFactor: number | null, user: { address: string }, market: { marketId: string, lltv: string, chain: { id: number, network: string }, loanAsset: { symbol: string }, collateralAsset: { symbol: string } | null }, state: { borrowShares: string, borrowAssetsUsd: number | null, collateralUsd: number | null } | null }> | null, pageInfo: { count: number, countTotal: number, limit: number, skip: number } | null } };

export type MorphoUsersPositionsQueryVariables = Exact<{
  users: Array<string> | string;
  skip: number;
}>;


export type MorphoUsersPositionsQuery = { marketPositions: { items: Array<{ healthFactor: number | null, user: { address: string }, market: { marketId: string, lltv: string, chain: { id: number, network: string }, loanAsset: { symbol: string }, collateralAsset: { symbol: string } | null } }> | null, pageInfo: { countTotal: number } | null } };
