/// <reference types="emscripten" />

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { captureEvaluation, createInstanceKey, readAsOf, requireFresh, type Evaluation } from "../f/chain_sentinel/lib/evaluation.ts";
import {
  initializeEvaluationSchema, PostgresEvaluationHistory,
  type PostgresQuery,
} from "../f/chain_sentinel/lib/evaluation-postgres.ts";

const definition = { implementation: "requests", version: "1", scope: "resource:stats", params: { service: "checkout" } };
function queryFor(pg: PGlite): PostgresQuery {
  return async (statement, parameters) => (await pg.query(statement, parameters)).rows;
}

test("PostgreSQL evaluation persistence", async (t) => {
  const pg = await PGlite.create();
  t.after(() => pg.close());
  const query = queryFor(pg);
  await initializeEvaluationSchema(query);
  await initializeEvaluationSchema(query);

  await t.test("initialization creates only evaluation history", async () => {
    const tables = await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename", []);
    assert.deepEqual(tables, [{ tablename: "chainbot_evaluation_history" }]);
  });

  await t.test("immutable history, namespace isolation, and nearest preceding snapshot", async () => {
    const store = new PostgresEvaluationHistory(query, "history");
    const first = await captureEvaluation(store, { definition, ttl_ms: 100, evaluation_id: "first", now: () => 1000 }, async () => ({ value: 10 }));
    const second = await captureEvaluation(store, { definition, ttl_ms: 100, evaluation_id: "second", now: () => 2000 }, async () => ({ value: 20 }));
    await Promise.all([store.append(first), store.append(first)]);
    assert.deepEqual(await store.byId(first.instance_key, first.evaluation_id), first);
    assert.deepEqual(await store.latest(first.instance_key, 3000), second);
    assert.deepEqual(await readAsOf(store, first.instance_key, { at_ms: 1050 }), { status: "ok", evaluation: first });
    assert.deepEqual(await readAsOf(store, first.instance_key, { at_ms: 1100 }), { status: "stale", evaluation: first });
    await assert.rejects(store.append({ ...first, value: 99 }), /different content/);
    assert.deepEqual(await store.byId(first.instance_key, "first"), first);
    assert.equal(await new PostgresEvaluationHistory(query, "other-tenant").byId(first.instance_key, "first"), null);
    assert.equal(await store.byId(createInstanceKey({ ...definition, params: { service: "orders" } }), "first"), null);
    assert.equal(await store.latest(first.instance_key, 999), null);
  });

  await t.test("range pagination has no duplicate/lost rows at equal times and binds its cursor", async () => {
    const store = new PostgresEvaluationHistory(query, "pagination");
    const snapshots: Evaluation[] = [];
    for (const [id, time] of [["b", 1000], ["a", 1000], ["c", 1000], ["d", 2000]] as const) {
      snapshots.push(await captureEvaluation(store, { definition, ttl_ms: 100, evaluation_id: id, now: () => time }, async () => ({ value: id })));
    }
    const key = snapshots[0].instance_key;
    const first = await store.range(key, { from_ms: 1000, to_ms: 2000, limit: 2 });
    assert.deepEqual(first.items.map((row) => row.evaluation_id), ["a", "b"]);
    assert.ok(first.next_cursor);
    const second = await store.range(key, { from_ms: 1000, to_ms: 2000, limit: 2, cursor: first.next_cursor });
    assert.deepEqual(second.items.map((row) => row.evaluation_id), ["c"]);
    assert.equal(second.next_cursor, null);
    await assert.rejects(store.range(key, { from_ms: 1000, to_ms: 3000, limit: 2, cursor: first.next_cursor }), /cursor/);
    await assert.rejects(store.range(key, { from_ms: 1000, to_ms: 2000, limit: 0 }), /limit/);
  });

  await t.test("retention preserves latest and dependency evidence without any monitor state", async () => {
    const store = new PostgresEvaluationHistory(query, "retention");
    const snapshots: Evaluation[] = [];
    for (const time of [1000, 2000, 3000, 4000, 5000]) {
      snapshots.push(await captureEvaluation(store, { definition, ttl_ms: 100, evaluation_id: `sample-${time}`, now: () => time }, async () => ({ value: time })));
    }
    await captureEvaluation(store, { definition: { ...definition, implementation: "derived" }, ttl_ms: 100,
      now: () => 5100, dependencies: { old: { mode: "historical", evaluation: snapshots[1] } } }, async () => ({ value: 2 }));
    const key = snapshots[0].instance_key;
    assert.equal(await store.pruneHistory(key, 6000, 1), 1);
    assert.equal(await store.pruneHistory(key, 6000, 100), 2);
    assert.equal(await store.pruneHistory(key, 6000, 100), 0);
    const remaining = await store.range(key, { from_ms: 0, to_ms: 6000, limit: 100 });
    assert.deepEqual(remaining.items.map((row) => row.evaluation_id), ["sample-2000", "sample-5000"]);
  });

  await t.test("database errors and corrupt stored data fail explicitly", async () => {
    const store = new PostgresEvaluationHistory(query, "invalid");
    const key = createInstanceKey(definition);
    await query(`INSERT INTO public.chainbot_evaluation_history VALUES ($1, $2, $3, $4, $5::jsonb)`,
      ["invalid", "corrupt", key, 1000, '{"schema_version":1}']);
    await assert.rejects(store.latest(key, 2000), /evaluation_id/);
    const broken = new PostgresEvaluationHistory(async () => { throw new Error("connection lost"); }, "broken");
    await assert.rejects(broken.latest(key, 1000), /connection lost/);
  });

  await t.test("derived evaluation uses current and historical Source results and persists their evidence", async () => {
    const store = new PostgresEvaluationHistory(query, "sequence");
    let sourceCalls = 0;
    const first = await captureEvaluation(store, {
      definition, ttl_ms: 100, evaluation_id: "source-1", now: () => 1000,
    }, async () => { sourceCalls++; return { value: { errors: 1, requests: 100 } }; });
    const second = await captureEvaluation(store, {
      definition, ttl_ms: 100, evaluation_id: "source-2", now: () => 2000,
    }, async () => { sourceCalls++; return { value: { errors: 10, requests: 100 } }; });
    const historical = await store.byId(first.instance_key, first.evaluation_id);
    assert.ok(historical);
    const historicalStats = historical.value;
    assert.ok(historicalStats && typeof historicalStats === "object" && !Array.isArray(historicalStats));
    const historicalErrors = historicalStats.errors;
    const historicalRequests = historicalStats.requests;
    assert.ok(typeof historicalErrors === "number" && typeof historicalRequests === "number" && historicalRequests > 0);
    const metric = await captureEvaluation(store, {
      definition: { ...definition, implementation: "error_rate_change" }, ttl_ms: 100,
      now: () => 2010, dependencies: {
        current: { mode: "current", evaluation: second },
        old: { mode: "historical", evaluation: historical },
      },
    }, async () => ({ value: {
      rate: second.value.errors / second.value.requests,
      previous_rate: historicalErrors / historicalRequests,
    } }));
    assert.equal(metric.expires_at_ms, 2100);
    assert.deepEqual(requireFresh(metric, 2010).value, { rate: 0.1, previous_rate: 0.01 });
    assert.equal(sourceCalls, 2);
    assert.deepEqual(await store.byId(metric.instance_key, metric.evaluation_id), metric);
    assert.equal(metric.dependencies.current.evaluation_id, second.evaluation_id);
    assert.equal(metric.dependencies.old.evaluation_id, first.evaluation_id);
    assert.deepEqual((await store.range(first.instance_key, { from_ms: 0, to_ms: 3000, limit: 100 })).items
      .map((row) => row.evaluation_id), ["source-1", "source-2"]);
  });
});

test("evaluation history survives database close/reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chainbot-evaluation-"));
  let pg: PGlite | undefined;
  try {
    pg = await PGlite.create(directory);
    const query = queryFor(pg);
    await initializeEvaluationSchema(query);
    const store = new PostgresEvaluationHistory(query, "durable");
    const evaluation = await captureEvaluation(store, { definition, ttl_ms: 100, now: () => 1000 }, async () => ({ value: 42 }));
    await pg.close();
    pg = await PGlite.create(directory);
    const reopened = new PostgresEvaluationHistory(queryFor(pg), "durable");
    assert.deepEqual(await reopened.byId(evaluation.instance_key, evaluation.evaluation_id), evaluation);
  } finally {
    await pg?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
