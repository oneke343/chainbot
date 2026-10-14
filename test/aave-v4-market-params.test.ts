import assert from "node:assert/strict";
import test from "node:test";
import * as wmill from "windmill-client";
import type { ContractFunctionReturnType } from "viem";
import type { READER_ABI } from "../f/aave/lib/market-params-reader-artifact.ts";
import { main as loadBaseline } from "../u/oneke/aave_v4_market_params_monitor__flow/load_baseline.ts";
import { main as commitBaseline } from "../u/oneke/aave_v4_market_params_monitor__flow/commit_baseline.ts";
import { main as source } from "../f/aave/scripts/sources/aave_v4_read_hubs.ts";
import { main as collectParams } from "../f/aave/scripts/workflows/collect_aave_v4_market_params.ts";
import { main as rule } from "../f/aave/scripts/rules/evaluate_aave_v4_market_params.ts";
import type { Address, HubGraph, ParamValue, Snapshots, SpokeConfig } from "../f/aave/lib/market-params.ts";

// Check the independently declared model against the complete decoded Reader shape.
type JsonReader<T> = T extends bigint ? string : T extends readonly (infer U)[] ? JsonReader<U>[]
  : T extends object ? { -readonly [K in keyof T]: JsonReader<T[K]> } : T;
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type ReaderModelMatches = Assert<Same<HubGraph, JsonReader<ContractFunctionReturnType<typeof READER_ABI, "view", "readHub">>>>;
const modelMatches: ReaderModelMatches = true;
void modelMatches;

const addr = (byte: string): Address => `0x${byte.repeat(40)}`;
const hub = addr("1"), spoke = addr("2"), strategy = addr("4"), treasury = addr("6");
const hash = `0x${"a".repeat(64)}` as const;
function graph(value = 100): HubGraph {
  return {
    hub: { addr: hub, codeHash: hash, authority: addr("9"), assets: [{
      assetId: "0", underlying: addr("e"), decimals: 6, underlyingCodeHash: hash,
      config: { feeReceiver: treasury, liquidityFee: 1000, irStrategy: strategy, reinvestmentController: addr("0") },
      interestRate: { optimalUsageRatio: 9000, baseDrawnRate: 100, rateGrowthBeforeOptimal: 400, rateGrowthAfterOptimal: 6000 },
      irStrategyCodeHash: hash, reinvestmentControllerCodeHash: hash,
      registeredSpokes: [{ spoke, config: { addCap: value, drawCap: 50, active: true, halted: false, riskPremiumThreshold: 10000 } }],
    }] },
    spokes: [{ addr: spoke, codeHash: hash, authority: addr("9"),
      oracle: { addr: addr("b"), codeHash: hash, spoke, decimals: 8 }, maxUserReservesLimit: 16,
      liquidationLogic: addr("a"), liquidationLogicCodeHash: hash,
      liquidationConfig: { targetHealthFactor: "1050000000000000000", healthFactorForMaxBonus: "950000000000000000", liquidationBonusFactor: 5000 },
      reserves: [{ reserveId: "0", identity: { underlying: addr("e"), hub, assetId: 0, decimals: 6, collateralRisk: 1000, flags: 12, dynamicConfigKey: 1 },
        config: { collateralRisk: 1000, paused: false, frozen: false, borrowable: true, receiveSharesEnabled: true },
        priceSource: addr("c"), priceSourceCodeHash: hash,
        dynamicConfigs: [{ collateralFactor: 8000, maxLiquidationBonus: 10500, liquidationFee: 1000 },
          { collateralFactor: 8100, maxLiquidationBonus: 10500, liquidationFee: 1000 }] }],
      proxy: { implementation: addr("d"), implementationCodeHash: hash, admin: addr("7"), adminCodeHash: hash,
        adminOwnable: true, adminOwner: addr("8"), beacon: addr("0"), beaconCodeHash: hash,
        beaconOwnable: false, beaconOwner: addr("0"), beaconImplementation: addr("0"), beaconImplementationCodeHash: hash },
    }],
    treasuries: [{ addr: treasury, codeHash: hash, owner: addr("8"), pendingOwner: addr("0") }],
    tokenizations: [{ addr: addr("3"), codeHash: hash, hub, assetId: "0", underlying: addr("e"), decimals: 6 }],
    otherSpokes: [{ addr: addr("5"), codeHash: hash }],
    authorities: [{ addr: addr("9"), codeHash: hash, enumerable: true,
      roles: [{ roleId: "100", admin: "0", guardian: "0", grantDelay: 3600,
        members: [{ account: addr("8"), since: 100, currentDelay: 3600, pendingDelay: 0, effect: 0 }],
        targets: [{ target: hub, codeHash: hash, closed: false, adminDelay: 3600,
          configuratorAuthority: addr("9"), functions: [{ selector: "0x12345678", role: "100" }] }] }],
      knownTargets: [{ target: spoke, codeHash: hash, closed: false, adminDelay: 3600,
        configuratorAuthority: addr("0"), functions: [{ selector: "0xabcdef01", role: "0" }] }],
    }],
  };
}
function snapshot(value = 100): Snapshots { return { "1": { [hub]: graph(value) } }; }

function scalarNodes(value: object, path: string[] = []): Array<{ path: string[]; fields: Record<string, ParamValue> }> {
  const fields = Object.fromEntries(Object.entries(value).filter(([, item]) => item === null || typeof item !== "object"));
  const nodes = Object.entries(value).flatMap(([key, item]) => item && typeof item === "object" ? scalarNodes(item, [...path, key]) : []);
  return Object.keys(fields).length ? [{ path, fields: fields as Record<string, ParamValue> }, ...nodes] : nodes;
}
function objectAt(value: object, path: string[]): Record<string, ParamValue> {
  let current: unknown = value;
  for (const key of path) current = (current as Record<string, unknown>)[key];
  return current as Record<string, ParamValue>;
}

test("Rule establishes a silent baseline and reports cap changes once", async () => {
  const first = await rule(snapshot());
  assert.equal(first.output.matched, false);
  const changed = await rule(snapshot(200), first.nextBaseline);
  assert.equal(changed.output.matched, true);
  assert.equal(changed.output.fields.changes[0].path, `1.${hub}.hub.assets.0.registeredSpokes.${spoke}.config`);
  assert.deepEqual(changed.output.fields.changes[0].fields, [{ parameter: "addCap", before: 100, after: 200 }]);
  assert.equal((await rule(snapshot(200), changed.nextBaseline)).output.matched, false);
  assert.equal(first.nextBaseline["1"][hub].hub.assets[0].registeredSpokes[0].config.addCap, 100);
});

test("Rule detects every Reader configuration field, including identity changes", async () => {
  const input = snapshot(), first = await rule(input);
  let checked = 0;
  for (const node of scalarNodes(input["1"])) for (const [parameter, value] of Object.entries(node.fields)) {
    const changed = structuredClone(input);
    const after = typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : value === null ? addr("e")
      : value.startsWith("0x") ? (value === addr("e") ? addr("f") : addr("e")) : (BigInt(value) + 1n).toString();
    objectAt(changed["1"], node.path)[parameter] = after;
    const next = await rule(changed, first.nextBaseline);
    assert.ok(next.output.matched, `${node.path.join(".")}:${parameter}`);
    assert.ok(next.output.fields.changes.some(change => change.fields.some(field => field.parameter === parameter && field.after === after)));
    assert.equal((await rule(changed, next.nextBaseline)).output.matched, false);
    checked++;
  }
  assert.ok(checked >= 100, "cover the full Reader graph");
});

test("Rule ignores entity array order and map insertion order", async () => {
  const input = snapshot();
  for (const field of ["spokes", "treasuries", "tokenizations", "otherSpokes", "authorities"] as const) {
    const list = input["1"][hub][field] as Array<{addr:Address}>;
    list.push({ ...structuredClone(list[0]), addr: addr("f") });
  }
  const asset = structuredClone(input["1"][hub].hub.assets[0]); asset.assetId = "1";
  input["1"][hub].hub.assets.push(asset);
  const secondHub = addr("a"); input["1"][secondHub] = graph(); input["1"][secondHub].hub.addr = secondHub;
  const first = await rule(input), changed = structuredClone(input);
  changed["1"] = Object.fromEntries(Object.entries(changed["1"]).reverse());
  function reverseArrays(value: object, field = "") {
    if (Array.isArray(value) && field !== "dynamicConfigs") value.reverse();
    for (const [key, entry] of Object.entries(value)) if (entry && typeof entry === "object") reverseArrays(entry, Array.isArray(value) ? field : key);
  }
  reverseArrays(changed);
  assert.deepEqual((await rule(changed, first.nextBaseline)).output.fields.changes, []);
});

test("historical edits, new dynamic versions, revoked members and ADMIN reassignment alert", async () => {
  const input = snapshot(), first = await rule(input);
  input["1"][hub].spokes[0].reserves[0].dynamicConfigs[0].collateralFactor = 7900;
  input["1"][hub].spokes[0].reserves[0].dynamicConfigs.push({ collateralFactor: 8200, maxLiquidationBonus: 10500, liquidationFee: 1000 });
  input["1"][hub].spokes[0].reserves[0].identity.dynamicConfigKey = 2;
  input["1"][hub].authorities[0].roles[0].members = [];
  input["1"][hub].authorities[0].roles[0].targets[0].functions[0].role = "0";
  const next = await rule(input, first.nextBaseline);
  for (const suffix of [".dynamicConfigs.0", ".dynamicConfigs.2", ".identity", `.members.${addr("8")}`, ".functions.0x12345678"])
    assert.ok(next.output.fields.changes.some(change => change.path.endsWith(suffix)), suffix);
  assert.equal((await rule(input, next.nextBaseline)).output.matched, false);
});

test("removing the final Hub reports its complete graph, observed empty networks clear baseline", async () => {
  const first = await rule(snapshot());
  const empty = await rule({ "1": {} }, first.nextBaseline);
  assert.equal(empty.output.fields.observed_objects, 0);
  assert.ok(empty.output.fields.changes.length > 0);
  assert.ok(empty.output.fields.changes.every(change => change.change === "removed"));
  assert.deepEqual(empty.nextBaseline["1"], {});
  const added = await rule(snapshot(), empty.nextBaseline);
  assert.ok(added.output.fields.changes.every(change => change.change === "added"));
});

test("omitted networks retain baseline and new observed networks alert", async () => {
  const first = await rule(snapshot());
  const next = await rule({ "8453": {} }, first.nextBaseline);
  assert.equal(next.output.matched, false);
  assert.deepEqual(next.nextBaseline["1"], first.nextBaseline["1"]);
  assert.ok((await rule({ "8453": snapshot()["1"] }, first.nextBaseline)).output.matched);
  assert.equal((await rule({}, first.nextBaseline)).output.matched, false);
  assert.ok((await rule(snapshot(), {})).output.matched);
});

test("Rule is deterministic, groups fields, preserves input and bounds messages", async () => {
  const input = snapshot(), first = await rule(input);
  input["1"][hub].hub.assets[0].registeredSpokes[0].config.addCap = 200;
  input["1"][hub].hub.assets[0].registeredSpokes[0].config.drawCap = 70;
  const before = structuredClone({ input, first });
  const next = await rule(input, first.nextBaseline);
  assert.deepEqual(next, await rule(input, first.nextBaseline));
  assert.deepEqual({ input, first }, before);
  assert.deepEqual(next.output.fields.changes[0].fields.map(field => field.parameter), ["addCap", "drawCap"]);
  for (let id = 1; id <= 150; id++) input["1"][hub].hub.assets.push({ ...structuredClone(input["1"][hub].hub.assets[0]), assetId: String(id) });
  const large = await rule(input, next.nextBaseline);
  assert.ok(large.output.fields.changes.length >= 450);
  assert.ok(large.output.messages[0].description.length < 3000);
  assert.match(large.output.messages[0].description, /more objects/);
});

test("large Reader integers remain exact decimal strings and small integers retain numbers", async () => {
  const input = snapshot(), first = await rule(input);
  input["1"][hub].spokes[0].liquidationConfig.targetHealthFactor = "340282366920938463463374607431768211455";
  const next = await rule(input, first.nextBaseline);
  assert.equal(next.output.fields.changes[0].fields[0].after, "340282366920938463463374607431768211455");
  assert.doesNotThrow(() => JSON.stringify(next));
  // @ts-expect-error Reader cap uint40 values are decoded as numbers.
  const badCap: SpokeConfig = { addCap: "100", drawCap: 50, riskPremiumThreshold: 0, active: true, halted: false };
  void badCap;
});

test("Source returns an empty Hub map without contacting RPC", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected RPC"); });
  assert.deepEqual(await source("https://rpc.example", []), {});
});

test("WAC reads networks in parallel and aggregates checkpoint results by chain ID", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  t.mock.method(globalThis, "fetch", () => { throw new Error("workflow body must not contact external services"); });
  const api = { base_url: "https://api.example/graphql" };
  const rpc_urls = { "1": "https://ethereum.example", "8453": "https://base.example" };
  const completed_steps: Record<string, unknown> = {};
  async function nextDispatch() {
    wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
    let dispatch: Record<string, any> | undefined;
    await assert.rejects(collectParams(api, rpc_urls), (error: unknown) => {
      assert.ok(error instanceof wmill.StepSuspend);
      dispatch = error.dispatchInfo;
      return true;
    });
    return dispatch!;
  }
  const inventory = await nextDispatch();
  assert.equal(inventory.mode, "sequential");
  assert.equal(inventory.steps.length, 1);
  const query = inventory.steps[0];
  assert.equal(query.script, "f/aave/scripts/sources/aave_v4_market_params_inventory");
  assert.equal(query.dispatch_type, "script");
  assert.deepEqual(query.args, { api, chain_ids: [1, 8453] });
  completed_steps[query.key] = { hubs: [
    { address: hub, chain: { chainId: 1 } },
    { address: addr("a"), chain: { chainId: 999 } },
    { address: addr("b"), chain: { chainId: 1 } },
  ] };
  const reading = await nextDispatch();
  assert.equal(reading.mode, "parallel");
  assert.equal(reading.steps.length, 2);
  const [ethereum, base] = reading.steps;
  assert.equal(ethereum.script, "f/aave/scripts/sources/aave_v4_read_hubs");
  assert.deepEqual(ethereum.args, { rpc_url: rpc_urls["1"], hub_addresses: [hub, addr("b")] });
  assert.equal(base.script, ethereum.script);
  assert.notEqual(base.key, ethereum.key);
  assert.deepEqual(base.args, { rpc_url: rpc_urls["8453"], hub_addresses: [] });
  // Complete the second network first; replay must preserve task keys and chain association.
  completed_steps[base.key] = {};
  const pending = await nextDispatch();
  assert.equal(pending.mode, "sequential");
  assert.deepEqual(pending.steps, [ethereum]);
  completed_steps[ethereum.key] = snapshot()["1"];
  const before = structuredClone(completed_steps);
  wmill.setWorkflowCtx(new wmill.WorkflowCtx({ completed_steps }));
  assert.deepEqual(await collectParams(api, rpc_urls), { ...snapshot(), "8453": {} });
  assert.deepEqual(completed_steps, before);
});

test("WAC propagates task failures instead of returning a partial snapshot", async (t) => {
  t.after(() => wmill.setWorkflowCtx(null));
  const api = { base_url: "https://api.example/graphql" };
  const rpc_urls = { "1": "https://ethereum.example", "8453": "https://base.example" };
  const failure = { __wmill_error: true, message: "Reader failed" };
  for (const completed_steps of [
    { aave_v4_market_params_inventory: failure },
    { aave_v4_market_params_inventory: { hubs: [] }, aave_v4_read_hubs: snapshot()["1"], aave_v4_read_hubs_2: failure },
  ]) {
    const ctx = new wmill.WorkflowCtx({ completed_steps });
    wmill.setWorkflowCtx(ctx);
    await assert.rejects(collectParams(api, rpc_urls), { name: "TaskError", message: "Reader failed" });
    assert.deepEqual(ctx._flushPending(), []);
  }
});

test("Root state components store only network params and propagate persistence failures", async (t) => {
  const env = { WM_WORKSPACE: process.env.WM_WORKSPACE, WM_JOB_ID: process.env.WM_JOB_ID };
  process.env.WM_WORKSPACE = "test-only";
  process.env.WM_JOB_ID = "params-test";
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let stored: any;
  let writes = 0;
  let rejectWrite = false;
  t.mock.method(wmill.JobService, "getRootJobId", async () => "params-root");
  t.mock.method(wmill.JobService, "getJob", async () => ({ script_path: "u/test/params" }));
  t.mock.method(wmill.ResourceService, "getResourceValueInterpolated", async () => stored);
  t.mock.method(wmill.ResourceService, "existsResource", async () => stored !== undefined);
  t.mock.method(wmill.ResourceService, "createResource", async ({ requestBody }: { requestBody: { path: string; value: unknown } }) => {
    assert.equal(requestBody.path, "u/test/params/__monitor_state");
    stored = structuredClone(requestBody.value);
    writes++;
  });
  t.mock.method(wmill.ResourceService, "updateResourceValue", async ({ requestBody }: { requestBody: { value: unknown } }) => {
    if (rejectWrite) throw new Error("Persistence failed");
    stored = structuredClone(requestBody.value);
    writes++;
  });
  assert.equal(await loadBaseline(), null);
  const input = snapshot();
  const first = await rule(input, await loadBaseline());
  assert.equal(writes, 0, "Source and Rule do not save state");
  assert.deepEqual(await commitBaseline([1, 8453], first), first.output);
  assert.deepEqual(stored, { inputs: { chain_ids: [1, 8453] }, states: { params: first.nextBaseline }, outputs: first.output });
  assert.deepEqual(Object.keys(stored.states.params["1"]), [hub]);
  assert.deepEqual(await loadBaseline(), first.nextBaseline);
  const before = structuredClone(stored);
  rejectWrite = true;
  await assert.rejects(commitBaseline([1, 8453], await rule(snapshot(200), first.nextBaseline)), /Persistence failed/);
  assert.equal(writes, 1);
  assert.deepEqual(stored, before);
});
