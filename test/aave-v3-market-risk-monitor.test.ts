import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main as monitor } from "../u/oneke/monitors/aave_v3_market_risk.ts";
import {
  main as evaluate,
  DEFAULT_CONFIG,
} from "../f/aave/rules/aave_v3_market_risk.ts";
import { decimal, reserve, snapshot } from "./fixtures/aave-v3-reserves.ts";

async function next(completed_steps: Record<string, unknown>) {
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  let steps: ReturnType<WorkflowCtx["_flushPending"]> = [];
  await assert.rejects(monitor(), (error: unknown) => {
    assert.ok(error instanceof wmill.StepSuspend);
    steps = error.dispatchInfo.steps;
    return true;
  });
  assert.equal(steps.length, 1);
  return steps[0];
}

test("Monitor collects, reads history once, evaluates and checkpoints notification", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("no I/O in workflow body");
  });
  const completed_steps: Record<string, unknown> = {};
  const old = snapshot(0);
  const metrics = reserve();
  metrics.borrow!.availableLiquidity = decimal(400);
  const current = snapshot(15, metrics);
  const collection = await next(completed_steps);
  assert.equal(collection.script, "u/oneke/sources/aave_v3_market_metrics");
  assert.equal(collection.dispatch_type, "flow");
  completed_steps[collection.key] = current;
  const history = await next(completed_steps);
  assert.equal(history.script, "f/chain_sentinel/sources/history");
  assert.deepEqual(history.args, {
    source_path: "u/oneke/sources/aave_v3_market_metrics",
    started_after: snapshot(-15).sampledAt,
    started_before: current.sampledAt,
  });
  completed_steps[history.key] = [{ result: old }, { result: current }];
  const evaluation = await next(completed_steps);
  assert.equal(evaluation.script, "f/aave/rules/aave_v3_market_risk");
  assert.deepEqual(evaluation.args, {
    current,
    history: [old, current],
    config: DEFAULT_CONFIG,
  });
  const findings = await evaluate(current, [old, current]);
  completed_steps[evaluation.key] = findings;
  const notification = await next(completed_steps);
  assert.equal(notification.script, "u/oneke/channels/notification");
  assert.equal(notification.args.message.level, "warning");
  assert.match(
    notification.args.message.description,
    /liquidity \(decrease\)：500 → 400；变化 -0\.2/,
  );
  completed_steps[notification.key] = { delivered: true };
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await monitor(), findings);
  assert.deepEqual(ctx._flushPending(), []);
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  assert.deepEqual(await monitor(), findings);
  assert.deepEqual(ctx._flushPending(), []);
});

test("Monitor makes no notification when no rules trigger", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const ctx = new wmill.WorkflowCtx({
    completed_steps: {
      aave_v3_market_metrics: snapshot(15),
      history: [],
      aave_v3_market_risk: [],
    },
  });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await monitor(), []);
  assert.deepEqual(ctx._flushPending(), []);
});

test("Monitor propagates collection, history, evaluation and notification failures", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const metrics = reserve();
  metrics.borrow!.availableLiquidity = decimal(400);
  const current = snapshot(15, metrics);
  const history = [{ result: snapshot(0) }];
  const findings = await evaluate(
    current,
    history.map((job) => job.result),
  );
  const fail = { __wmill_error: true, message: "Task failed" };
  for (const completed_steps of [
    { aave_v3_market_metrics: fail },
    { aave_v3_market_metrics: current, history: fail },
    { aave_v3_market_metrics: current, history, aave_v3_market_risk: fail },
    {
      aave_v3_market_metrics: current,
      history,
      aave_v3_market_risk: findings,
      notification: fail,
    },
  ]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
    await assert.rejects(monitor(), /Task failed/);
  }
});
