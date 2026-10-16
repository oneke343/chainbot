import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main as monitor } from "../u/oneke/monitors/aave_v3_configuration_change.ts";
import { main as calculateDiff } from "../f/chain_sentinel/rules/diff.ts";

const sourcePath = "u/oneke/sources/aave_v3_configuration";
const before = { "1": { pool: { supplyCap: "100" } } };
const current = { "1": { pool: { supplyCap: "200" } } };

async function nextStep(completed_steps: Record<string, unknown>) {
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  let steps: ReturnType<WorkflowCtx["_flushPending"]> = [];
  await assert.rejects(monitor(), (error: unknown) => {
    assert.ok(error instanceof wmill.StepSuspend);
    assert.equal(error.dispatchInfo.mode, "sequential");
    steps = error.dispatchInfo.steps;
    return true;
  });
  assert.equal(steps.length, 1);
  return steps[0];
}

test("Monitor reads Source history before sampling, compares snapshots and checkpoints notification", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("workflow body must not perform HTTP requests");
  });
  const completed_steps: Record<string, unknown> = {};
  const history = await nextStep(completed_steps);
  assert.equal(history.script, "f/chain_sentinel/sources/previous");
  assert.deepEqual(history.args, { source_path: sourcePath });
  completed_steps[history.key] = { result: before };
  const source = await nextStep(completed_steps);
  assert.equal(source.script, sourcePath);
  assert.equal(source.dispatch_type, "flow");
  assert.equal(Reflect.get(source, "timeout"), 180);
  assert.deepEqual(source.args, {});
  completed_steps[source.key] = current;
  const comparison = await nextStep(completed_steps);
  assert.equal(comparison.script, "f/chain_sentinel/rules/diff");
  assert.deepEqual(comparison.args, { before, after: current });
  completed_steps[comparison.key] = await calculateDiff(before, current);
  const notification = await nextStep(completed_steps);
  assert.equal(notification.script, "u/oneke/channels/notification");
  assert.deepEqual(notification.args, {
    message: {
      level: "info",
      title: "Aave v3 configuration snapshot changed",
      description:
        '检测到 1 项变化：修改 1，新增 0，删除 0\n\n/1/pool\n  修改 supplyCap："100" → "200"\n\n比例 1=100%；debtCeiling 单位为 USD，其余金额单位为 token；变化来自 API 两次采样。',
    },
  });
  completed_steps[notification.key] = { delivered: true };
  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.equal(await monitor(), undefined);
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
});

test("first sample creates Source history without diff or notification", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = { previous: null };
  const source = await nextStep(completed_steps);
  assert.equal(source.script, sourcePath);
  completed_steps[source.key] = current;
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.equal(await monitor(), undefined);
  assert.deepEqual(ctx._flushPending(), []);
});

test("a real USD debt ceiling change is notified with explicit currency", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const before = {
    "1088": {
      pool: {
        reserves: {
          metis: {
            isolationModeConfig: { debtCeiling: "1000000" },
          },
        },
      },
    },
  };
  const current = structuredClone(before);
  current["1088"].pool.reserves.metis.isolationModeConfig.debtCeiling =
    "1000000.01";
  const completed_steps: Record<string, unknown> = {
    previous: { result: before },
    aave_v3_configuration: current,
  };
  const comparison = await nextStep(completed_steps);
  assert.deepEqual(comparison.args, { before, after: current });
  completed_steps[comparison.key] = await calculateDiff(before, current);
  const notification = await nextStep(completed_steps);
  assert.equal(notification.script, "u/oneke/channels/notification");
  assert.match(
    notification.args.message.description,
    /修改 debtCeiling："1000000" → "1000000\.01"/,
  );
  assert.match(notification.args.message.description, /debtCeiling 单位为 USD/);
  completed_steps[notification.key] = { delivered: true };
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  assert.equal(await monitor(), undefined);
});

test("unchanged sampling does not notify or return a Monitor snapshot", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = {
    previous: { result: current },
    aave_v3_configuration: current,
  };
  const comparison = await nextStep(completed_steps);
  completed_steps[comparison.key] = await calculateDiff(current, current);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.equal(await monitor(), undefined);
  assert.deepEqual(ctx._flushPending(), []);
});

test("failures propagate; subsequent runs use the successful Source even after notification failure", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const failure = { __wmill_error: true, message: "Task failed" };
  const patch = await calculateDiff(before, current);
  for (const completed_steps of [
    { previous: failure },
    { previous: { result: before }, aave_v3_configuration: failure },
    {
      previous: { result: before },
      aave_v3_configuration: current,
      diff: failure,
    },
    {
      previous: { result: before },
      aave_v3_configuration: current,
      diff: patch,
      notification: failure,
    },
  ]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
    await assert.rejects(monitor(), {
      name: "TaskError",
      message: "Task failed",
    });
  }
  const ctx = new wmill.WorkflowCtx({
    completed_steps: {
      previous: { result: current },
      aave_v3_configuration: current,
      diff: await calculateDiff(current, current),
    },
  });
  wmill.setWorkflowCtx(ctx);
  assert.equal(await monitor(), undefined);
  assert.deepEqual(ctx._flushPending(), []);
});
