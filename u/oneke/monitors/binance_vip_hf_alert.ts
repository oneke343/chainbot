import { taskScript, taskFlow, workflow } from "windmill-client";
import type { main as source } from "../../../f/binance/sources/vip_loan_positions.ts";
import type { main as evaluateHF } from "../../../f/binance/rules/hf.ts";

const collectPositions = taskScript("f/binance/sources/vip_loan_positions");
const evaluateHealthFactor = taskScript("f/binance/rules/hf");
const notify = taskFlow("u/oneke/channels/notification", { timeout: 600 });

export const main = workflow(async (
  connection: RT.CBinance,
  thresholds: Record<string, string | number> = {},
  defaultThreshold: string | number = 1.2,
): Promise<NonNullable<Awaited<ReturnType<typeof evaluateHF>>>[]> => {
  const { positions }: Awaited<ReturnType<typeof source>> = await collectPositions({ connection });
  const message: Awaited<ReturnType<typeof evaluateHF>> = await evaluateHealthFactor({
    positions, thresholds, defaultThreshold,
  });
  if (message === null) return [];
  await notify({ message });
  return [message];
});
