import {
  enabledCountries,
  queriesForLanguages,
  remoteQueriesForLanguages,
  type Country,
} from "../../config/index.js";
import { getIngestCursor, saveIngestCursor } from "../core/cursors.js";
import { finishRun, startRun } from "../core/repository.js";
import type { SourceJob } from "../core/types.js";
import { withTransaction } from "../db.js";
import { fetchLinkedInPage, LINKEDIN_PAGE_SIZE } from "../sources/linkedin.js";
import { IngestBudget, resolveIngestLimits } from "./budget.js";
import { CompanyGuard } from "./company-guard.js";
import { emptyStats, errorMessage, processFetched } from "./process.js";
import type { IngestOptions, IngestReport } from "./types.js";

/**
 * LinkedIn's guest API is free, so we sweep everything: every enabled country, every canonical
 * and localized title, and every result page. Because a full sweep can outlast a single Cloud
 * Run invocation, progress is checkpointed and the next run resumes where this one stopped.
 */
export const DEFAULT_LINKEDIN_TIME_BUDGET_MS = 45 * 60 * 1000;
export const DEFAULT_LINKEDIN_MAX_PAGES = 40;

export interface LinkedInIngestOptions extends IngestOptions {
  /** Wall-clock budget for this invocation; overrides LINKEDIN_TIME_BUDGET_MS. */
  timeBudgetMs?: number;
}

interface LinkedInTask {
  country: Country;
  query: string;
  /**
   * Fetched with LinkedIn's Remote workplace filter (f_WT=2) and run first against the remote
   * quota. The filter prioritizes candidates; the stored `remote` flag is still re-verified from
   * the posting text (`detectRemote`) because the filter also returns on-site roles.
   */
  remoteOnly: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function buildTasks(options: IngestOptions): LinkedInTask[] {
  return buildLinkedInTasks(options);
}

/**
 * Interleave tasks round-robin by query depth across countries so a budget-limited sweep stays
 * balanced: every country's first query runs before any country's second. Without this, a
 * country-major order (all of Germany first) exhausts the time budget inside the first country.
 */
function interleave(
  perCountry: Array<{ country: Country; queries: string[] }>,
  remoteOnly: boolean,
): LinkedInTask[] {
  const maxQueries = perCountry.reduce((max, entry) => Math.max(max, entry.queries.length), 0);
  const tasks: LinkedInTask[] = [];
  for (let depth = 0; depth < maxQueries; depth += 1) {
    for (const entry of perCountry) {
      const query = entry.queries[depth];
      if (query !== undefined) {
        tasks.push({ country: entry.country, query, remoteOnly });
      }
    }
  }
  return tasks;
}

/**
 * Remote tasks run before the generic sweep and stop at the per-country remote quota
 * (`IngestBudget.maxRemotePerCountry`), so remote roles are not crowded out by the larger
 * on-site/hybrid pool. Each block keeps the round-robin fairness across countries.
 */
export function buildLinkedInTasks(options: IngestOptions): LinkedInTask[] {
  const available = enabledCountries();
  const countries =
    options.countries && options.countries.length > 0
      ? available.filter((c) => options.countries!.includes(c.iso))
      : available;

  const explicit = options.queries && options.queries.length > 0 ? options.queries : undefined;

  // The remote-first pass searches remote-intent queries (so genuinely remote postings surface even
  // though LinkedIn's `f_WT=2` filter is often ignored); the generic sweep uses the plain titles.
  const remotePerCountry = countries.map((country) => ({
    country,
    queries: explicit ?? remoteQueriesForLanguages(country.languages),
  }));
  const genericPerCountry = countries.map((country) => ({
    country,
    queries: explicit ?? queriesForLanguages(country.languages),
  }));

  return [...interleave(remotePerCountry, true), ...interleave(genericPerCountry, false)];
}

export async function ingestLinkedIn(options: LinkedInIngestOptions = {}): Promise<IngestReport> {
  const now = options.now ?? new Date();
  const startedAt = Date.now();
  const timeBudgetMs =
    options.timeBudgetMs ?? envInt("LINKEDIN_TIME_BUDGET_MS", DEFAULT_LINKEDIN_TIME_BUDGET_MS);
  const maxPages = envInt("LINKEDIN_MAX_PAGES", DEFAULT_LINKEDIN_MAX_PAGES);
  const fetchDetails = process.env.LINKEDIN_FETCH_DETAILS !== "0";
  const delayMs = envInt("LINKEDIN_REQUEST_DELAY_MS", 1500);

  const tasks = buildTasks(options);
  const stats = emptyStats();
  const rejectionReasons: Record<string, number> = {};
  const runId = await withTransaction((client) =>
    startRun(client, "linkedin", options.invocationId),
  );
  const jobBudget = options.budget ?? new IngestBudget(resolveIngestLimits());
  const companyGuard = options.companyGuard ?? (await CompanyGuard.load(undefined, now));

  const stored = await getIngestCursor("linkedin");
  let taskIndex = typeof stored?.taskIndex === "number" ? stored.taskIndex : 0;
  let start = typeof stored?.start === "number" ? stored.start : 0;
  if (taskIndex < 0 || taskIndex >= tasks.length) {
    taskIndex = 0;
    start = 0;
  }

  let timedOut = false;
  let stoppedByBudget = false;
  let completed = false;

  while (taskIndex < tasks.length) {
    if (jobBudget.totalReached) {
      stoppedByBudget = true;
      break;
    }
    if (Date.now() - startedAt >= timeBudgetMs) {
      timedOut = true;
      break;
    }

    const task = tasks[taskIndex]!;
    // Country cap reached (counting Indeed earlier in the run too): stop looking in this country.
    // A remote task also stops once the country's remote quota is met; the generic block that
    // follows can still use the remaining country budget.
    if (
      jobBudget.countryAtLimit(task.country.iso) ||
      (task.remoteOnly && jobBudget.remoteAtLimit(task.country.iso))
    ) {
      taskIndex += 1;
      start = 0;
      await withTransaction((client) => saveIngestCursor(client, "linkedin", { taskIndex, start }));
      continue;
    }

    let jobs: SourceJob[];
    let cardCount: number;
    try {
      const page = await fetchLinkedInPage({
        country: task.country,
        query: task.query,
        start,
        remoteOnly: task.remoteOnly,
        fetchDetails,
        delayMs,
        signal: options.signal,
      });
      jobs = page.jobs;
      cardCount = page.cardCount;
    } catch (err) {
      stats.errors.push(`${task.country.iso} "${task.query}" start ${start}: ${errorMessage(err)}`);
      taskIndex += 1;
      start = 0;
      await withTransaction((client) => saveIngestCursor(client, "linkedin", { taskIndex, start }));
      continue;
    }

    stats.jobsFetched += jobs.length;
    await processFetched(
      jobs,
      now,
      stats,
      rejectionReasons,
      jobBudget,
      task.country.iso,
      task.remoteOnly,
      companyGuard,
    );

    if (jobBudget.countryAtLimit(task.country.iso)) {
      // Country cap reached: move on instead of paging deeper into it.
      taskIndex += 1;
      start = 0;
    } else if (task.remoteOnly && jobBudget.remoteAtLimit(task.country.iso)) {
      // Remote quota met for this country: stop paging its remote tasks.
      taskIndex += 1;
      start = 0;
    } else if (cardCount === 0) {
      taskIndex += 1;
      start = 0;
    } else {
      start += LINKEDIN_PAGE_SIZE;
      if (start >= maxPages * LINKEDIN_PAGE_SIZE) {
        taskIndex += 1;
        start = 0;
      }
    }

    await withTransaction((client) => saveIngestCursor(client, "linkedin", { taskIndex, start }));
  }

  if (taskIndex >= tasks.length) {
    completed = true;
    // Sweep finished: next invocation starts a fresh pass from the top.
    await withTransaction((client) => saveIngestCursor(client, "linkedin", { taskIndex: 0, start: 0 }));
  }

  stats.details = {
    cursor: { taskIndex, start },
    completed,
    timedOut,
    stoppedByBudget,
    timeBudgetMs,
    elapsedMs: Date.now() - startedAt,
    tasks: tasks.length,
    countries: [...new Set(tasks.map((t) => t.country.iso))],
    maxPages,
    fetchDetails,
    rejectionReasons,
    runBudget: jobBudget.snapshot(),
    companyGuard: companyGuard.snapshot(),
  };

  const status =
    stats.errors.length > 0
      ? stats.jobsFetched > 0
        ? "partial"
        : "failed"
      : timedOut
        ? "partial" // checkpointed mid-sweep; the next run resumes from the cursor
        : "success";
  await withTransaction((client) => finishRun(client, runId, status, stats));

  return { source: "linkedin", status, stats };
}
