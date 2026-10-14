import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { OpenFlow } from "windmill-client";
import { main as sendFlashduty } from "../f/chain_sentinel/scripts/destinations/send_flashduty.ts";

const flow: OpenFlow = JSON.parse(execFileSync("bun", ["-e",
  "console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))",
], {
  input: readFileSync(new URL("../u/oneke/channels/notification__flow/flow.yaml", import.meta.url)),
  encoding: "utf8",
}));
const routes = flow.value.modules[0].value;
assert.ok(routes.type === "branchall");
const telegramModule = routes.branches[0].modules[0];
const flashdutyModule = routes.branches[1].modules[0];
assert.ok(telegramModule.value.type === "script");
assert.ok(flashdutyModule.value.type === "script");
const telegram = telegramModule.value;
const flashduty = flashdutyModule.value;
const text = telegram.input_transforms.text;
const messages = flashduty.input_transforms.messages;
assert.ok(text.type === "javascript");
assert.ok(messages.type === "javascript");
assert.ok(flashdutyModule.skip_if);
const textExpression = text.expr;
const messagesExpression = messages.expr;
const skipExpression = flashdutyModule.skip_if.expr;

for (const level of ["info", "warning", "error"]) {
  test(`${level} routes to Telegram${level === "error" ? " and FlashDuty" : " only"}`, () => {
    const message = { level, title: "Configuration changed", description: "cap: 100 -> 200" };
    const context = { flow_input: { message } };
    assert.equal(telegramModule.skip_if, undefined);
    assert.equal(runInNewContext(textExpression, context), `[${level}] ${message.title}\n\n${message.description}`);
    assert.equal(runInNewContext(skipExpression, context), level !== "error");
  });
}

test("Telegram uses the verified Hub integration and existing channel resources", () => {
  assert.equal(telegram.path, "hub/28512/telegram/send_a_text_message_or_reply");
  assert.deepEqual(telegram.input_transforms.auth, { type: "static", value: "$res:u/oneke/yeap-bot" });
  assert.deepEqual(telegram.input_transforms.chat_id, {
    type: "javascript", expr: 'variable("u/oneke/channels/telegram_chat_id")',
  });
  assert.deepEqual(flashduty.input_transforms.destination, { type: "static", value: "$res:u/oneke/flashcat" });
});

test("error messages become Critical FlashDuty events with original content", async (t) => {
  const message = { level: "error", title: "Configuration changed", description: "cap: 100 -> 200" };
  const alerts: Parameters<typeof sendFlashduty>[1] = runInNewContext(messagesExpression, { flow_input: { message } });
  assert.deepEqual(JSON.parse(JSON.stringify(alerts)), [{
    title: message.title, description: message.description,
    severity: "critical", fields: { level: "error" },
  }]);
  let deliveries = 0;
  t.mock.method(globalThis, "fetch", async (url: URL | RequestInfo, init?: RequestInit) => {
    deliveries++;
    assert.equal(new URL(String(url)).searchParams.get("integration_key"), "test-key");
    assert.equal(init?.method, "POST");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.event_status, "Critical");
    assert.equal(payload.title_rule, message.title);
    assert.equal(payload.description, message.description);
    assert.deepEqual(payload.labels, { level: "error", severity: "critical" });
    return new Response(JSON.stringify({ request_id: "test-delivery", data: { alert_key: "test-alert" } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  const result = await sendFlashduty({ url: "https://flashduty.example.test/alerts", integration_key: "test-key" }, alerts);
  assert.equal(deliveries, 1);
  assert.equal(result?.delivered, 1);
});

test("channel branches run independently and report failures", () => {
  assert.equal(routes.parallel, true);
  assert.equal(routes.branches.length, 2);
  for (const branch of routes.branches) assert.equal(branch.skip_failure, false);
  assert.doesNotMatch(skipExpression, /results\./);
  assert.doesNotMatch(messagesExpression, /results\./);
});
