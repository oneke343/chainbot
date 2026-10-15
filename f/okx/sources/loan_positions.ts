import { createHmac } from "node:crypto";

type LoanAsset = { ccy: string; amt: string };

export type FlexibleLoanPosition = {
  ordId: string;
  collateralData: LoanAsset[];
  collateralNotionalUsd: string;
  curLTV: string;
  liqLTV: string;
  loanData: LoanAsset[];
  loanNotionalUsd: string;
  marginCallLTV: string;
  riskWarningData: { instId: string; liqPx: string };
};

export async function main(connection: RT.COkx, order_id?: string) {
  const url = new URL("/api/v5/finance/flexible-loan/loan-info", connection.url);
  if (order_id) url.searchParams.set("ordId", order_id);
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", connection.api_secret)
    .update(timestamp + "GET" + url.pathname + url.search)
    .digest("base64");

  const response = await fetch(url.href, {
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": connection.api_key,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": connection.passphrase,
    },
  });
  if (!response.ok) throw new Error(`OKX Flexible Loans (${response.status}): ${await response.text()}`);
  const result: { code: string; msg: string; data: FlexibleLoanPosition[] } = await response.json();
  if (result.code !== "0") throw new Error(`OKX Flexible Loans (${result.code}): ${result.msg}`);
  return { positions: result.data };
}
