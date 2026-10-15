/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type AaveV4UserPositionsQueryVariables = Exact<{
  user: string;
  chain_ids: Array<number> | number;
}>;


export type AaveV4UserPositionsQuery = { userPositions: Array<{ user: string, healthFactor: { current: string | null }, totalDebt: { current: { value: string } }, totalCollateral: { current: { value: string } }, spoke: { address: string, name: string, chain: { chainId: number, name: string } } }> };
