import type { HardFilterResult, NormalizedJob } from "./types.js";
import { detectInternship } from "./normalize.js";

/** Hard filters: past 3 days (§3.4), entry-level only (§3.2/§7). */
export const FRESHNESS_DAYS = 3;

export function daysSince(dateStr: string, now: Date = new Date()): number {
  const posted = Date.parse(`${dateStr}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - posted) / 86_400_000);
}

export function applyHardFilters(job: NormalizedJob, now: Date = new Date()): HardFilterResult {
  const reasons: string[] = [];

  if (!job.entryLevel) reasons.push("not_entry_level");

  if (!job.postedAt) {
    reasons.push("missing_posted_at");
  } else if (daysSince(job.postedAt, now) > FRESHNESS_DAYS) {
    reasons.push("older_than_3_days");
  }

  // A declared employment type that maps to nothing allowed is rejected.
  if (job.employmentTypeRaw && job.employmentType === null) {
    reasons.push("job_type_not_allowed");
  }

  // Internships are dropped: they are a large share of entry-level results and are not wanted.
  // Rejecting them also stops them from counting toward the page-follow-up heuristic, so the
  // run does not spend extra Indeed/LinkedIn requests chasing internship-heavy result pages.
  if (detectInternship(job)) {
    reasons.push("excluded_internship");
  }

  return { accepted: reasons.length === 0, reasons };
}
