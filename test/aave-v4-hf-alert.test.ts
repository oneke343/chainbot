import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main as source } from "../f/aave/sources/v4/users_positions.ts";
import { main as evaluateHF } from "../f/aave/rules/aave_v4_hf.ts";
import { main as monitor } from "../u/oneke/monitors/aave_v4_hf_alert.ts";
import type { AaveV4UserPosition } from "../f/aave/sources/v4/types.ts";
import type { AaveV4UserPositionsQuery } from "../f/aave/lib/v4-types.ts";

const api = { base_url: "https://api.v4.aave.com/graphql" };
const users = ["0xalice", "0xbob"];
const chains = { chains: [{ chainId: 1, name: "Ethereum" }, { chainId: 8453, name: "Base" }] };
const position: AaveV4UserPosition = {
  spokeName: "Main", spokeAddress: "0xspoke", chainId: 1, chainName: "Ethereum",
  healthFactor: "1.05", averageCollateralFactor: "80", totalDebtUsd: "100", totalCollateralUsd: "150",
};

async function nextDispatch(run: () => Promise<unknown>, completed_steps: Record<string, unknown>) {
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  let steps: ReturnType<WorkflowCtx["_flushPending"]> = [];
  await assert.rejects(run(), (error: unknown) => {
    assert.ok(error instanceof wmill.StepSuspend);
    steps = error.dispatchInfo.steps;
    return true;
  });
  return steps;
}

test("V4 source discovers chains and queries users in parallel, preserving zero HF and skipping null HF", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("source must dispatch GraphQL tasks"); });
  const completed_steps: Record<string, unknown> = {};
  const run = () => source(users, api);
  const [discovery] = await nextDispatch(run, completed_steps);
  assert.equal(discovery.script, "f/aave/sources/v4/chains");
  assert.equal(Reflect.get(discovery, "cache_ttl"), 86400);
  assert.deepEqual(discovery.args, { api });
  completed_steps[discovery.key] = chains;
  const queries = await nextDispatch(run, completed_steps);
  assert.equal(queries.length, users.length);
  const results: AaveV4UserPositionsQuery[] = users.map((user, index) => ({ userPositions: [{
    user, healthFactor: { current: index === 0 ? null : "0" },
    averageCollateralFactor: { normalized: "80" },
    totalDebt: { current: { value: index === 0 ? "0" : "100" } }, totalCollateral: { current: { value: "150" } },
    spoke: { name: "Main", address: "0xspoke", chain: { chainId: 1, name: "Ethereum" } },
  }] }));
  for (const [index, query] of queries.entries()) {
    assert.equal(query.script, "f/aave/sources/v4/user_positions");
    assert.equal(query.dispatch_type, "script");
    assert.deepEqual(query.args, { api, user: users[index], chain_ids: [1, 8453] });
    completed_steps[query.key] = results[index];
  }
  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await run(), { [users[0]]: [], [users[1]]: [{ ...position, healthFactor: "0" }] });
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: { [discovery.key]: chains } }));
  assert.deepEqual(await source([], api), {});

  const failure = { __wmill_error: true, message: "GraphQL failed" };
  for (const failed of [
    { [discovery.key]: failure },
    { ...completed_steps, [queries[0].key]: failure },
  ]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: failed }));
    await assert.rejects(run(), { name: "TaskError", message: "GraphQL failed" });
  }
});

test("V4 rule uses chain/Spoke thresholds, renders defaults and excludes healthy or equal HF", async () => {
  const positions = [position, { ...position, chainId: 8453, chainName: "Base" }];
  const before = structuredClone(positions);
  const message = await evaluateHF(positions, users[0], { "Ethereum / Main": "1.2", "Base / Main": 1 });
  assert.ok(message);
  assert.equal(message.level, "error");
  assert.equal(message.title, "Aave V4 Health Factor Alert");
  assert.match(message.description, /User: 0xalice/);
  assert.match(message.description, /Threshold: 1\.2/);
  assert.doesNotMatch(message.description, /Chain: Base/);
  assert.deepEqual(positions, before);
  const fallback = await evaluateHF([position]);
  assert.ok(fallback);
  assert.match(fallback.description, /Threshold: 1\.1/);
  assert.doesNotMatch(fallback.description, /User:/);
  assert.ok(await evaluateHF([{ ...position, healthFactor: "0" }]));
  assert.equal(await evaluateHF([{ ...position, healthFactor: "1.1" }]), null);
  assert.equal(await evaluateHF([]), null);
});

test("V4 rule ignores configured collateral factors at or above the LTV cutoff", async () => {
  for (const averageCollateralFactor of ["90", "95"]) {
    assert.equal(await evaluateHF([{ ...position, averageCollateralFactor }]), null);
  }
  const below = await evaluateHF([{ ...position, averageCollateralFactor: "89.99" }]);
  assert.ok(below);
  assert.match(below.description, /Collateral Factor: 89\.99%/);
  assert.equal(await evaluateHF([position], users[0], {}, 1.1, 80), null);
  assert.ok(await evaluateHF([{ ...position, averageCollateralFactor: "95" }], users[0], {}, 1.1, 96));
});

test("V4 alert evaluates users, checkpoints notifications only for breaches and returns alert messages", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("workflow must only dispatch tasks"); });
  const thresholds = { "Ethereum / Main": "1.2" };
  const run = () => monitor(users, api, thresholds, "1.15", 85);
  const completed_steps: Record<string, unknown> = {};
  const [collection] = await nextDispatch(run, completed_steps);
  assert.equal(collection.script, "f/aave/sources/v4/users_positions");
  assert.deepEqual(collection.args, { users, api });
  completed_steps[collection.key] = {
    [users[0]]: [position], [users[1]]: [{ ...position, healthFactor: "2" }],
  };
  const rules = await nextDispatch(run, completed_steps);
  assert.equal(rules.length, users.length);
  for (const [index, rule] of rules.entries()) {
    assert.equal(rule.script, "f/aave/rules/aave_v4_hf");
    assert.equal(rule.args.user, users[index]);
    assert.deepEqual(rule.args.thresholds, thresholds);
    assert.equal(rule.args.defaultThreshold, "1.15");
    assert.equal(rule.args.ltvThreshold, 85);
    assert.equal("ignoreEModeEnabledMarkets" in rule.args, false);
    completed_steps[rule.key] = await evaluateHF(
      rule.args.positions, rule.args.user, rule.args.thresholds, rule.args.defaultThreshold, rule.args.ltvThreshold,
    );
  }
  const notifications = await nextDispatch(run, completed_steps);
  assert.equal(notifications.length, 1);
  const [notification] = notifications;
  assert.equal(notification.script, "u/oneke/channels/notification");
  assert.equal(notification.dispatch_type, "flow");
  assert.equal(Reflect.get(notification, "timeout"), 600);
  assert.deepEqual(notification.args, { message: completed_steps[rules[0].key] });
  const alerts = [completed_steps[rules[0].key]];
  completed_steps[notification.key] = { delivered: true };
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await run(), alerts);
  assert.deepEqual(ctx._flushPending(), []);

  for (const noAlerts of [
    { ...completed_steps, [rules[0].key]: null },
    { [collection.key]: {} },
  ]) {
    const healthy = new wmill.WorkflowCtx({ completed_steps: noAlerts });
    wmill.setWorkflowCtx(healthy);
    assert.deepEqual(await run(), []);
    assert.deepEqual(healthy._flushPending(), []);
  }
  const failure = { __wmill_error: true, message: "Task failed" };
  for (const key of [collection.key, rules[0].key, notification.key]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: { ...completed_steps, [key]: failure } }));
    await assert.rejects(run(), { name: "TaskError", message: "Task failed" });
  }
});
