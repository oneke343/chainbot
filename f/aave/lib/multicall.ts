//native

import { createPublicClient, http, type MulticallParameters, type MulticallReturnType } from "viem";

// Keep authorizationList optional in both strict and non-strict TypeScript callers.
export type RpcMulticallParams<Calls extends readonly unknown[], AllowFailure extends boolean = true> =
  Omit<MulticallParameters<Calls, AllowFailure>, "authorizationList" | "allowFailure"> & {
    authorizationList?: MulticallParameters<Calls, AllowFailure>["authorizationList"];
    allowFailure?: AllowFailure;
  };

export async function rpcMulticall<const Calls extends readonly unknown[], AllowFailure extends boolean = true>(
  rpcUrl: string,
  params: RpcMulticallParams<Calls, AllowFailure>,
): Promise<MulticallReturnType<Calls, AllowFailure>> {
  // No runtime calls means no results, including for an empty dynamically built batch.
  if (!params.contracts.length) return [] as unknown as MulticallReturnType<Calls, AllowFailure>;
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) });
  return client.multicall<Calls, AllowFailure>({ authorizationList: params.authorizationList, ...params });
}
