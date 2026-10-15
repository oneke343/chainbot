import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JobService } from "windmill-client";
import { getJobHistory, getLatestJobResult } from "../f/wmm/wm_job_history.ts";

type JobFixture = { job_kind: string; id: string; args?: Record<string, unknown> | null; result: unknown };
type ListQuery = Parameters<typeof JobService.listCompletedJobs>[0];

function mockHistory(t: TestContext, pages: JobFixture[][]) {
  const queries: ListQuery[] = [];
  t.mock.method(JobService, "listCompletedJobs", async (query: ListQuery) => {
    queries.push(query);
    assert.ok(query.page);
    return pages[query.page - 1] ?? [];
  });
  t.mock.method(JobService, "getCompletedJob", async ({ workspace, id }: Parameters<typeof JobService.getCompletedJob>[0]) => {
    assert.equal(workspace, "test");
    const job = pages.flat().find((job) => job.id === id);
    assert.ok(job);
    return job;
  });
  t.mock.method(JobService, "getCompletedJobResult", async () => {
    throw new Error("ordinary job results must not be fetched separately");
  });
  return queries;
}

test("history queries successful jobs with named filters and ordinary JSON input", async (t) => {
  const input = { network: "mainnet", market: { id: 1 } };
  const job = { job_kind: "flow", id: "latest", args: input, result: { cap: 100 } };
  const queries = mockHistory(t, [[job]]);
  const query = {
    kind: "flow", path: "f/aave/source", input,
    startedAfter: "2026-10-01T00:00:00Z", startedBefore: "2026-10-14T00:00:00Z",
  } satisfies Parameters<typeof getJobHistory>[1];

  assert.deepEqual(await Array.fromAsync(getJobHistory("test", query)), [job]);
  assert.deepEqual(queries, [{
    workspace: "test", jobKinds: "flow", scriptPathExact: query.path,
    args: JSON.stringify(input), startedAfter: query.startedAfter, startedBefore: query.startedBefore,
    status: "success", success: true, orderDesc: true, perPage: 100, page: 1,
  }]);
});

test("exact input matching skips containment matches across pages and ignores property order", async (t) => {
  const input = { network: "mainnet", market: { id: 1 } };
  const match = { job_kind: "flow", id: "exact", args: { market: { id: 1 }, network: "mainnet" }, result: 100 };
  const queries = mockHistory(t, [[
    { job_kind: "flow", id: "extra", args: { ...input, extra: true }, result: 200 },
    { job_kind: "flow", id: "nested-extra", args: { ...input, market: { id: 1, extra: true } }, result: 300 },
  ], [match]]);

  assert.deepEqual(await Array.fromAsync(getJobHistory("test", {
    kind: "script", path: "f/aave/source", input, perPage: 2,
  })), [match]);
  assert.deepEqual(queries.map(({ page, perPage, args }) => ({ page, perPage, args })), [
    { page: 1, perPage: 2, args: JSON.stringify(input) },
    { page: 2, perPage: 2, args: JSON.stringify(input) },
  ]);
});

test("empty input matches only jobs with absent, null or empty args", async (t) => {
  const jobs = [
    { job_kind: "flow", id: "absent", result: 1 },
    { job_kind: "flow", id: "null", args: null, result: 2 },
    { job_kind: "flow", id: "empty", args: {}, result: 3 },
    { job_kind: "flow", id: "with-input", args: { network: "mainnet" }, result: 4 },
  ];
  const queries = mockHistory(t, [jobs]);
  assert.deepEqual(await Array.fromAsync(getJobHistory("test", {
    path: "f/aave/source", input: {},
  })), jobs.slice(0, 3));
  assert.equal(queries[0].args, undefined);
});

test("omitting input returns jobs regardless of args", async (t) => {
  const jobs = [{ job_kind: "flow", id: "absent", result: null }, { job_kind: "flow", id: "with-input", args: { id: 1 }, result: false }];
  const queries = mockHistory(t, [jobs]);
  assert.deepEqual(await Array.fromAsync(getJobHistory("test", { path: "f/aave/source" })), jobs);
  assert.equal(queries[0].args, undefined);
});

test("latest uses one job per page and stops at the first exact match", async (t) => {
  const match = { job_kind: "flow", id: "match", args: {}, result: 0 };
  const queries = mockHistory(t, [
    [{ job_kind: "flow", id: "skip", args: { network: "mainnet" }, result: 1 }],
    [match],
    [{ job_kind: "flow", id: "older", args: {}, result: 2 }],
  ]);
  assert.equal(await getLatestJobResult("test", { path: "f/aave/source", input: {}, perPage: 50 }), match);
  assert.deepEqual(queries.map(({ page, perPage }) => ({ page, perPage })), [
    { page: 1, perPage: 1 }, { page: 2, perPage: 1 },
  ]);
});

test("missing history returns an empty sequence and latest returns null", async (t) => {
  mockHistory(t, []);
  assert.deepEqual(await Array.fromAsync(getJobHistory("test", { path: "f/aave/source" })), []);
  assert.equal(await getLatestJobResult("test", { path: "f/aave/source" }), null);
});

test("oversized results are loaded only for matching jobs without changing stored details", async (t) => {
  const job = { job_kind: "flow", id: "large", args: {}, result: "WINDMILL_TOO_BIG" };
  mockHistory(t, [[
    { job_kind: "flow", id: "skip", args: { id: 1 }, result: "WINDMILL_TOO_BIG" }, job,
  ]]);
  const result = { configuration: [1, 2, 3] };
  const fetchResult = t.mock.method(JobService, "getCompletedJobResult", async (query: Parameters<typeof JobService.getCompletedJobResult>[0]) => {
    assert.deepEqual(query, { workspace: "test", id: "large" });
    return result;
  });
  assert.deepEqual(await Array.fromAsync(getJobHistory("test", {
    path: "f/aave/source", input: {},
  })), [{ ...job, result }]);
  assert.equal(fetchResult.mock.callCount(), 1);
  assert.equal(job.result, "WINDMILL_TOO_BIG");
});

test("history propagates list, job detail and oversized result failures", async (t) => {
  mockHistory(t, [[{ job_kind: "flow", id: "large", result: "WINDMILL_TOO_BIG" }]]);
  const query = { path: "f/aave/source" };
  const resultFailure = new Error("result unavailable");
  t.mock.method(JobService, "getCompletedJobResult", async () => { throw resultFailure; });
  await assert.rejects(getLatestJobResult("test", query), (error) => error === resultFailure);

  const detailFailure = new Error("job unavailable");
  t.mock.method(JobService, "getCompletedJob", async () => { throw detailFailure; });
  await assert.rejects(getLatestJobResult("test", query), (error) => error === detailFailure);

  const listFailure = new Error("history unavailable");
  t.mock.method(JobService, "listCompletedJobs", async () => { throw listFailure; });
  await assert.rejects(getLatestJobResult("test", query), (error) => error === listFailure);
});
