import type { MorphoUserPosition } from "../sources/types.ts";
import { main as render } from "../../handlebars/render.ts";

export async function main(
    positions: MorphoUserPosition[],
    user?: string,
    thresholds: Record<string, string | number> = {},
    defaultThreshold: string | number = 1.1,
    ltvThreshold: number = 90,
) {
    const hfTooLowPositions = positions.filter((position) => position.lltvPercent < ltvThreshold).map((position) => ({
        ...position,
        threshold: thresholds[`${position.chainId}:${position.marketId}`] ?? defaultThreshold,
    })).filter((position) => position.healthFactor < Number(position.threshold));

    if (hfTooLowPositions.length === 0) return null;
    return {
        description: await render(TEMPLATE, { hfTooLowPositions, user }),
        level: "error",
        title: "Morpho Health Factor Alert",
    };
}

const TEMPLATE = `
{{#if user}}
User: {{user}}
{{/if}}
The following Morpho positions have health factors below the specified thresholds:
{{#each hfTooLowPositions}}
- Market: {{marketName}} (Chain: {{chainName}}, ID: {{marketId}})
  - Health Factor: {{healthFactor}}
  - LLTV: {{lltvPercent}}%
  - Threshold: {{threshold}}
{{/each}}
`;
