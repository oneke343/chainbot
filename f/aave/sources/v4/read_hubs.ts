//native

import { READER_ABI, READER_RUNTIME_BYTECODE } from "../../lib/market-params-reader-artifact.ts";
import { rpcMulticall } from "../../lib/multicall.ts";
import type { Address, HubGraph, NetworkParams } from "../../lib/market-params.ts";

export const READER_CALL_ADDRESS = "0x000000000000000000000000000000000000a004" as const;

export async function main(rpc_url: string, hub_addresses: Address[]): Promise<NetworkParams> {
  const results = await rpcMulticall(rpc_url, {
    contracts: hub_addresses.map((address) => ({ address: READER_CALL_ADDRESS, abi: READER_ABI, functionName: "readHub", args: [address] } as const)),
    stateOverride: [{ address: READER_CALL_ADDRESS, code: READER_RUNTIME_BYTECODE }],
    // Creation-based multicall returns its output as code and hits EIP-170 for large graphs.
    multicallAddress: "0xca11bde05977b3631167028862be2a173976ca11",
    allowFailure: false, batchSize: 0, blockTag: "latest",
  });
  // Preserve every Reader field and array; only bigint needs conversion for JSON output.
  const graphs: HubGraph[] = JSON.parse(JSON.stringify(results, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  return Object.fromEntries(hub_addresses.map((address, index) => [address, graphs[index]]));
}
