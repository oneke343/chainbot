import type { AaveV4UserPosition } from "../sources/v4/types.ts";
import { main as render } from "../../handlebars/render.ts";

export async function main(
    positions: AaveV4UserPosition[],
    user?: string,
    thresholds: Record<string, string | number> = {},
    defaultThreshold: string | number = 1.1,
    ltvThreshold: number = 90,
) {
    const hfTooLowPositions = positions
        .filter((position) => Number(position.averageCollateralFactor) < ltvThreshold)
        .map((position) => ({
            ...position,
            threshold: thresholds[`${position.chainName} / ${position.spokeName}`] ?? defaultThreshold,
        }))
        .filter((position) => Number(position.healthFactor) < Number(position.threshold));

    if (hfTooLowPositions.length > 0) {
        return {
            description: await render(TEMPLATE, { hfTooLowPositions, user }),
            level: "error",
            title: "Aave V4 Health Factor Alert",
        };
    }
    return null;
}

const TEMPLATE = `
{{#if user}}
User: {{user}}
{{/if}}
The following Aave V4 positions have health factors below the specified thresholds:
{{#each hfTooLowPositions}}
- Spoke: {{spokeName}} (Chain: {{chainName}}, Address: {{spokeAddress}})
  - Health Factor: {{healthFactor}}
  - Collateral Factor: {{averageCollateralFactor}}%
  - Threshold: {{threshold}}
{{/each}}
`;
