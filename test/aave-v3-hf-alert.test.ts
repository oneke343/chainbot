import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main } from "../u/oneke/monitors/aave_v3_hf_alert.ts";
import type { AaveV3UserPosition } from "../f/aave/sources/v3/types.ts";

const users = ["0xalice", "0xbob", "0xcarol"];
const api = { base_url: "https://api.v3.aave.com/graphql" };
const thresholds = { Main: "1.2" };
const position: AaveV3UserPosition = {
  marketName: "Main", marketAddress: "0xmarket", chainId: 1, chainName: "Ethereum",
  eModeEnabled: false, healthFactor: "1.05", totalDebtBase: "1", totalCollateralBase: "2",
};
const positions = Object.fromEntries(users.map((user) => [user, [{ ...position }]]));

async function nextDispatch(completed_steps: Record<string, unknown>) {
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  let steps: ReturnType<WorkflowCtx["_flushPending"]> = [];
  await assert.rejects(main(users, api, thresholds, "1.15", false), (error: unknown) => {
    assert.ok(error instanceof wmill.StepSuspend);
    steps = error.dispatchInfo.steps;
    return true;
  });
  return steps;
}

test("HF alert collects once, evaluates each user and notifies only non-null results", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("workflow body must only dispatch tasks"); });
  const completed_steps: Record<string, unknown> = {};
  const [source] = await nextDispatch(completed_steps);
  assert.equal(source.script, "f/aave/sources/v3/users_positions");
  assert.equal(source.dispatch_type, "script");
  assert.deepEqual(source.args, { users, api });
  completed_steps[source.key] = positions;

  const rules = await nextDispatch(completed_steps);
  assert.equal(rules.length, users.length);
  assert.equal(new Set(rules.map((rule) => rule.key)).size, users.length);
  for (const [index, rule] of rules.entries()) {
    assert.equal(rule.script, "f/aave/rules/aave_v3_hf");
    assert.equal(rule.dispatch_type, "script");
    assert.deepEqual(rule.args, {
      positions: positions[users[index]], user: users[index], thresholds,
      defaultThreshold: "1.15", ignoreEModeEnabledMarkets: false,
    });
  }
  const alerts = [users[0], users[2]].map((user) => ({
    level: "error", title: "Aave V3 Health Factor Alert", description: `User: ${user}`,
  }));
  completed_steps[rules[0].key] = alerts[0];
  completed_steps[rules[1].key] = null;
  completed_steps[rules[2].key] = alerts[1];

  const notifications = await nextDispatch(completed_steps);
  assert.equal(notifications.length, 2);
  for (const [index, notification] of notifications.entries()) {
    assert.equal(notification.script, "u/oneke/channels/notification");
    assert.equal(notification.dispatch_type, "flow");
    assert.equal(Reflect.get(notification, "timeout"), 600);
    assert.deepEqual(notification.args, { message: alerts[index] });
    completed_steps[notification.key] = { delivered: true };
  }
  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await main(users, api, thresholds, "1.15", false), alerts);
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
});

test("healthy users and empty source results return no alerts or notification jobs", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = {};
  const [source] = await nextDispatch(completed_steps);
  completed_steps[source.key] = positions;
  const rules = await nextDispatch(completed_steps);
  for (const rule of rules) completed_steps[rule.key] = null;
  for (const results of [completed_steps, { [source.key]: {} }]) {
    const ctx = new wmill.WorkflowCtx({ completed_steps: results });
    wmill.setWorkflowCtx(ctx);
    assert.deepEqual(await main(users, api, thresholds, "1.15", false), []);
    assert.deepEqual(ctx._flushPending(), []);
  }
});

test("source, rule and notification errors propagate", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const failure = { __wmill_error: true, message: "Task failed" };
  const [source] = await nextDispatch({});
  const rules = await nextDispatch({ [source.key]: positions });
  const ruleResults = Object.fromEntries(rules.map((rule) => [rule.key, null]));
  const alert = { level: "error", title: "Alert", description: "Low HF" };
  const withAlert = { [source.key]: positions, ...ruleResults, [rules[0].key]: alert };
  const [notification] = await nextDispatch(withAlert);
  for (const completed_steps of [
    { [source.key]: failure },
    { [source.key]: positions, ...ruleResults, [rules[0].key]: failure },
    { ...withAlert, [notification.key]: failure },
  ]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
    await assert.rejects(main(users, api, thresholds, "1.15", false), {
      name: "TaskError", message: "Task failed",
    });
  }
});
