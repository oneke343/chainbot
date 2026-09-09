import { parseAbi, type Address } from "viem";
import {
  callWithAbi,
  many,
  readOne,
  type PublicClient,
  type ReadConfig,
} from "./rpc.ts";

/** Official Sugar deployment for Base (8453). */
export const VE_SUGAR =
  "0x4d6A741cEE6A8cC5632B2d948C050303F6246D24" as Address;

const VE_SUGAR_ABI = parseAbi([
  "function voter() view returns (address)",
  "function ve() view returns (address)",
  "function byAccount(address) view returns ((uint256 id,address account,uint8 decimals,uint128 amount,uint256 voting_amount,uint256 governance_amount,uint256 rebase_amount,uint256 expires_at,uint256 voted_at,(address lp,uint256 weight)[] votes,address token,bool permanent,uint256 delegate_id,uint256 managed_id)[])",
]);

export type SugarVote = { lp: Address; weight: bigint };
export type SugarVeNft = {
  id: bigint;
  account: Address;
  voting_amount: bigint;
  voted_at: bigint;
  votes: SugarVote[];
  permanent: boolean;
  managed_id: bigint;
};

export async function validateSugar(
  client: PublicClient,
  block: bigint,
  voter: Address,
  ve: Address,
) {
  const [veVoter, sugarVe] = await many<Address>(
    client,
    block,
    [
      callWithAbi(VE_SUGAR, "voter", VE_SUGAR_ABI),
      callWithAbi(VE_SUGAR, "ve", VE_SUGAR_ABI),
    ],
    VE_SUGAR_ABI,
    false,
  );
  if (
    veVoter.toLowerCase() !== voter.toLowerCase() ||
    sugarVe.toLowerCase() !== ve.toLowerCase()
  )
    throw new Error("Aerodrome Sugar deployment mismatch");
}

export async function readVeNfts(
  client: PublicClient,
  block: bigint,
  owners: Address[],
  config?: ReadConfig,
): Promise<SugarVeNft[]> {
  const pages =
    owners.length === 1
      ? [
          await readOne<SugarVeNft[]>(
            client,
            block,
            callWithAbi(VE_SUGAR, "byAccount", VE_SUGAR_ABI, owners[0]),
            VE_SUGAR_ABI,
          ),
        ]
      : await many<SugarVeNft[]>(
          client,
          block,
          owners.map((owner) =>
            callWithAbi(VE_SUGAR, "byAccount", VE_SUGAR_ABI, owner),
          ),
          VE_SUGAR_ABI,
          false,
          config,
        );
  return pages.flat();
}
