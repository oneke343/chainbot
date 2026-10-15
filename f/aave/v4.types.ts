/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type AaveV4ChainsQueryVariables = Exact<{ [key: string]: never; }>;


export type AaveV4ChainsQuery = { chains: Array<{ chainId: number, name: string }> };

export type AaveV4ParamsInventoryQueryVariables = Exact<{
  chain_ids: Array<number> | number;
}>;


export type AaveV4ParamsInventoryQuery = { hubs: Array<{ address: string, chain: { chainId: number } }> };

export type AaveV4MarketRiskQueryVariables = Exact<{
  chain_ids: Array<number> | number;
}>;


export type AaveV4MarketRiskQuery = { reserves: Array<{ id: string, canSupply: boolean, canBorrow: boolean, chain: { chainId: number, name: string }, spoke: { id: string, name: string, address: string }, asset: { onchainAssetId: string, hub: { id: string, name: string, address: string }, underlying: { address: string, info: { symbol: string, decimals: number } } }, summary: { supplied: { amount: { onChainValue: string, decimals: number }, exchange: { value: string } }, borrowed: { amount: { onChainValue: string, decimals: number }, exchange: { value: string } }, suppliable: { amount: { onChainValue: string, decimals: number } }, borrowable: { amount: { onChainValue: string, decimals: number } } }, settings: { supplyCap: { amount: { onChainValue: string, decimals: number } }, borrowCap: { amount: { onChainValue: string, decimals: number } } }, status: { paused: boolean, frozen: boolean, active: boolean } }> };

export type AaveV4UserLiquidationsQueryVariables = Exact<{
  user: string;
  chain_ids: Array<number> | number;
}>;


export type AaveV4UserLiquidationsQuery = { activities: { items: Array<
      | { __typename: 'BorrowActivity' }
      | { __typename: 'BorrowSwapActivity' }
      | { __typename: 'LeverageActivity' }
      | { __typename: 'LiquidatedActivity', id: string, user: string, timestamp: string, txHash: string, liquidationHealthFactor: string, chain: { chainId: number, name: string }, spoke: { address: string, name: string }, collateralReserve: { asset: { underlying: { info: { symbol: string } } } }, debtReserve: { asset: { underlying: { info: { symbol: string } } } }, collateral: { amount: { value: string }, token: { info: { symbol: string } } }, debt: { amount: { value: string }, token: { info: { symbol: string } } } }
      | { __typename: 'RepayActivity' }
      | { __typename: 'RepayWithSupplyActivity' }
      | { __typename: 'SupplyActivity' }
      | { __typename: 'SupplySwapActivity' }
      | { __typename: 'TokenSwapActivity' }
      | { __typename: 'UpdatedDynamicConfigActivity' }
      | { __typename: 'UpdatedRiskPremiumActivity' }
      | { __typename: 'UsingAsCollateralActivity' }
      | { __typename: 'WithdrawActivity' }
      | { __typename: 'WithdrawSwapActivity' }
    >, pageInfo: { next: string | null } } };

export type AaveV4UserPositionsQueryVariables = Exact<{
  user: string;
  chain_ids: Array<number> | number;
}>;


export type AaveV4UserPositionsQuery = { userPositions: Array<{ user: string, healthFactor: { current: string | null }, totalDebt: { current: { value: string } }, totalCollateral: { current: { value: string } }, spoke: { address: string, name: string, chain: { chainId: number, name: string } } }> };
