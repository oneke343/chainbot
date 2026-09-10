import { parseAbi, type Address } from "viem";

export const BASE_CHAIN_ID = 8453;
export const VOTER =
  "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" as Address;
export const VE = "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4" as Address;
export const DEFAULT_EXECUTOR_BATCH_SIZE = 16;

export const ABI = parseAbi([
  "function ve() view returns (address)",
  "function voter() view returns (address)",
  "function ownerOf(uint256) view returns (address)",
  "function balanceOfNFT(uint256) view returns (uint256)",
  "function lastVoted(uint256) view returns (uint256)",
  "function epochStart(uint256) view returns (uint256)",
  "function epochVoteStart(uint256) view returns (uint256)",
  "function epochVoteEnd(uint256) view returns (uint256)",
  "function maxVotingNum() view returns (uint256)",
  "function votes(uint256,address) view returns (uint256)",
]);

export const VOTE_EXECUTOR_ABI = parseAbi([
  "function voteMany(uint256[],address[][],uint256[][])",
  "function admin() view returns (address)",
  "function transferAdmin(address)",
  "function recoverERC20(address,address,uint256)",
  "function recoverETH(address,uint256)",
  "function AERODROME_VOTER() view returns (address)",
]);
