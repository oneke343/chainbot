import { parseAbi, type Address } from "viem";
import {
  callWithAbi,
  mapWithConcurrency,
  readOne,
  type PublicClient,
  type ReadConfig,
} from "./rpc.ts";

export const POOL_VIEW_ABI = parseAbi([
  "function activePoolsWithRewards(uint256,uint256,uint256) view returns (uint256,(address,address,uint256,(address,uint256,uint8,bool,uint8)[])[])",
]);

export type PoolViewReward = {
  token: Address;
  amount: bigint;
  decimals: number;
  decimalsValid: boolean;
  source: number;
};

export type PoolViewPool = {
  pool: Address;
  gauge: Address;
  votes: bigint;
  rewards: PoolViewReward[];
};

export type PoolViewResult = {
  registeredPools: number;
  pools: PoolViewPool[];
};

const DEFAULT_PAGE_SIZE = 100;

/** Read all Voter pages from the deployed AerodromePoolView contract. */
export async function readPoolView(
  client: PublicClient,
  block: bigint,
  epoch: bigint,
  viewAddress: Address,
  config?: ReadConfig,
): Promise<PoolViewResult> {
  const pageSize = config?.poolViewPageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 10 || pageSize > 100)
    throw new Error("poolViewPageSize must be an integer from 10 to 100");
  const readPage = async (offset: number) => {
    const [registeredPools, rawPools] = (await readOne(
      client,
      block,
      callWithAbi(
        viewAddress,
        "activePoolsWithRewards",
        POOL_VIEW_ABI,
        BigInt(offset),
        BigInt(pageSize),
        epoch,
      ),
      POOL_VIEW_ABI,
    )) as [bigint, readonly [Address, Address, bigint, readonly [Address, bigint, number, boolean, number][]][]];
    return {
      registeredPools: Number(registeredPools),
      pools: rawPools.map(([pool, gauge, votes, rewards]) => ({
        pool,
        gauge,
        votes,
        rewards: rewards.map(([token, amount, decimals, decimalsValid, source]) => ({
          token,
          amount,
          decimals,
          decimalsValid,
          source,
        })),
      })),
    };
  };

  const first = await readPage(0);
  const offsets = Array.from(
    { length: Math.max(0, Math.ceil(first.registeredPools / pageSize) - 1) },
    (_, index) => (index + 1) * pageSize,
  );
  const rest = await mapWithConcurrency(
    offsets,
    config?.rpcConcurrency ?? 4,
    readPage,
  );
  return {
    registeredPools: first.registeredPools,
    pools: [first, ...rest].flatMap((page) => page.pools),
  };
}
