/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
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
