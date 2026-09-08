//native

import { normalizeMonitorOutput } from "../../lib/monitor-state.ts";

export type AlertDecision = {
  messages: RT.AlertMessage[];
};

export async function main(
  monitor_output: RT.MonitorOutput,
  severity: "info" | "warning" | "critical" = "warning",
): Promise<AlertDecision> {
  const output = normalizeMonitorOutput(monitor_output);
  if (!["info", "warning", "critical"].includes(severity)) {
    throw new Error("severity must be info, warning, or critical");
  }

  return {
    messages: output.matched
      ? output.messages.map((message) => ({
        title: message.title,
        description: message.description,
        severity,
        fields: {
          ...structuredClone(output.fields),
          ...(message.fields ? structuredClone(message.fields) : {}),
        },
      }))
      : [],
  };
}
