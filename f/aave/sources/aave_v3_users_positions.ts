import { taskScript, workflow } from "windmill-client";
import type { AaveV3UserPosition } from "./types.ts";
import type { AaveMarketPositionsQuery } from "../v3.types.ts";

// Relative module references include the packaged file's extension.
const queryUserPositions = taskScript("./aave_v3_user_positions.gql");
const queryAaveV3Chains = taskScript("f/aave/sources/aave_v3_chains", { cache_ttl: 60 * 60 * 24 }); // Cache for 1 day
export const main = workflow(async (
    users: string[],
    api: RT.Graphql,
): Promise<Record<string, AaveV3UserPosition[]>> => {
    const { chains } = await queryAaveV3Chains({ api });
    const results: AaveMarketPositionsQuery[] = await Promise.all(users.map((user) => queryUserPositions({
        api, user, chainIds: chains.map((chain) => chain.chainId),
    })));

    return users.reduce((acc, user, index) => {
        const userPositions: AaveV3UserPosition[] = results[index].markets
            .filter(market => !!market.userState?.healthFactor)
            .map((market) => ({
                marketName: market.name,
                marketAddress: market.address,
                chainId: market.chain.chainId,
                chainName: market.chain.name,
                eModeEnabled: market.userState.eModeEnabled,
                healthFactor: market.userState.healthFactor,
                totalDebtBase: market.userState.totalDebtBase,
                totalCollateralBase: market.userState.totalCollateralBase,
            }));
        acc[user] = userPositions;
        return acc;
    }, {} as Record<string, AaveV3UserPosition[]>);
});
