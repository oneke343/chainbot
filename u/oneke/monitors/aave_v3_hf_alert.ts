import { taskScript, taskFlow, workflow } from "windmill-client";
import type { AaveV3UserPosition } from "../../../f/aave/sources/v3/types.ts";
import type { main as evaluateHF, PositionHFThresholds } from "../../../f/aave/rules/aave_v3_hf.ts";

type Alert = NonNullable<Awaited<ReturnType<typeof evaluateHF>>>;

const collectPositions = taskScript("f/aave/sources/v3/users_positions");
const evaluateHealthFactor = taskScript("f/aave/rules/aave_v3_hf");
const notify = taskFlow("u/oneke/channels/notification", { timeout: 600 });

export const main = workflow(async (
    users: string[],
    api: RT.Graphql,
    thresholds: PositionHFThresholds = {},
    defaultThreshold: string | number = 1.1,
    ignoreEModeEnabledMarkets: boolean = true,
): Promise<Alert[]> => {
    const positionsByUser: Record<string, AaveV3UserPosition[]> = await collectPositions({ users, api });
    const messages: Awaited<ReturnType<typeof evaluateHF>>[] = await Promise.all(
        Object.entries(positionsByUser).map(([user, positions]) => evaluateHealthFactor({
            positions, user, thresholds, defaultThreshold, ignoreEModeEnabledMarkets,
        }))
    );
    const alerts = messages.filter((message) => message !== null);
    await Promise.all(alerts.map((message) => notify({ message })));
    return alerts;
});
