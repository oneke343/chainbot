/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type AaveMarketPositionsQueryVariables = Exact<{
  user: string;
  chainIds: Array<number> | number;
}>;


export type AaveMarketPositionsQuery = { markets: Array<{ name: string, address: string, chain: { chainId: number, name: string }, userState: { eModeEnabled: boolean, healthFactor: string | null, totalDebtBase: string, totalCollateralBase: string } | null }> };
