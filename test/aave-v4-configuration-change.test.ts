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

test("WAC reads history before collection and replays the original baseline", async (t) => {
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

  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await monitor(), patch);
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
});

test("first observation still collects the Source and returns null without diff", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = { previous: null };
  const collection = await nextDispatch(completed_steps);
  assert.equal(collection.script, sourcePath);
  completed_steps[collection.key] = current;
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.equal(await monitor(), null);
  assert.deepEqual(ctx._flushPending(), []);
});

test("unchanged configuration computes diff but returns null", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const completed_steps: Record<string, unknown> = {
    previous: { result: structuredClone(current) },
    aave_v4_configuration: current,
  };
  const comparison = await nextDispatch(completed_steps);
  assert.equal(comparison.script, "f/chain_sentinel/rules/diff");
  completed_steps[comparison.key] = await calculateDiff(structuredClone(current), current);
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  assert.equal(await monitor(), null);
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
  assert.equal(await monitor(), null);
});

test("removing all configuration returns a non-empty patch", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const patch = await calculateDiff(current, {});
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: {
    previous: { result: current }, aave_v4_configuration: {}, diff: patch,
  } }));
  assert.deepEqual(await monitor(), [{ op: "remove", path: "/1", oldValue: current["1"] }]);
});

test("WAC propagates history, Source and diff task failures", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const failure = { __wmill_error: true, message: "Task failed" };
  for (const completed_steps of [
    { previous: failure },
    { previous: { result: current }, aave_v4_configuration: failure },
    { previous: { result: current }, aave_v4_configuration: current, diff: failure },
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
  const job = { result: current };
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
