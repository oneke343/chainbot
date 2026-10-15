import { isDeepStrictEqual } from "node:util";
import { JobService, type CompletedJob } from "windmill-client";

export type JobHistoryQuery = {
  kind?: "script" | "flow";
  path: string;
  /** Omit to skip input filtering; {} matches only jobs without arguments. */
  input?: Record<string, unknown>;
  startedAfter?: string;
  startedBefore?: string;
  perPage?: number;
};

/**
 * Returns a generator that yields the job history for a given workspace and query.
 * The generator yields objects containing the job ID and result for each matching job.
 * ordered by the job's completed timestamp in descending order (most recent first).
 *
 * @param workspace - The workspace to query for job history.
 * @param query - The query parameters to filter the job history.
 * @returns An async generator yielding job history objects.
 */
export async function* getJobHistory(
  workspace: string,
  query: JobHistoryQuery,
): AsyncGenerator<CompletedJob> {
  const { kind, path, input, startedAfter, startedBefore, perPage = 100 } = query;
  // An empty-object containment filter would exclude jobs with null arguments.
  const args = input && Object.keys(input).length ? JSON.stringify(input) : undefined;

  for (let page = 1; ; page++) {
    const jobs = await JobService.listCompletedJobs({
      workspace,
      jobKinds: kind ?? "script,flow",
      scriptPathExact: path,
      args,
      startedAfter,
      startedBefore,
      status: "success",
      success: true,
      orderDesc: true,
      perPage,
      page,
    });

    for (const candidate of jobs) {
      const job = await JobService.getCompletedJob({ workspace, id: candidate.id });
      if (!["script", "flow"].includes(job.job_kind)) {
        continue; // Skip jobs that are not scripts or flows.
      }
      // Windmill filters by JSON containment; compare the full input for an exact match.
      if (input !== undefined && !isDeepStrictEqual(job.args ?? {}, input)) continue;
      if (job.result === "WINDMILL_TOO_BIG") {
        const jobResult = await JobService.getCompletedJobResult({ workspace, id: job.id }); // Preload the result for the caller.
        yield { ...job, result: jobResult };
      } else {
        yield job;
      }
    }

    if (jobs.length < perPage) return;
  }
}

/**
 * Returns the latest job result for a given workspace and query.
 *
 * @param workspace - The workspace to query for job history.
 * @param query - The query parameters to filter the job history.
 * @returns A promise resolving to the latest job result or null if no matching jobs are found.
 */
export async function getLatestJobResult(
  workspace: string,
  query: JobHistoryQuery,
): Promise<CompletedJob | null> {
  for await (const job of getJobHistory(workspace, { ...query, perPage: 1 })) {
    return job;
  }

  return null;
}
