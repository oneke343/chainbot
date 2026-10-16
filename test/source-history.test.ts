import assert from "node:assert/strict";
import test from "node:test";
import { JobService } from "windmill-client";
import { main } from "../f/chain_sentinel/sources/history.ts";

test("Source history forwards exact path and time bounds and uses successful job results", async (t) => {
  const after = "2026-10-16T03:30:00Z";
  const before = "2026-10-16T04:00:00Z";
  const job = { id: "source-job", job_kind: "flow", result: { sampledAt: before, reserves: {} } };
  t.mock.method(JobService, "listCompletedJobs", async (query: Parameters<typeof JobService.listCompletedJobs>[0]) => {
    assert.equal(query.scriptPathExact, "u/oneke/sources/aave_v3_market_metrics");
    assert.equal(query.startedAfter, after);
    assert.equal(query.startedBefore, before);
    assert.equal(query.status, "success");
    return [job];
  });
  t.mock.method(JobService, "getCompletedJob", async () => job);
  assert.deepEqual(await main("u/oneke/sources/aave_v3_market_metrics", after, before), [job]);
});
