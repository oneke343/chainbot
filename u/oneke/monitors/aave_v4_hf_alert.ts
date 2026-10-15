import { taskScript, taskFlow, workflow } from "windmill-client";
import type { AaveV4UserPosition } from "../../../f/aave/sources/types.ts";
import type { main as evaluateHF } from "../../../f/aave/rules/aave_v4_hf.ts";

type Alert = NonNullable<Awaited<ReturnType<typeof evaluateHF>>>;

const collectPositions = taskScript("f/aave/sources/aave_v4_users_positions");
const evaluateHealthFactor = taskScript("f/aave/rules/aave_v4_hf");
const notify = taskFlow("u/oneke/channels/notification", { timeout: 600 });

export const main = workflow(async (
    users: string[],
    api: RT.Graphql,
    thresholds: Record<string, string | number> = {},
    defaultThreshold: string | number = 1.1,
    ltvThreshold: number = 90,
): Promise<Alert[]> => {
    const positionsByUser: Record<string, AaveV4UserPosition[]> = await collectPositions({ users, api });
    const messages: Awaited<ReturnType<typeof evaluateHF>>[] = await Promise.all(
        Object.entries(positionsByUser).map(([user, positions]) => evaluateHealthFactor({
            positions, user, thresholds, defaultThreshold, ltvThreshold,
        }))
    );
    const alerts = messages.filter((message) => message !== null);
    await Promise.all(alerts.map((message) => notify({ message })));
    return alerts;
});
