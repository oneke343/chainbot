// The Bun runner initializes the checkpoint context required by workflow().
import { taskScript, workflow } from "windmill-client";
import type { Address, NetworkParams, Snapshots } from "../../lib/market-params.ts";

const queryHubs = taskScript("f/aave/scripts/sources/aave_v4_market_params_inventory", { timeout: 30 });
const readHubs = taskScript("f/aave/scripts/sources/aave_v4_read_hubs", { timeout: 60 });

export const main = workflow(async (api: RT.Graphql, rpc_urls: Record<string, string>): Promise<Snapshots> => {
  const { hubs }: { hubs: Array<{ address: Address; chain: { chainId: number } }> } = await queryHubs({
    api, chain_ids: Object.keys(rpc_urls).map(Number),
  });
  const networks = Object.entries(rpc_urls);
  const readings: NetworkParams[] = await Promise.all(networks.map(([chain, rpc_url]) => readHubs({
    rpc_url,
    hub_addresses: hubs.filter((hub) => hub.chain.chainId === Number(chain)).map((hub) => hub.address),
  })));
  return Object.fromEntries(networks.map(([chain], index) => [chain, readings[index]]));
});
