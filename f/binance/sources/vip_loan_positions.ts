import { createHmac } from "node:crypto";
import { setTimeout } from "node:timers/promises";

export type VipLoanPosition = {
  orderId: string;
  loanCoin: string;
  totalDebt: string;
  loanRate: string;
  residualInterest: string;
  collateralAccountId: string;
  collateralCoin: string;
  totalCollateralValueAfterHaircut: string;
  lockedCollateralValue: string;
  currentLTV: string;
  expirationTime: number;
  loanDate: string;
  loanTerm: string;
};

export async function main(
  connection: RT.Binance,
  loan_coin?: string,
  collateral_coin?: string,
) {
  const positions: VipLoanPosition[] = [];

  for (let current = 1; ; current += 1) {
    if (current > 1) await setTimeout(1000);

    const query = new URLSearchParams({
      current: String(current),
      limit: "100",
      recvWindow: "5000",
      timestamp: String(Date.now()),
    });
    if (loan_coin) query.set("loanCoin", loan_coin);
    if (collateral_coin) query.set("collateralCoin", collateral_coin);
    query.set("signature", createHmac("sha256", connection.api_secret).update(query.toString()).digest("hex"));

    const url = new URL("/sapi/v1/loan/vip/ongoing/orders", connection.url);
    url.search = query.toString();
    const response = await fetch(url.href, {
      headers: { "X-MBX-APIKEY": connection.api_key },
    });
    if (!response.ok) throw new Error(`Binance VIP loans (${response.status}): ${await response.text()}`);

    const page: { rows: VipLoanPosition[]; total: number } = JSON.parse(
      await response.text(),
      // Binance returns int64 order IDs as JSON numbers, beyond Number precision.
      (key: string, value: unknown, context?: { source: string }) =>
        key === "orderId" && typeof value === "number" ? context.source : value,
    );
    positions.push(...page.rows);
    if (positions.length >= page.total) break;
  }

  return { positions };
}
