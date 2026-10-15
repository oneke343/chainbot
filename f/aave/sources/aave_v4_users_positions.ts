import { taskScript, workflow } from "windmill-client";
import type { AaveV4UserPosition } from "./types.ts";
import type { AaveV4ChainsQuery, AaveV4UserPositionsQuery } from "../lib/v4-types.ts";

const queryChains = taskScript("f/aave/scripts/sources/aave_v4_chains", { cache_ttl: 60 * 60 * 24 });
const queryUserPositions = taskScript("f/aave/scripts/sources/aave_v4_user_positions");

export const main = workflow(async (
    users: string[],
    api: RT.Graphql,
): Promise<Record<string, AaveV4UserPosition[]>> => {
    const { chains }: AaveV4ChainsQuery = await queryChains({ api });
    const results: AaveV4UserPositionsQuery[] = await Promise.all(users.map((user) => queryUserPositions({
        api, user, chain_ids: chains.map((chain) => chain.chainId),
    })));

    return Object.fromEntries(results.map((result, index) => [
        users[index],
        result.userPositions.flatMap((position) => position.healthFactor.current === null ? [] : [{
            spokeName: position.spoke.name,
            spokeAddress: position.spoke.address,
            chainId: position.spoke.chain.chainId,
            chainName: position.spoke.chain.name,
            healthFactor: position.healthFactor.current,
            averageCollateralFactor: position.averageCollateralFactor.normalized,
            totalDebtUsd: position.totalDebt.current.value,
            totalCollateralUsd: position.totalCollateral.current.value,
        }]),
    ]));
});
