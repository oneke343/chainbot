import type { FlexibleLoanPosition } from "../sources/loan_positions.ts";
import { main as render } from "../../handlebars/render.ts";

export async function main(
  positions: FlexibleLoanPosition[],
  thresholds: Record<string, string | number> = {},
  defaultThreshold: string | number = 1.2,
) {
  const hfTooLowPositions = positions.map((position) => ({
    ...position,
    healthFactor: Number(position.liqLTV) / Number(position.curLTV),
    ltvPercent: (Number(position.curLTV) * 100).toFixed(2),
    marginCallLTVPercent: (Number(position.marginCallLTV) * 100).toFixed(2),
    liquidationLTVPercent: (Number(position.liqLTV) * 100).toFixed(2),
    threshold: thresholds[position.ordId] ?? defaultThreshold,
  })).filter((position) => position.healthFactor < Number(position.threshold));

  if (hfTooLowPositions.length === 0) return null;
  return {
    description: await render(TEMPLATE, { hfTooLowPositions }),
    level: "error",
    title: "OKX Flexible Loan Health Factor Alert",
  };
}

const TEMPLATE = `
The following OKX Flexible Loans have health factors below the specified thresholds:
{{#each hfTooLowPositions}}
- Order: {{ordId}}
  - Loans:
{{#each loanData}}
    - {{amt}} {{ccy}}
{{/each}}
  - Collateral:
{{#each collateralData}}
    - {{amt}} {{ccy}}
{{/each}}
  - Loan Value: {{loanNotionalUsd}} USD
  - Adjusted Collateral Value: {{collateralNotionalUsd}} USD
  - LTV: {{ltvPercent}}%
  - Margin Call LTV: {{marginCallLTVPercent}}%
  - Liquidation LTV: {{liquidationLTVPercent}}%
  - Health Factor: {{healthFactor}}
  - Threshold: {{threshold}}
{{/each}}
`;
