/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
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
