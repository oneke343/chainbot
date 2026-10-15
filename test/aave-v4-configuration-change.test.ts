import assert from "node:assert/strict";
import test from "node:test";
import wmill, { JobService, type WorkflowCtx } from "windmill-client";
import jsonpatch from "fast-json-patch";
import { main as monitor } from "../u/oneke/monitors/aave_v4_configuration_change.ts";
import { main as readPrevious } from "../f/chain_sentinel/sources/previous.ts";
import { main as calculateDiff } from "../f/chain_sentinel/rules/diff.ts";

const sourcePath = "u/oneke/sources/aave_v4_configuration";
const current = { "1": { hub: { cap: 200 } } };

async function nextDispatch(completed_steps: Record<string, unknown>) {
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

test("WAC reads history before collection, renders changes and checkpoints notification", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("workflow body must not contact external services"); });
  const before = { "1": { hub: { cap: 100 } } };
  const completed_steps: Record<string, unknown> = {};

  const previous = await nextDispatch(completed_steps);
  assert.equal(previous.script, "f/chain_sentinel/sources/previous");
  assert.equal(previous.dispatch_type, "script");
  assert.deepEqual(previous.args, { source_path: sourcePath });
  completed_steps[previous.key] = { result: before };

  const collection = await nextDispatch(completed_steps);
  assert.equal(collection.script, sourcePath);
  assert.equal(collection.dispatch_type, "flow");
  assert.equal(Reflect.get(collection, "timeout"), 600);
  assert.deepEqual(collection.args, {});
  completed_steps[collection.key] = current;

  const comparison = await nextDispatch(completed_steps);
  assert.equal(comparison.script, "f/chain_sentinel/rules/diff");
  assert.equal(comparison.dispatch_type, "script");
  assert.deepEqual(comparison.args, { before, after: current });
  const patch = await calculateDiff(before, current);
  assert.deepEqual(patch, [{ op: "replace", path: "/1/hub/cap", value: 200, oldValue: 100 }]);
  assert.deepEqual(jsonpatch.applyPatch(structuredClone(before), patch, true).newDocument, current);
  completed_steps[comparison.key] = patch;

  const notification = await nextDispatch(completed_steps);
  assert.equal(notification.script, "u/oneke/channels/notification");
  assert.equal(notification.dispatch_type, "flow");
  assert.deepEqual(notification.args, { message: {
    level: "info", title: "Aave v4 configuration change detected",
    description: "检测到 1 项变化：修改 1，新增 0，删除 0\n\n/1/hub\n  修改 cap：100 → 200",
  } });
  completed_steps[notification.key] = { delivered: true };

  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.equal(await monitor(), undefined);
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
});

test("first observation still collects the Source without diff or notification", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = { previous: null };
  const collection = await nextDispatch(completed_steps);
  assert.equal(collection.script, sourcePath);
  completed_steps[collection.key] = current;
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.equal(await monitor(), undefined);
  assert.deepEqual(ctx._flushPending(), []);
});

test("unchanged configuration computes diff without rendering or notification", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = {
    previous: { result: structuredClone(current) },
    aave_v4_configuration: current,
  };
  const comparison = await nextDispatch(completed_steps);
  assert.equal(comparison.script, "f/chain_sentinel/rules/diff");
  completed_steps[comparison.key] = await calculateDiff(structuredClone(current), current);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.equal(await monitor(), undefined);
  assert.deepEqual(ctx._flushPending(), []);
});

test("comparison ignores object property order", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const before = { a: 1, b: 2 }, after = { b: 2, a: 1 };
  const completed_steps: Record<string, unknown> = {
    previous: { result: before }, aave_v4_configuration: after,
  };
  const comparison = await nextDispatch(completed_steps);
  assert.deepEqual(comparison.args, { before, after });
  completed_steps[comparison.key] = await calculateDiff(before, after);
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  assert.equal(await monitor(), undefined);
});

test("removing all configuration renders a removal and sends notification", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const patch = await calculateDiff(current, {});
  assert.deepEqual(patch, [{ op: "remove", path: "/1", oldValue: current["1"] }]);
  const completed_steps: Record<string, unknown> = {
    previous: { result: current }, aave_v4_configuration: {}, diff: patch,
  };
  const notification = await nextDispatch(completed_steps);
  assert.equal(notification.script, "u/oneke/channels/notification");
  assert.match(notification.args.message.description, /删除 1：/);
  assert.match(notification.args.message.description, /"cap": 200/);
  completed_steps[notification.key] = { delivered: true };
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  assert.equal(await monitor(), undefined);
});

test("WAC propagates history, Source, diff and notification failures", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const failure = { __wmill_error: true, message: "Task failed" };
  const changes = {
    previous: { result: {} }, aave_v4_configuration: current,
    diff: await calculateDiff({}, current),
  };
  for (const completed_steps of [
    { previous: failure },
    { previous: { result: current }, aave_v4_configuration: failure },
    { previous: { result: current }, aave_v4_configuration: current, diff: failure },
    { ...changes, notification: failure },
  ]) {
    const ctx = new wmill.WorkflowCtx({ completed_steps });
    wmill.setWorkflowCtx(ctx);
    await assert.rejects(monitor(), { name: "TaskError", message: "Task failed" });
    assert.deepEqual(ctx._flushPending(), []);
  }
});

test("previous value comes from the latest successful Source job", async (t) => {
  t.mock.method(wmill, "getWorkspace", () => "test");
  t.mock.method(JobService, "listCompletedJobs", async (query: Parameters<typeof JobService.listCompletedJobs>[0]) => {
    assert.equal(query.workspace, "test");
    assert.equal(query.scriptPathExact, sourcePath);
    assert.equal(query.status, "success");
    assert.equal(query.perPage, 1);
    return [{ id: "previous-job" }];
  });
  const job = { id: "previous-job", job_kind: "flow", result: current };
  t.mock.method(JobService, "getCompletedJob", async () => job);
  assert.equal(await readPrevious(sourcePath), job);
});

test("missing Source history returns null and lookup failures propagate", async (t) => {
  t.mock.method(wmill, "getWorkspace", () => "test");
  const list = t.mock.method(JobService, "listCompletedJobs", async () => []);
  assert.equal(await readPrevious(sourcePath), null);
  list.mock.mockImplementation(async () => { throw new Error("History lookup failed"); });
  await assert.rejects(readPrevious(sourcePath), /History lookup failed/);
});
