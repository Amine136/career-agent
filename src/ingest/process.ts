import { applyHardFilters } from "../core/filters.js";
import { normalizeSourceJob } from "../core/normalize.js";
import { upsertJob, type RunStats } from "../core/repository.js";
import { sourceJobSchema, type SourceJob } from "../core/types.js";
import { withTransaction } from "../db.js";
import type { IngestBudget } from "./budget.js";
import type { CompanyGuard } from "./company-guard.js";

export function emptyStats(): RunStats {
  return {
    jobsFetched: 0,
    jobsAccepted: 0,
    jobsRejected: 0,
    jobsInserted: 0,
    jobsUpdated: 0,
    errors: [],
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Validate, normalize, hard-filter and upsert a batch of source jobs, mutating [stats] in
 * place. Returns the number of jobs that passed the hard filters ("accepted") — the signal
 * the Indeed budget uses to decide whether to request the next page.
 *
 * When a [budget] is supplied, a job is only accepted while the run/country caps allow it; jobs
 * over a cap are skipped individually (the rest of the batch is still processed, since it may
 * contain on-site jobs after the remote half filled, or vice versa). Only newly inserted rows are
 * recorded against the budget, so re-sightings do not consume quota. Jobs are counted against
 * [countryCode] (the searched country) so the per-country cap matches the strategy loops.
 *
 * [remoteOnly] marks a batch fetched through a remote-filtered search. Only jobs whose stored
 * `remote` flag is actually true are counted against (and throttled by) the per-country remote
 * quota, so the source filters being unreliable cannot let on-site hits consume the quota and stop
 * the remote pass before it reaches genuine remote roles. The flag does not set `remote` (that is
 * re-verified from the posting text).
 *
 * [companyGuard] enforces the per-company diversity cap: jobs from a company that has already
 * stored its window quota are skipped before the DB write (and before AI scoring). It is checked
 * before the country budget so a capped company never consumes a country/remote slot; in dry-run
 * mode the skip is only recorded.
 */
export async function processFetched(
  raws: SourceJob[],
  now: Date,
  stats: RunStats,
  rejectionReasons: Record<string, number>,
  budget?: IngestBudget,
  countryCode?: string | null,
  remoteOnly = false,
  companyGuard?: CompanyGuard,
): Promise<number> {
  let accepted = 0;

  for (let index = 0; index < raws.length; index += 1) {
    const raw = raws[index]!;
    const validation = sourceJobSchema.safeParse(raw);
    if (!validation.success) {
      stats.jobsRejected += 1;
      bump(rejectionReasons, "invalid_source_data");
      continue;
    }

    const normalized = normalizeSourceJob(validation.data);
    const filter = applyHardFilters(normalized, now);
    if (!filter.accepted) {
      stats.jobsRejected += 1;
      for (const reason of filter.reasons) bump(rejectionReasons, reason);
      continue;
    }

    const budgetCountry = countryCode ?? normalized.countryCode;
    const companyKey = normalized.companyNormalized;
    // Diversity guard first: a capped company's jobs must not consume a country/remote slot.
    // In dry-run mode `atCap` is still reported but the job is allowed through.
    if (companyGuard?.atCap(companyKey)) {
      companyGuard.recordSkipped(companyKey);
      if (!companyGuard.dryRun) continue;
    }

    const remote = normalized.remote === true;
    // In share mode every confirmed-remote job counts against (and is throttled by) the remote
    // half, even when found by the generic sweep. Legacy mode keeps the historical rule: only a
    // confirmed-remote job from a remote pass is throttled by the remote quota.
    const remoteForBudget = budget?.usesCountryShares ? remote : remoteOnly && remote;
    if (budget && !budget.canAccept(budgetCountry, remoteForBudget)) {
      budget.recordSkipped();
      continue;
    }

    stats.jobsAccepted += 1;
    accepted += 1;

    try {
      const result = await withTransaction((client) => upsertJob(client, normalized));
      if (result.jobInserted) {
        stats.jobsInserted += 1;
        // Quota is about the catalog composition, so only genuinely new jobs consume it (a
        // re-sighting updates the row but must not burn another country/mode slot).
        budget?.record(budgetCountry, remote);
        companyGuard?.record(companyKey);
      } else if (result.jobUpdated) {
        stats.jobsUpdated += 1;
      }
    } catch (err) {
      stats.errors.push(
        `upsert ${normalized.source}/${normalized.sourceJobId}: ${errorMessage(err)}`,
      );
    }
  }

  return accepted;
}
