// The Bun runner initializes the checkpoint context required by workflow().
import {
  taskScript,
  taskFlow,
  workflow,
  type CompletedJob,
} from "windmill-client";
import type { JsonObject } from "../../../f/chain_sentinel/lib/jsondiff.ts";
import { renderJsonDiff } from "../../../f/chain_sentinel/lib/jsondiff.ts";

const sourcePath = "u/oneke/sources/aave_v3_configuration";
const previous = taskScript("f/chain_sentinel/sources/previous");
const current = taskFlow(sourcePath, { timeout: 180 });
const diff = taskScript("f/chain_sentinel/rules/diff");
const notificationFlow = taskFlow("u/oneke/channels/notification", {
  timeout: 600,
});

export const main = workflow(async () => {
  const previousJob: CompletedJob | null = await previous({
    source_path: sourcePath,
  });
  const currentValue: JsonObject = await current({});
  const patch = previousJob
    ? await diff({ before: previousJob.result, after: currentValue })
    : [];
  if (patch.length === 0) return;

  await notificationFlow({
    message: {
      level: "info",
      title: "Aave v3 configuration snapshot changed",
      description: `${renderJsonDiff(patch)}\n\n比例 1=100%；debtCeilingUsd 单位为 USD，其余金额单位为 token；变化来自 API 两次采样。`,
    },
  });
});
