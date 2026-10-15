import type { AaveV3UserPosition } from "../sources/v3/types.ts";
import { main as render } from "../../handlebars/render"
// market name -> health factor threshold
export type PositionHFThresholds = Record<string, string | number>;

export async function main(
    positions: AaveV3UserPosition[],
    user?: string,
    thresholds: PositionHFThresholds = {},
    defaultThreshold: string | number = 1.1,
    ignoreEModeEnabledMarkets: boolean = true,
) {
    const hfTooLowPositions = positions.filter((position) => ignoreEModeEnabledMarkets ? !position.eModeEnabled : true)
        .map((position) => ({
            ...position,
            threshold: thresholds[position.marketName] ?? defaultThreshold,
        }))
        .filter((position) => Number(position.healthFactor) < Number(position.threshold));

    if (hfTooLowPositions.length > 0) {
        const desc = await render(TEMPLATE, { hfTooLowPositions, user });
        return {
            description: desc,
            level: "error",
            title: "Aave V3 Health Factor Alert",
        }
    }
    return null;
}

const TEMPLATE = `
{{#if hfTooLowPositions.length}}
{{#if user}}
User: {{user}}
{{/if}}
The following Aave V3 positions have health factors below the specified thresholds:
{{#each hfTooLowPositions}}
- Market: {{marketName}} (Chain: {{chainName}}, Address: {{marketAddress}})
  - Health Factor: {{healthFactor}}
  - Threshold: {{threshold}}
{{/each}}
{{else}}
All Aave V3 positions are above the specified health factor thresholds.
{{/if}}
`;
