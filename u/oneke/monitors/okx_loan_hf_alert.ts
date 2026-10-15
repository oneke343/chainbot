import { taskScript, taskFlow, workflow } from "windmill-client";
import type { main as source } from "../../../f/okx/sources/loan_positions.ts";
import type { main as evaluateHF } from "../../../f/okx/rules/hf.ts";

const collectPositions = taskScript("f/okx/sources/loan_positions");
const evaluateHealthFactor = taskScript("f/okx/rules/hf");
const notify = taskFlow("u/oneke/channels/notification", { timeout: 600 });

export const main = workflow(async (
  connection: RT.COkx,
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
