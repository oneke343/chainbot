/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type AaveV3MarketRiskQueryVariables = Exact<{
  chain_ids: Array<number> | number;
}>;


export type AaveV3MarketRiskQuery = { markets: Array<{ name: string, address: string, chain: { chainId: number, name: string }, reserves: Array<{ usdExchangeRate: string, isFrozen: boolean, isPaused: boolean, underlyingToken: { address: string, symbol: string }, supplyInfo: { supplyCapReached: boolean, total: { value: string }, supplyCap: { usd: string, amount: { value: string } } }, borrowInfo: { borrowCapReached: boolean, total: { usd: string, amount: { value: string } }, availableLiquidity: { usd: string, amount: { value: string } }, utilizationRate: { value: string }, borrowCap: { usd: string, amount: { value: string } } } | null }> }> };
