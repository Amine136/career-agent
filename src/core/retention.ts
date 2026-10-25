import { withTransaction } from "../db.js";
import { finishRun, startRun } from "./repository.js";

/**
 * Retention policy: scraped jobs that have not been touched from the apps (no saved row, no
 * application) and that ingestion has not seen for `RETENTION_DELETE_DAYS` are permanently
 * deleted. Jobs the user added themselves (`created_by` set) are never touched by the worker.
 *
 * There is no separate "deactivate" or age-based delete anymore: a job disappears only when the
 * user removes it in a client or after this untouched window. Every deletion is recorded in
 * `job_removals` by a database trigger, so the Home "Deleted content" counter keeps growing.
 */
export const RETENTION_DELETE_DAYS = 14;

export interface RetentionResult {
  deleted: number;
}

function daysAgo(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 86_400_000);
}

/**
 * Apply the retention policy and record the outcome as a `runs` row (source `retention`).
 * Throws after recording if the database work fails.
 */
export async function applyRetention(
  now: Date = new Date(),
  invocationId?: string,
): Promise<RetentionResult> {
  const runId = await withTransaction((client) => startRun(client, "retention", invocationId));
  const deleteBefore = daysAgo(now, RETENTION_DELETE_DAYS);

  let result: RetentionResult = { deleted: 0 };
  try {
    result = await withTransaction(async (client) => {
      const deleted = await client.query<{ count: number }>(
        `with removed as (
           delete from jobs j
           where j.created_by is null
             and j.last_seen_at < $1
             and not exists (select 1 from applications a where a.job_id = j.id)
             and not exists (select 1 from saved_jobs s where s.job_id = j.id)
           returning j.id
         )
         select count(*)::int as count from removed`,
        [deleteBefore.toISOString()],
      );
      return { deleted: deleted.rows[0]?.count ?? 0 };
    });
  } catch (err) {
    await withTransaction((client) =>
      finishRun(client, runId, "failed", {
        jobsFetched: 0,
        jobsAccepted: 0,
        jobsRejected: 0,
        jobsInserted: 0,
        jobsUpdated: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      }),
    );
    throw err;
  }

  await withTransaction((client) =>
    finishRun(client, runId, "success", {
      jobsFetched: 0,
      jobsAccepted: 0,
      jobsRejected: 0,
      jobsInserted: 0,
      jobsUpdated: result.deleted,
      errors: [],
      details: { deleted: result.deleted },
    }),
  );

  return result;
}
