/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type AaveV4ParamsInventoryQueryVariables = Exact<{
  chain_ids: Array<number> | number;
}>;


export type AaveV4ParamsInventoryQuery = { hubs: Array<{ address: string, chain: { chainId: number } }> };
