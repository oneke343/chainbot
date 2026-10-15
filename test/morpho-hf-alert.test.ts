import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main as source } from "../f/morpho/sources/users_positions.ts";
import { main as evaluateHF } from "../f/morpho/rules/hf.ts";
import { main as monitor } from "../u/oneke/monitors/morpho_hf_alert.ts";
import type { MorphoUserPosition } from "../f/morpho/sources/types.ts";

const api = { base_url: "https://api.morpho.org/graphql" };
const users = ["0xalice", "0xbob"];
const position: MorphoUserPosition = {
  marketId: "0xmarket", marketName: "wstETH-USDC / LLTV 86%",
  chainId: 1, chainName: "Ethereum", healthFactor: 1.05, lltvPercent: 86,
};
function queryResult(healthFactor: number | null = 1.05, user = users[0]) {
  return { marketPositions: {
    items: [{ user: { address: user }, healthFactor, market: {
      marketId: position.marketId, lltv: "860000000000000000",
      chain: { id: 1, network: "Ethereum" },
      loanAsset: { symbol: "USDC" }, collateralAsset: { symbol: "wstETH" },
    } }],
    pageInfo: { countTotal: 1 },
  } };
}

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

test("Morpho source batches users, groups case-insensitively, and preserves zero HF and empty users", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("source must dispatch GraphQL tasks"); });
  const requestedUsers = [users[0], users[1], "0xCarol"];
  const run = () => source(requestedUsers, api);
  const completed_steps: Record<string, unknown> = {};
  const queries = await nextDispatch(run, completed_steps);
  assert.equal(queries.length, 1);
  const [query] = queries;
  assert.equal(query.script, "./user_positions.gql");
  assert.equal(query.dispatch_type, "script");
  assert.deepEqual(query.args, { api, users: requestedUsers, skip: 0 });
  completed_steps[query.key] = { marketPositions: {
    items: [...queryResult(1.05, "0xBOB").marketPositions.items, ...queryResult(0).marketPositions.items],
    pageInfo: { countTotal: 2 },
  } };
  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await run(), {
    [users[0]]: [{ ...position, healthFactor: 0 }], [users[1]]: [position], "0xCarol": [],
  });
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: {} }));
  assert.deepEqual(await source([], api), {});
});

test("Morpho source collects all pages of the combined result set and replays checkpoints", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("source must dispatch GraphQL tasks"); });
  const run = () => source(users, api);
  const completed_steps: Record<string, unknown> = {};
  const [first] = await nextDispatch(run, completed_steps);
  const item = queryResult().marketPositions.items[0];
  completed_steps[first.key] = { marketPositions: {
    items: Array.from({ length: 1000 }, (_, index) => ({
      ...item, market: { ...item.market, marketId: `0x${index.toString(16).padStart(64, "0")}` },
    })),
    pageInfo: { countTotal: 1001 },
  } };
  const [second] = await nextDispatch(run, completed_steps);
  assert.notEqual(second.key, first.key);
  assert.deepEqual(second.args, { api, users, skip: 1000 });
  const last = queryResult(0, users[1]).marketPositions.items[0];
  completed_steps[second.key] = { marketPositions: {
    items: [{ ...last, market: { ...last.market, lltv: "900000000000000000" } }],
    pageInfo: { countTotal: 1001 },
  } };
  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  const result = await run();
  assert.equal(result[users[0]].length, 1000);
  assert.deepEqual(result[users[1]], [{ ...position, marketName: "wstETH-USDC / LLTV 90%", healthFactor: 0, lltvPercent: 90 }]);
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
  completed_steps[second.key] = { marketPositions: { items: [], pageInfo: { countTotal: 1001 } } };
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  await assert.rejects(run(), /Incomplete Morpho positions/);
});

test("Morpho source rejects incomplete or missing borrowing data and propagates query failures", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const run = () => source([users[0]], api);
  const [query] = await nextDispatch(run, {});
  const raw = queryResult();
  for (const [result, message] of [
    [{ marketPositions: { items: null, pageInfo: { countTotal: 1 } } }, /missing items or page info/],
    [{ marketPositions: { items: [], pageInfo: null } }, /missing items or page info/],
    [{ marketPositions: { items: [], pageInfo: { countTotal: 1 } } }, /Incomplete/],
    [queryResult(null), /Missing Morpho borrowing position/],
    [{ marketPositions: { ...raw.marketPositions, items: [{
      ...raw.marketPositions.items[0], market: { ...raw.marketPositions.items[0].market, collateralAsset: null },
    }] } }, /Missing Morpho borrowing position/],
  ] as const) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: { [query.key]: result } }));
    await assert.rejects(run(), message);
  }
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: {
    [query.key]: { marketPositions: { items: [], pageInfo: { countTotal: 0 } } },
  } }));
  assert.deepEqual(await run(), { [users[0]]: [] });
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: {
    [query.key]: { __wmill_error: true, message: "Query failed" },
  } }));
  await assert.rejects(run(), { name: "TaskError", message: "Query failed" });
});

test("Morpho rule distinguishes chain/market overrides, renders thresholds and excludes healthy or equal HF", async () => {
  const positions = [position, { ...position, chainId: 8453, chainName: "Base" }];
  const before = structuredClone(positions);
  const message = await evaluateHF(positions, users[0], { "1:0xmarket": "1.2", "8453:0xmarket": 1 });
  assert.ok(message);
  assert.equal(message.level, "error");
  assert.equal(message.title, "Morpho Health Factor Alert");
  assert.match(message.description, /User: 0xalice/);
  assert.match(message.description, /wstETH-USDC \/ LLTV 86%/);
  assert.match(message.description, /ID: 0xmarket/);
  assert.match(message.description, /Health Factor: 1\.05/);
  assert.match(message.description, /Threshold: 1\.2/);
  assert.doesNotMatch(message.description, /Chain: Base/);
  assert.deepEqual(positions, before);
  const fallback = await evaluateHF([position]);
  assert.ok(fallback);
  assert.match(fallback.description, /Threshold: 1\.1/);
  assert.doesNotMatch(fallback.description, /User:/);
  assert.ok(await evaluateHF([{ ...position, healthFactor: 0 }]));
  assert.equal(await evaluateHF([{ ...position, healthFactor: 1.1 }]), null);
  assert.equal(await evaluateHF([{ ...position, healthFactor: 2 }]), null);
  assert.equal(await evaluateHF([]), null);
});

test("Morpho rule ignores LLTV at or above the cutoff before evaluating HF", async () => {
  for (const lltvPercent of [90, 95]) {
    assert.equal(await evaluateHF([{ ...position, lltvPercent, healthFactor: 0 }]), null);
  }
  const below = await evaluateHF([{ ...position, lltvPercent: 89.99 }]);
  assert.ok(below);
  assert.match(below.description, /LLTV: 89\.99%/);
  assert.equal(await evaluateHF([position], users[0], {}, 1.1, 86), null);
  assert.ok(await evaluateHF([{ ...position, lltvPercent: 95 }], users[0], {}, 1.1, 96));
});

test("Morpho alert evaluates users, checkpoints breach notifications, and returns alerts", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("workflow must only dispatch tasks"); });
  const thresholds = { "1:0xmarket": "1.2" };
  const run = () => monitor(users, api, thresholds, "1.15", 87);
  const completed_steps: Record<string, unknown> = {};
  const [collection] = await nextDispatch(run, completed_steps);
  assert.equal(collection.script, "f/morpho/sources/users_positions");
  assert.deepEqual(collection.args, { users, api });
  completed_steps[collection.key] = {
    [users[0]]: [position], [users[1]]: [{ ...position, healthFactor: 0, lltvPercent: 95 }],
  };
  const rules = await nextDispatch(run, completed_steps);
  assert.equal(rules.length, users.length);
  for (const [index, rule] of rules.entries()) {
    assert.equal(rule.script, "f/morpho/rules/hf");
    assert.equal(rule.dispatch_type, "script");
    assert.equal(rule.args.user, users[index]);
    assert.deepEqual(rule.args.thresholds, thresholds);
    assert.equal(rule.args.defaultThreshold, "1.15");
    assert.equal(rule.args.ltvThreshold, 87);
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
  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await run(), alerts);
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
  for (const noAlerts of [
    { ...completed_steps, [rules[0].key]: null }, { [collection.key]: {} },
  ]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: noAlerts }));
    assert.deepEqual(await run(), []);
  }
  for (const key of [collection.key, rules[0].key, notification.key]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: {
      ...completed_steps, [key]: { __wmill_error: true, message: "Task failed" },
    } }));
    await assert.rejects(run(), { name: "TaskError", message: "Task failed" });
  }
});
