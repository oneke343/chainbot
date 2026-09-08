//native

import { normalizeMonitorOutput } from "../../lib/monitor-state.ts";

export type AlertDecision = {
  message?: RT.AlertMessage;
};

export async function main(
  monitor_output: RT.MonitorOutput,
  severity: "info" | "warning" | "critical" = "warning",
): Promise<AlertDecision> {
  const output = normalizeMonitorOutput(monitor_output);
  if (!["info", "warning", "critical"].includes(severity)) {
    throw new Error("severity must be info, warning, or critical");
  }

  return output.matched && output.message
    ? {
      message: {
        title: output.message.title,
        description: output.message.description,
        severity,
        fields: structuredClone(output.fields),
      },
    }
    : {};
}
