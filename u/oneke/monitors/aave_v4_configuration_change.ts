// The Bun runner initializes the checkpoint context required by workflow().
import { taskScript, taskFlow, workflow, type CompletedJob } from "windmill-client";
import type { JsonObject, } from "../../../f/chain_sentinel/lib/jsondiff.ts";

const sourcePath = "u/oneke/sources/aave_v4_configuration";
const previous = taskScript("f/chain_sentinel/sources/previous");
const current = taskFlow(sourcePath, { timeout: 600 });
const diff = taskScript("f/chain_sentinel/rules/diff");
const handlebarsRender = taskScript("f/handlebars/render");
const notificationFlow = taskFlow("u/oneke/channels/notification", { timeout: 600 });

const TEMPLATE = `
{{#if patch.length}}
  {{#each patch}}
    {{#if (eq this.op "add")}}
      Added {{this.path}}: {{this.value}}
    {{/if}}
    {{#if (eq this.op "remove")}}
      Removed {{this.path}}: {{this.oldValue}}
    {{/if}}
    {{#if (eq this.op "replace")}}
      Replaced {{this.path}}: {{this.oldValue}} -> {{this.value}}
    {{/if}}
  {{/each}}
{{else}}
  No changes detected.
{{/if}}
`;
export const main = workflow(async () => {
  const previousJob: CompletedJob | null = await previous({ source_path: sourcePath });
  const currentValue: JsonObject = await current({});
  const patch = previousJob ? await diff({ before: previousJob.result, after: currentValue }) : [];
  if (patch.length === 0) {
    return;
  }
  const desc = await handlebarsRender({ template: TEMPLATE, context: { patch } });

  await notificationFlow({
    message: {
      level: "info",
      title: "Aave v4 configuration change detected",
      description: desc,
    }
  });
});
