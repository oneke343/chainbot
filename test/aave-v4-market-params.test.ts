import assert from "node:assert/strict";
import test from "node:test";
import * as wmill from "windmill-client";
import type { ContractFunctionReturnType } from "viem";
import type { READER_ABI } from "../f/aave/lib/market-params-reader-artifact.ts";
import { main as source } from "../f/aave/scripts/sources/aave_v4_read_hubs.ts";
import { main as collectParams } from "../f/aave/scripts/workflows/collect_aave_v4_market_params.ts";
import type { Address, HubGraph, Snapshots } from "../f/aave/lib/market-params.ts";

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
