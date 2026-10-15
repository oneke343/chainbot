import assert from "node:assert/strict";
import test from "node:test";
import wmill, { type WorkflowCtx } from "windmill-client";
import { main } from "../f/aave/sources/v3/users_positions.ts";
import type { AaveMarketPositionsQuery } from "../f/aave/lib/v3-types.ts";

const api = { base_url: "https://api.v3.aave.com/graphql" };
const users = ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"];
const chains = { chains: [{ chainId: 1, name: "Ethereum" }, { chainId: 8453, name: "Base" }] };

test("user positions workflow dispatches standalone GraphQL tasks and returns positions by user", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("workflow must dispatch queries through tasks"); });
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: {} }));
  let steps: ReturnType<WorkflowCtx["_flushPending"]> = [];
  await assert.rejects(main(users, api), (error: unknown) => {
    assert.ok(error instanceof wmill.StepSuspend);
    assert.equal(error.dispatchInfo.mode, "sequential");
    steps = error.dispatchInfo.steps;
    return true;
  });
  assert.equal(steps.length, 1);
  const chainQuery = steps[0];
  assert.equal(chainQuery.script, "f/aave/sources/v3/chains");
  assert.deepEqual(chainQuery.args, { api });
  assert.equal(Reflect.get(chainQuery, "cache_ttl"), 86400);
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps: { [chainQuery.key]: chains } }));
  await assert.rejects(main(users, api), (error: unknown) => {
    assert.ok(error instanceof wmill.StepSuspend);
    assert.equal(error.dispatchInfo.mode, "parallel");
    steps = error.dispatchInfo.steps;
    return true;
  });
  assert.equal(steps.length, 2);
  assert.notEqual(steps[0].key, steps[1].key);
  for (const [index, step] of steps.entries()) {
    assert.equal(step.dispatch_type, "script");
    assert.equal(step.script, "f/aave/sources/v3/user_positions");
    assert.deepEqual(step.args, { api, user: users[index], chainIds: [1, 8453] });
  }

  const results: AaveMarketPositionsQuery[] = users.map((user, index) => ({ markets: [{
    name: user, address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
    chain: { chainId: 1, name: "Ethereum" }, userState: index === 0 ? null : {
      eModeEnabled: true, healthFactor: "0", totalDebtBase: "200", totalCollateralBase: "100",
    },
  }] }));
  const completed_steps = { [chainQuery.key]: chains, [steps[1].key]: results[1], [steps[0].key]: results[0] };
  const checkpoint = structuredClone(completed_steps);
  const ctx = new wmill.WorkflowCtx({ completed_steps });
  wmill.setWorkflowCtx(ctx);
  const positions = await main(users, api);
  assert.deepEqual(Object.keys(positions), users);
  assert.deepEqual(positions, {
    [users[0]]: [],
    [users[1]]: [{
      marketName: users[1], marketAddress: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
      chainId: 1, chainName: "Ethereum", eModeEnabled: true, healthFactor: "0",
      totalDebtBase: "200", totalCollateralBase: "100",
    }],
  });
  assert.deepEqual(ctx._flushPending(), []);
  assert.deepEqual(completed_steps, checkpoint);
});

test("empty user list returns no positions or user queries after chain discovery", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const ctx = new wmill.WorkflowCtx({ completed_steps: { chains: chains } });
  wmill.setWorkflowCtx(ctx);
  assert.deepEqual(await main([], api), {});
  assert.deepEqual(ctx._flushPending(), []);
});

test("chain and user query failures propagate instead of returning partial positions", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const failure = { __wmill_error: true, message: "Query failed" };
  for (const completed_steps of [
    { chains: failure },
    {
      chains: chains,
      user_positions: failure,
      user_positions_2: { markets: [] },
    },
  ]) {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
    await assert.rejects(main(users, api), { name: "TaskError", message: "Query failed" });
  }
});
