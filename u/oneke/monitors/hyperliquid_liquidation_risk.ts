import { step, taskFlow, taskScript, workflow } from "windmill-client";
import type { Snapshot } from "../../../f/hyperliquid/sources/account_positions.ts";
import type {
  CheckResult,
  Config,
} from "../../../f/hyperliquid/rules/liquidation_risk.ts";

const collect = taskScript("f/hyperliquid/sources/account_positions");
const evaluate = taskScript("f/hyperliquid/rules/liquidation_risk");
const notify = taskFlow("u/oneke/channels/notification", { timeout: 600 });

export const main = workflow(
  async (
    address: string,
    config: Config,
    network: "mainnet" | "testnet" = "mainnet",
  ): Promise<CheckResult[]> => {
    const snapshot: Snapshot = await collect({ address, network });
    const evaluatedAt = await step("evaluated_at", () => Date.now());
    const checks: CheckResult[] = await evaluate({
      snapshot,
      config,
      evaluatedAt,
    });
    const findings = checks.filter((check) => check.status !== "clear");
    if (findings.length === 0) return checks;

    const description = [
      `Account: ${snapshot.address}`,
      `Network: ${snapshot.network}`,
      `Evaluated at: ${new Date(evaluatedAt).toISOString()}`,
      "",
      ...findings.map((finding) =>
        [
          `[${finding.status.toUpperCase()}] ${finding.key}`,
          finding.reason,
          `Value: ${finding.metric ?? "unavailable"}; threshold: ${finding.threshold ?? "not applicable"}`,
        ].join("\n"),
      ),
    ].join("\n");
    await notify({
      message: {
        level: "error",
        title: "Hyperliquid liquidation risk",
        description,
      },
    });
    return checks;
  },
);
