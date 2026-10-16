/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type ReserveBorrowingState =
  /** Borrowing is disabled */
  | 'DISABLED'
  /** Borrowing is enabled */
  | 'ENABLED'
  /** The user emode settings make this underlying not able to be borrowed */
  | 'USER_EMODE_DISABLED_BORROW';

export type AaveV3ChainsQueryVariables = Exact<{ [key: string]: never; }>;


export type AaveV3ChainsQuery = { chains: Array<{ chainId: number, name: string }> };

export type AaveV3MarketMetricsQueryVariables = Exact<{
  chain_ids: Array<number> | number;
}>;


export type AaveV3MarketMetricsQuery = { markets: Array<{ name: string, address: string, chain: { chainId: number }, reserves: Array<{ underlyingToken: { address: string, name: string, symbol: string }, supplyInfo: { total: { raw: string, decimals: number }, supplyCap: { amount: { raw: string, decimals: number } } }, borrowInfo: { total: { amount: { raw: string, decimals: number } }, availableLiquidity: { amount: { raw: string, decimals: number } }, utilizationRate: { raw: string, decimals: number }, optimalUsageRate: { raw: string, decimals: number }, apy: { raw: string, decimals: number }, borrowCap: { amount: { raw: string, decimals: number } } } | null }> }> };

export type AaveV3MarketParamsQueryVariables = Exact<{
  chain_ids: Array<number> | number;
}>;


export type AaveV3MarketParamsQuery = { markets: Array<{ name: string, address: string, chain: { chainId: number }, reserves: Array<{ usdOracleAddress: string, interestRateStrategyAddress: string, isFrozen: boolean, isPaused: boolean, flashLoanEnabled: boolean, underlyingToken: { address: string, symbol: string, decimals: number }, aToken: { address: string }, vToken: { address: string }, supplyInfo: { canBeCollateral: boolean, maxLTV: { raw: string, decimals: number }, liquidationThreshold: { raw: string, decimals: number }, liquidationBonus: { raw: string, decimals: number }, supplyCap: { amount: { raw: string, decimals: number } } }, borrowInfo: { borrowingState: ReserveBorrowingState, reserveFactor: { raw: string, decimals: number }, borrowCap: { amount: { raw: string, decimals: number } }, baseVariableBorrowRate: { raw: string, decimals: number }, variableRateSlope1: { raw: string, decimals: number }, variableRateSlope2: { raw: string, decimals: number }, optimalUsageRate: { raw: string, decimals: number } } | null, isolationModeConfig: { canBeCollateral: boolean, canBeBorrowed: boolean, debtCeilingDecimals: number, debtCeiling: { amount: { raw: string, decimals: number } } } | null }>, eModeCategories: Array<{ id: number, label: string, isolated: boolean, maxLTV: { raw: string, decimals: number }, liquidationThreshold: { raw: string, decimals: number }, liquidationPenalty: { raw: string, decimals: number }, reserves: Array<{ canBeCollateral: boolean, canBeBorrowed: boolean, hasLtvZero: boolean, underlyingToken: { address: string } }> }> }> };

export type AaveMarketPositionsQueryVariables = Exact<{
  user: string;
  chainIds: Array<number> | number;
}>;


export type AaveMarketPositionsQuery = { markets: Array<{ name: string, address: string, chain: { chainId: number, name: string }, userState: { eModeEnabled: boolean, healthFactor: string | null, totalDebtBase: string, totalCollateralBase: string } | null }> };
