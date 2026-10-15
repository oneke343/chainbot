/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type AaveMarketPositionsQueryVariables = Exact<{
  user: string;
  chainIds: Array<number> | number;
}>;


export type AaveMarketPositionsQuery = { markets: Array<{ name: string, address: string, chain: { chainId: number, name: string }, userState: { eModeEnabled: boolean, healthFactor: string | null, totalDebtBase: string, totalCollateralBase: string } | null }> };

export type AaveV3MarketRiskQueryVariables = Exact<{
  chain_ids: Array<number> | number;
}>;


export type AaveV3MarketRiskQuery = { markets: Array<{ name: string, address: string, chain: { chainId: number, name: string }, reserves: Array<{ usdExchangeRate: string, isFrozen: boolean, isPaused: boolean, underlyingToken: { address: string, symbol: string }, supplyInfo: { supplyCapReached: boolean, total: { value: string }, supplyCap: { usd: string, amount: { value: string } } }, borrowInfo: { borrowCapReached: boolean, total: { usd: string, amount: { value: string } }, availableLiquidity: { usd: string, amount: { value: string } }, utilizationRate: { value: string }, borrowCap: { usd: string, amount: { value: string } } } | null }> }> };

export type AaveV3UserLiquidationsQueryVariables = Exact<{
  user: string;
  market: string;
  chain_id: number;
}>;


export type AaveV3UserLiquidationsQuery = { userTransactionHistory: { items: Array<
      | { __typename: 'UserBorrowTransaction' }
      | { __typename: 'UserLiquidationCallTransaction', txHash: string, timestamp: string, blockExplorerUrl: string, collateral: { reserve: { underlyingToken: { symbol: string } }, amount: { usd: string, amount: { value: string } } | null }, debtRepaid: { reserve: { underlyingToken: { symbol: string } }, amount: { usd: string, amount: { value: string } } } }
      | { __typename: 'UserRepayTransaction' }
      | { __typename: 'UserSupplyTransaction' }
      | { __typename: 'UserUsageAsCollateralTransaction' }
      | { __typename: 'UserWithdrawTransaction' }
    >, pageInfo: { next: string | null } } };

export type AaveV3ChainsQueryVariables = Exact<{ [key: string]: never; }>;


export type AaveV3ChainsQuery = { chains: Array<{ chainId: number, name: string }> };
