/**
 * Per-company ingestion diversity guard.
 *
 * The scheduler should not let one employer flood the catalog. Once a company reaches
 * `INGEST_COMPANY_CAP` newly inserted jobs inside the trailing `INGEST_COMPANY_WINDOW_DAYS`
 * window, further jobs from that company are skipped at ingest time (before the DB write and
 * before AI scoring). The block set is derived from job counts, so it expires automatically as
 * older jobs leave the window — there is no permanent, hand-maintained blocklist.
 *
 * Generic/agency names are exempt by default: listings such as "Confidential" or staffing
 * agencies collapse many unrelated roles into one normalized name, and capping them would hide
 * legitimate jobs. Add more with `INGEST_COMPANY_CAP_EXEMPT` (comma-separated names).
 */

/** Normalized names (lowercase, punctuation stripped) that are never capped. */
export const COMPANY_CAP_EXEMPT_NAMES: string[] = [
  "confidential",
  "private",
  "anonymous",
  "unknown",
  "undisclosed",
  "company",
  "client",
  "n a",
  "talent pool",
  "talent acquisition",
  "recruitment agency",
  "staffing agency",
  "employment agency",
];

/** Normalized substrings that mark an agency/generic listing and disable the cap. */
export const COMPANY_CAP_EXEMPT_TOKENS: string[] = [
  "staffing",
  "recruit",
  "headhunt",
  "talent acquisition",
  "talent pool",
  "employment agency",
  "outsourcing",
];
