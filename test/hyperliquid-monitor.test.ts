import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main } from "../u/oneke/monitors/hyperliquid_liquidation_risk.ts";
import type { Snapshot } from "../f/hyperliquid/sources/account_positions.ts";
import type { CheckResult } from "../f/hyperliquid/rules/liquidation_risk.ts";

const address = "0x1111111111111111111111111111111111111111";
const now = 1_800_000_000_000;
const config = {
  minLiquidationDistance: "0.05",
  maxMarginRiskRatio: "0.8",
  maxSnapshotAgeMs: 60_000,
};
const snapshot: Snapshot = {
  address,
  network: "mainnet",
  accountMode: "disabled",
  startedAt: now,
  completedAt: now,
  positions: [],
  marginData: { dexs: [], spotBalances: null, spotFetchedAt: null },
};
const clear: CheckResult = {
  key: "account:data",
  kind: "data-quality",
  status: "clear",
  metric: null,
  threshold: null,
  reason: "Account data is current",
};
const breach: CheckResult = {
  key: "account:position::BTC:distance",
  kind: "liquidation-distance",
  status: "breach",
  metric: "0.03",
  threshold: "0.05",
  reason: "BTC cross: mark=100, liquidation=97",
};
const unknown: CheckResult = {
  key: "account:position::ETH:distance",
  kind: "liquidation-distance",
  status: "unknown",
  metric: null,
  threshold: "0.05",
  reason: "No liquidation price estimate",
};

async function next(
  completed_steps: Record<string, unknown>,
  network: "mainnet" | "testnet" = "mainnet",
) {
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  let tasks: ReturnType<WorkflowCtx["_flushPending"]> = [];
  await assert.rejects(main(address, config, network), (error: unknown) => {
    assert.ok(error instanceof wmill.StepSuspend);
    tasks = error.dispatchInfo.steps;
    return true;
  });
  assert.equal(tasks.length, 1);
  return tasks[0];
}

test("monitor collects, evaluates with checkpointed time, groups findings and replays without resending", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("workflow must only dispatch tasks");
  });
  const completed_steps: Record<string, unknown> = { evaluated_at: now };
  const source = await next(completed_steps);
  assert.equal(source.script, "f/hyperliquid/sources/account_positions");
  assert.deepEqual(source.args, { address, network: "mainnet" });
  completed_steps[source.key] = snapshot;
  const rule = await next(completed_steps);
  assert.equal(rule.script, "f/hyperliquid/rules/liquidation_risk");
  assert.deepEqual(rule.args, { snapshot, config, evaluatedAt: now });
  const checks = [clear, breach, unknown];
  completed_steps[rule.key] = checks;
  const notification = await next(completed_steps);
  assert.equal(notification.script, "u/oneke/channels/notification");
  assert.equal(notification.dispatch_type, "flow");
  const message = notification.args.message;
  assert.equal(message.level, "error");
  assert.match(message.description, new RegExp(address));
  assert.match(message.description, /BREACH/);
  assert.match(message.description, /UNKNOWN/);
  assert.match(message.description, /0\.03/);
  assert.match(message.description, /0\.05/);
  assert.ok(!message.description.includes(clear.reason));
  completed_steps[notification.key] = { delivered: true };
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  t.mock.method(Date, "now", () => {
    throw new Error("evaluation time must be replayed");
  });
  assert.deepEqual(await main(address, config), checks);
  assert.deepEqual(ctx._flushPending(), []);
});

test("clear checks return without notification", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = { evaluated_at: now };
  const source = await next(completed_steps);
  completed_steps[source.key] = snapshot;
  const rule = await next(completed_steps);
  completed_steps[rule.key] = [clear];
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await main(address, config), [clear]);
  assert.deepEqual(ctx._flushPending(), []);
});

test("unknown-only findings notify rather than appearing healthy", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = { evaluated_at: now };
  const source = await next(completed_steps);
  completed_steps[source.key] = snapshot;
  const rule = await next(completed_steps);
  completed_steps[rule.key] = [unknown];
  const notification = await next(completed_steps);
  assert.equal(notification.args.message.level, "error");
  assert.match(
    notification.args.message.description,
    /No liquidation price estimate/,
  );
});

test("source, evaluation time, rule and notification errors fail the workflow", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = { evaluated_at: now };
  const source = await next(completed_steps);
  completed_steps[source.key] = snapshot;
  const rule = await next(completed_steps);
  completed_steps[rule.key] = [breach];
  const notification = await next(completed_steps);
  const failure = { __wmill_error: true, message: "Task failed" };
  for (const key of [source.key, "evaluated_at", rule.key, notification.key]) {
    wmill.setWorkflowCtx(
      new wmill.WorkflowCtx({
        completed_steps: { ...completed_steps, [key]: failure },
      }),
    );
    await assert.rejects(main(address, config), {
      name: "TaskError",
      message: "Task failed",
    });
  }
});

test("testnet selection reaches the Source", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const source = await next({}, "testnet");
  assert.deepEqual(source.args, { address, network: "testnet" });
});
