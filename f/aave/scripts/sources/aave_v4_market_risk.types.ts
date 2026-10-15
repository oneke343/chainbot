/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type AaveV4MarketRiskQueryVariables = Exact<{
  chain_ids: Array<number> | number;
}>;


export type AaveV4MarketRiskQuery = { reserves: Array<{ id: string, canSupply: boolean, canBorrow: boolean, chain: { chainId: number, name: string }, spoke: { id: string, name: string, address: string }, asset: { onchainAssetId: string, hub: { id: string, name: string, address: string }, underlying: { address: string, info: { symbol: string, decimals: number } } }, summary: { supplied: { amount: { onChainValue: string, decimals: number }, exchange: { value: string } }, borrowed: { amount: { onChainValue: string, decimals: number }, exchange: { value: string } }, suppliable: { amount: { onChainValue: string, decimals: number } }, borrowable: { amount: { onChainValue: string, decimals: number } } }, settings: { supplyCap: { amount: { onChainValue: string, decimals: number } }, borrowCap: { amount: { onChainValue: string, decimals: number } } }, status: { paused: boolean, frozen: boolean, active: boolean } }> };
