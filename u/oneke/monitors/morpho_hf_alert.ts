import { taskScript, taskFlow, workflow } from "windmill-client";
import type { MorphoUserPosition } from "../../../f/morpho/sources/types.ts";
import type { main as evaluateHF } from "../../../f/morpho/rules/hf.ts";

type Alert = NonNullable<Awaited<ReturnType<typeof evaluateHF>>>;

const collectPositions = taskScript("f/morpho/sources/users_positions");
const evaluateHealthFactor = taskScript("f/morpho/rules/hf");
const notify = taskFlow("u/oneke/channels/notification", { timeout: 600 });

export const main = workflow(async (
    users: string[],
    api: RT.Graphql,
    thresholds: Record<string, string | number> = {},
    defaultThreshold: string | number = 1.1,
    ltvThreshold: number = 90,
): Promise<Alert[]> => {
    const positionsByUser: Record<string, MorphoUserPosition[]> = await collectPositions({ users, api });
    const messages: Awaited<ReturnType<typeof evaluateHF>>[] = await Promise.all(
        Object.entries(positionsByUser).map(([user, positions]) => evaluateHealthFactor({
            positions, user, thresholds, defaultThreshold, ltvThreshold,
        }))
    );
    const alerts = messages.filter((message) => message !== null);
    await Promise.all(alerts.map((message) => notify({ message })));
    return alerts;
});
