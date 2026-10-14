import assert from "node:assert/strict";
import test from "node:test";
import {
  captureEvaluation,
  createInstanceKey,
  readAsOf,
  readLatest,
  requireFresh,
  type Evaluation,
  type EvaluationHistory,
} from "../f/chain_sentinel/lib/evaluation.ts";

const definition = {
  implementation: "service_stats",
  version: "1",
  scope: "workspace:chainbot/resource:stats",
  params: { service: "checkout" },
};

// This fake represents storage only. PostgreSQL behavior is tested against PGlite.
function history(): EvaluationHistory & { rows: Evaluation[] } {
  const rows: Evaluation[] = [];
  return {
    rows,
    async append(value) { rows.push(structuredClone(value)); },
    async byId(key, id) {
      return rows.find((row) => row.instance_key === key && row.evaluation_id === id) ?? null;
    },
    async latest(key, at) {
      return rows.filter((row) => row.instance_key === key && row.collected_at_ms <= at)
        .sort((a, b) => b.collected_at_ms - a.collected_at_ms)[0] ?? null;
    },
  };
}

test("instance identity is stable across monitors and changes with effective inputs", () => {
  const key = createInstanceKey({ ...definition, params: { a: 1, b: { x: 2, y: 3 } } });
  assert.equal(key, createInstanceKey({ ...definition, params: { b: { y: 3, x: 2 }, a: 1 } }));
  for (const changed of [
    { ...definition, version: "2" },
    { ...definition, scope: "another-resource" },
    { ...definition, params: { service: "orders" } },
    { ...definition, dependencies: { input: { instance_key: "another", mode: "current" as const } } },
  ]) assert.notEqual(createInstanceKey(definition), createInstanceKey(changed));
  assert.throws(() => createInstanceKey({ ...definition, params: { invalid: NaN } }), /JSON/);
  // @ts-expect-error Exercise the runtime boundary for an invalid JS caller.
  assert.throws(() => createInstanceKey({ ...definition, params: { invalid: undefined } }), /JSON/);
});

test("dependency expiry during a slow computation rejects the result before persistence", async () => {
  const store = history();
  const input = await captureEvaluation(store, { definition, ttl_ms: 100, now: () => 1000 }, async () => ({ value: 1 }));
  const times = [1050, 1100];
  await assert.rejects(captureEvaluation(store, {
    definition: { ...definition, implementation: "compute" }, ttl_ms: 1000,
    now: () => times.shift() ?? 1100, dependencies: { input: { mode: "current", evaluation: input } },
  }, async () => ({ value: 2 })), /became stale/);
  assert.equal(store.rows.length, 1);
});

test("capture persists successful values, preserves evidence, and replays a stored evaluation", async () => {
  const store = history();
  let calls = 0;
  const options = { definition, ttl_ms: 1000, evaluation_id: "job-1", now: () => 2000 };
  const first = await captureEvaluation(store, options, async () => {
    calls++;
    return { value: { requests: 10 }, observed_at_ms: 1500 };
  });
  const replay = await captureEvaluation(store, { ...options, now: () => 9000 }, async () => {
    calls++;
    return { value: { requests: 20 } };
  });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.equal(store.rows.length, 1);
  assert.equal(first.observed_at_ms, 1500);
  assert.equal(first.collected_at_ms, 2000);
  assert.equal(first.expires_at_ms, 3000);
  assert.throws(() => requireFresh(first, 3000), /stale/);
});

test("current dependencies bound validity; historical dependencies retain evidence without bounding TTL", async () => {
  const store = history();
  const input = await captureEvaluation(store, { definition, ttl_ms: 100, now: () => 1000 }, async () => ({ value: 10 }));
  const metricDefinition = { ...definition, implementation: "ratio", params: { window: "1h" } };
  const metric = await captureEvaluation(store, {
    definition: metricDefinition, ttl_ms: 1000, now: () => 1050,
    dependencies: { input: { mode: "current", evaluation: input } },
  }, async () => ({ value: 0.1 }));
  assert.equal(metric.expires_at_ms, 1100);
  assert.equal(metric.dependencies.input.evaluation_id, input.evaluation_id);
  const old = await captureEvaluation(store, {
    definition: metricDefinition, ttl_ms: 1000, now: () => 5000,
    dependencies: { input: { mode: "historical", evaluation: input } },
  }, async () => ({ value: 0.2 }));
  assert.equal(old.expires_at_ms, 6000);
  let called = false;
  await assert.rejects(captureEvaluation(store, {
    definition: metricDefinition, ttl_ms: 1000, now: () => 1100,
    dependencies: { input: { mode: "current", evaluation: input } },
  }, async () => { called = true; return { value: 0 }; }), /stale/);
  assert.equal(called, false);
});

test("failed collection, invalid JSON and failed persistence never return a successful snapshot", async () => {
  const store = history();
  await assert.rejects(captureEvaluation(store, { definition, ttl_ms: 100 }, async () => { throw new Error("RPC failed"); }), /RPC failed/);
  await assert.rejects(captureEvaluation(store, { definition, ttl_ms: 100 }, async () => ({ value: Infinity })), /JSON/);
  assert.equal(store.rows.length, 0);
  await assert.rejects(captureEvaluation({ ...store, async append() { throw new Error("DB failed"); } },
    { definition, ttl_ms: 100 }, async () => ({ value: 10 })), /DB failed/);
});

test("history reads distinguish missing and stale and never collect as a fallback", async () => {
  const store = history();
  const key = createInstanceKey(definition);
  assert.deepEqual(await readLatest(store, key, { at_ms: 2000 }), { status: "missing" });
  const first = await captureEvaluation(store, { definition, ttl_ms: 100, now: () => 1000 }, async () => ({ value: 1 }));
  await captureEvaluation(store, { definition, ttl_ms: 100, now: () => 2000 }, async () => ({ value: 2 }));
  assert.equal((await readAsOf(store, key, { at_ms: 1050 })).status, "ok");
  assert.equal((await readAsOf(store, key, { at_ms: 1100 })).status, "stale");
  const latest = await readLatest(store, key, { at_ms: 3000 });
  assert.equal(latest.status, "stale");
  const aged = await readAsOf(store, key, { at_ms: 1050, max_age_ms: 20 });
  assert.deepEqual(aged, { status: "stale", evaluation: first });
  await assert.rejects(readLatest({ ...store, async latest() { throw new Error("DB unavailable"); } }, key,
    { at_ms: 3000 }), /DB unavailable/);
});
