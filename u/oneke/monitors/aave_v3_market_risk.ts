// The Bun runner initializes the checkpoint context required by workflow().
import { taskScript, taskFlow, workflow, type CompletedJob } from "windmill-client";
import type { ReserveSnapshot } from "../../../f/aave/sources/v3/market_metrics.ts";
import { DEFAULT_CONFIG, renderNotifications, type Finding, type RiskConfig } from "../../../f/aave/rules/aave_v3_market_risk.ts";

const sourcePath = "u/oneke/sources/aave_v3_market_metrics";
const collectMetrics = taskFlow(sourcePath, { timeout: 180 });
const readHistory = taskScript("f/chain_sentinel/sources/history");
const evaluateRisk = taskScript("f/aave/rules/aave_v3_market_risk");
const notify = taskFlow("u/oneke/channels/notification", { timeout: 600 });

export const main = workflow(async (config: RiskConfig = DEFAULT_CONFIG): Promise<Finding[]> => {
  const current: ReserveSnapshot = await collectMetrics({});
  const jobs: (CompletedJob & { result: ReserveSnapshot })[] = await readHistory({
    source_path: sourcePath,
    started_after: new Date(Date.parse(current.sampledAt) - 30 * 60_000).toISOString(),
    started_before: current.sampledAt,
  });
  const history: ReserveSnapshot[] = jobs.map((job) => job.result);
  const findings: Finding[] = await evaluateRisk({ current, history, config });
  for (const message of renderNotifications(findings, current, history)) await notify({ message });
  return findings;
});
