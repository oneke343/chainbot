import wmill, { type CompletedJob } from "windmill-client";
import { getJobHistory } from "../../wmm/wm_job_history.ts";

/**
 * get last successed job result for a given source path,
 * source don't have arguments, so we don't need to filter by args.
 * source can be script or flow, so we don't need to filter by kind.
 * @param source_path
 */
export async function last(source_path: string): Promise<CompletedJob | null> {
  const jobs = await last_n(source_path, 1);

  return jobs.length > 0 ? jobs[0] : null;
}

/** Returns up to n successful jobs for the source, in history order. */
export async function last_n(source_path: string, n: number): Promise<CompletedJob[]> {
  const jobs: CompletedJob[] = [];
  if (n === 0) return jobs;

  for await (const job of getJobHistory(wmill.getWorkspace(), {
    path: source_path,
    perPage: Math.min(n, 100),
  })) {
    jobs.push(job);
    if (jobs.length >= n) break;
  }

  return jobs;
}

