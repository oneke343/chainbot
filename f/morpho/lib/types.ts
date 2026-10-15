/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type MorphoUsersPositionsQueryVariables = Exact<{
  users: Array<string> | string;
  skip: number;
}>;


export type MorphoUsersPositionsQuery = { marketPositions: { items: Array<{ healthFactor: number | null, user: { address: string }, market: { marketId: string, lltv: string, chain: { id: number, network: string }, loanAsset: { symbol: string }, collateralAsset: { symbol: string } | null } }> | null, pageInfo: { countTotal: number } | null } };
