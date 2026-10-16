import wmill, { type CompletedJob } from "windmill-client";
import { getJobHistory } from "../../wmm/wm_job_history.ts";

export async function main(
  source_path: string,
  started_after: string,
  started_before: string,
): Promise<CompletedJob[]> {
  return await Array.fromAsync(getJobHistory(wmill.getWorkspace(), {
    path: source_path,
    startedAfter: started_after,
    startedBefore: started_before,
  }));
}
