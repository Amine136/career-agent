import { enabledCountries, INDEED_CATEGORY_QUERIES, type Country } from "../../config/index.js";
import { finishRun, startRun } from "../core/repository.js";
import type { SourceJob } from "../core/types.js";
import { withClient, withTransaction } from "../db.js";
import { fetchIndeedPage, INDEED_PAGE_SIZE } from "../sources/indeed-brightdata.js";
import { IngestBudget, resolveIngestLimits } from "./budget.js";
import { CompanyGuard } from "./company-guard.js";
import { emptyStats, errorMessage, processFetched } from "./process.js";
import type { IngestOptions, IngestReport } from "./types.js";

/**
 * Indeed is paid per request (Bright Data), so we cap the number of searches per rolling
 * window and page adaptively: a page that yields more than [minAccepted] accepted jobs is
 * worth a follow-up page; a thin page means we move on to the next country/category.
 */
export const DEFAULT_INDEED_MAX_SEARCHES = 83;
export const DEFAULT_INDEED_MAX_PAGES = 5;
export const DEFAULT_INDEED_MIN_ACCEPTED = 5;
export const DEFAULT_INDEED_BUDGET_WINDOW_DAYS = 3;
/** Searches reserved for the remote-first phase, so remote roles are bought before the generic sweep. */
export const DEFAULT_INDEED_MAX_REMOTE_SEARCHES = 25;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A page is worth following up only when it yields more than the accepted-job threshold. */
export function shouldFetchNextPage(accepted: number, minAccepted: number): boolean {
  return accepted > minAccepted;
}

/** Searches already spent in the rolling window (from finished runs), so retries cannot overspend. */
async function searchesSpent(windowDays: number): Promise<number> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ spent: number }>(
      `select coalesce(sum((stats->'details'->>'searches')::int), 0)::int as spent
         from runs
        where source = 'indeed'
          and started_at > now() - make_interval(days => $1)`,
      [windowDays],
    );
    return rows[0]?.spent ?? 0;
  });
}

function selectCountries(options: IngestOptions): Country[] {
  const available = enabledCountries();
  const selected =
    options.countries && options.countries.length > 0
      ? available.filter((c) => options.countries!.includes(c.iso))
      : available;
  return [...selected].sort((a, b) => a.priority - b.priority);
}

/**
 * Search the country with the largest remaining quota first (deficit-based ordering), so the
 * paid Indeed budget follows the configured shares instead of always exhausting the top-priority
 * countries first. Priority is only a tie-breaker.
 */
function orderedCountries(
  countries: Country[],
  budget: IngestBudget,
  remoteOnly: boolean,
): Country[] {
  return [...countries].sort((a, b) => {
    const remainingA = remoteOnly ? budget.remoteRemaining(a.iso) : budget.remaining(a.iso);
    const remainingB = remoteOnly ? budget.remoteRemaining(b.iso) : budget.remaining(b.iso);
    if (remainingB !== remainingA) return remainingB - remainingA;
    return a.priority - b.priority;
  });
}

export async function ingestIndeed(options: IngestOptions = {}): Promise<IngestReport> {
  const now = options.now ?? new Date();
  const budget = envInt("INDEED_MAX_SEARCHES", DEFAULT_INDEED_MAX_SEARCHES);
  const remoteBudget = envInt("INDEED_MAX_REMOTE_SEARCHES", DEFAULT_INDEED_MAX_REMOTE_SEARCHES);
  const maxPages = envInt("INDEED_MAX_PAGES", DEFAULT_INDEED_MAX_PAGES);
  const minAccepted = envInt("INDEED_MIN_ACCEPTED", DEFAULT_INDEED_MIN_ACCEPTED);
  const windowDays = envInt("INDEED_BUDGET_WINDOW_DAYS", DEFAULT_INDEED_BUDGET_WINDOW_DAYS);
  const delayMs = envInt("INDEED_REQUEST_DELAY_MS", 1000);

  const categories =
    options.queries && options.queries.length > 0 ? options.queries : INDEED_CATEGORY_QUERIES;
  const countries = selectCountries(options);

  const stats = emptyStats();
  const rejectionReasons: Record<string, number> = {};
  const runId = await withTransaction((client) =>
    startRun(client, "indeed", options.invocationId),
  );
  const jobBudget = options.budget ?? new IngestBudget(resolveIngestLimits());
  const companyGuard = options.companyGuard ?? (await CompanyGuard.load(undefined, now));

  const spentBefore = await searchesSpent(windowDays);
  const remaining = Math.max(0, budget - spentBefore);
  let searches = 0;
  let remoteSearches = 0;
  let acceptedTotal = 0;
  let stoppedByBudget = false;

  // Remote roles are bought first (bounded by INDEED_MAX_REMOTE_SEARCHES) with Indeed's remote
  // attribute; the generic sweep then uses whatever is left of the rolling search budget.
  const phases: Array<{ remoteOnly: boolean; searchLimit: number }> = [
    { remoteOnly: true, searchLimit: remoteBudget },
    { remoteOnly: false, searchLimit: Number.POSITIVE_INFINITY },
  ];

  outer: for (const phase of phases) {
    let phaseSearches = 0;
    phaseLoop: for (const category of categories) {
      for (const country of orderedCountries(countries, jobBudget, phase.remoteOnly)) {
        if (jobBudget.totalReached) {
          stoppedByBudget = true;
          break outer;
        }
        if (jobBudget.countryAtLimit(country.iso)) continue;
        if (phase.remoteOnly && jobBudget.remoteAtLimit(country.iso)) continue;

        for (let page = 0; page < maxPages; page += 1) {
          if (jobBudget.totalReached) {
            stoppedByBudget = true;
            break outer;
          }
          if (jobBudget.countryAtLimit(country.iso)) break;
          if (phase.remoteOnly && jobBudget.remoteAtLimit(country.iso)) break;
          if (phaseSearches >= phase.searchLimit) break phaseLoop;

          if (searches >= remaining) {
            stoppedByBudget = true;
            break outer;
          }

          let jobs: SourceJob[];
          try {
            if (searches > 0 || spentBefore > 0) await sleep(delayMs);
            jobs = await fetchIndeedPage(
              country,
              category,
              page * INDEED_PAGE_SIZE,
              options.signal,
              phase.remoteOnly,
            );
          } catch (err) {
            stats.errors.push(`${country.iso} "${category}" page ${page}: ${errorMessage(err)}`);
            break; // move on to the next country
          }

          searches += 1;
          phaseSearches += 1;
          if (phase.remoteOnly) remoteSearches += 1;
          stats.jobsFetched += jobs.length;
          const accepted = await processFetched(
            jobs,
            now,
            stats,
            rejectionReasons,
            jobBudget,
            country.iso,
            phase.remoteOnly,
            companyGuard,
          );
          acceptedTotal += accepted;

          if (jobs.length === 0) break; // no more results for this country/category
          if (jobBudget.countryAtLimit(country.iso)) break; // country cap reached
          if (phase.remoteOnly && jobBudget.remoteAtLimit(country.iso)) break; // remote quota met
          if (shouldFetchNextPage(accepted, minAccepted)) continue; // promising → next page
          break; // thin page → next country
        }
      }
    }
  }

  stats.details = {
    searches,
    remoteSearches,
    remoteBudget,
    budget,
    spentBefore,
    remaining,
    stoppedByBudget,
    minAccepted,
    maxPages,
    categories,
    countries: countries.map((c) => c.iso),
    acceptedTotal,
    rejectionReasons,
    runBudget: jobBudget.snapshot(),
    companyGuard: companyGuard.snapshot(),
  };

  const status = stats.errors.length > 0 ? (stats.jobsFetched > 0 ? "partial" : "failed") : "success";
  await withTransaction((client) => finishRun(client, runId, status, stats));

  return { source: "indeed", status, stats };
}
