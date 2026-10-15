import { taskScript, workflow } from "windmill-client";
import type { MorphoUserPosition } from "./types.ts";
import type { MorphoUsersPositionsQuery } from "../lib/types.ts";

const queryUserPositions = taskScript("./user_positions.gql");

export const main = workflow(async (
    users: string[],
    api: RT.Graphql,
): Promise<Record<string, MorphoUserPosition[]>> => {
    const positionsByAddress: Record<string, MorphoUserPosition[]> = Object.fromEntries(
        users.map((user) => [user.toLowerCase(), []]),
    );
    if (users.length === 0) return {};

    let skip = 0;
    while (true) {
        const { marketPositions }: MorphoUsersPositionsQuery = await queryUserPositions({ api, users, skip });
        const { items, pageInfo } = marketPositions;
        if (items === null || pageInfo === null) {
            throw new Error("Incomplete Morpho positions: missing items or page info");
        }
        if (items.length === 0 && skip < pageInfo.countTotal) {
            throw new Error("Incomplete Morpho positions: pagination returned an empty page");
        }
        for (const { user, healthFactor, market } of items) {
            if (healthFactor === null || market.collateralAsset === null) {
                throw new Error(`Missing Morpho borrowing position data for ${user.address} in ${market.marketId}`);
            }
            const lltvPercent = Number(market.lltv) / 1e16;
            positionsByAddress[user.address.toLowerCase()].push({
                marketId: market.marketId,
                marketName: `${market.collateralAsset.symbol}-${market.loanAsset.symbol} / LLTV ${lltvPercent}%`,
                chainId: market.chain.id,
                chainName: market.chain.network,
                healthFactor,
                lltvPercent,
            });
        }
        skip += items.length;
        if (skip >= pageInfo.countTotal) break;
    }
    return Object.fromEntries(users.map((user) => [user, positionsByAddress[user.toLowerCase()]]));
});
