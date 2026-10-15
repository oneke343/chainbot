import type { VipLoanPosition } from "../sources/vip_loan_positions.ts";
import { main as render } from "../../handlebars/render.ts";

export async function main(
  positions: VipLoanPosition[],
  thresholds: Record<string, string | number> = {},
  defaultThreshold: string | number = 1.2,
) {
  const hfTooLowPositions = positions.map((position) => ({
    ...position,
    healthFactor: Number(position.liquidationLtv.replace("%", "")) / 100 / Number(position.currentLTV),
    ltvPercent: Number(position.currentLTV) * 100,
    threshold: thresholds[position.collateralAccountId] ?? defaultThreshold,
  })).filter((position) => position.healthFactor < Number(position.threshold));

  if (hfTooLowPositions.length === 0) return null;
  return {
    description: await render(TEMPLATE, { hfTooLowPositions }),
    level: "error",
    title: "Binance VIP Loan Health Factor Alert",
  };
}

const TEMPLATE = `
The following Binance VIP loans have health factors below the specified thresholds:
{{#each hfTooLowPositions}}
- Order: {{orderId}}
  - Loan: {{totalDebt}} {{loanCoin}}
  - Collateral Accounts: {{collateralAccountId}}
  - Collateral Assets: {{collateralCoin}}
  - LTV: {{ltvPercent}}%
  - Margin Call LTV: {{marginCallLtv}}
  - Liquidation LTV: {{liquidationLtv}}
  - Health Factor: {{healthFactor}}
  - Threshold: {{threshold}}
{{/each}}
`;
