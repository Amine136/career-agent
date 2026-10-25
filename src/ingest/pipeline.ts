import { randomUUID } from "node:crypto";
import { enabledCountries, queriesForLanguages } from "../../config/index.js";
import { finishRun, startRun } from "../core/repository.js";
import { withTransaction } from "../db.js";
import { SOURCE_ADAPTERS, type SourceAdapter } from "../sources/index.js";
import { IngestBudget, resolveIngestLimits } from "./budget.js";
import { CompanyGuard } from "./company-guard.js";
import { ingestIndeed } from "./indeed.js";
import { ingestLinkedIn } from "./linkedin.js";
import { emptyStats, errorMessage, processFetched } from "./process.js";
import { DEFAULT_SOURCES, type IngestOptions, type IngestReport } from "./types.js";

export { DEFAULT_SOURCES };
export type { IngestOptions, IngestReport };

/**
 * Generic ingestion path: fetch a fixed number of pages per (country, query) from any adapter,
 * then validate/normalize/filter/upsert. LinkedIn and Indeed use dedicated strategies (see
 * `ingest/linkedin.ts` and `ingest/indeed.ts`) and are dispatched from [ingestAll].
 */
export async function ingestSource(
  adapter: SourceAdapter,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const now = options.now ?? new Date();
  const available = enabledCountries();
  const selected =
    options.countries && options.countries.length > 0
      ? available.filter((c) => options.countries!.includes(c.iso))
      : available;

  const stats = emptyStats();
  const rejectionReasons: Record<string, number> = {};
  const runId = await withTransaction((client) =>
    startRun(client, adapter.name, options.invocationId),
  );
  const budget = options.budget ?? new IngestBudget(resolveIngestLimits());
  const companyGuard = options.companyGuard ?? (await CompanyGuard.load(undefined, now));
  let stoppedByBudget = false;

  for (const country of selected) {
    if (budget.totalReached) {
      stoppedByBudget = true;
      break;
    }
    if (budget.countryAtLimit(country.iso)) {
      continue;
    }

    const queries =
      options.queries && options.queries.length > 0
        ? options.queries
        : queriesForLanguages(country.languages);

    for (const query of queries) {
      if (budget.totalReached) {
        stoppedByBudget = true;
        break;
      }
      if (budget.countryAtLimit(country.iso)) {
        break;
      }

      let fetched;
      try {
        fetched = await adapter.fetchJobs({
          country,
          query,
          pages: options.pages,
          signal: options.signal,
        });
      } catch (err) {
        stats.errors.push(`${country.iso} "${query}": ${errorMessage(err)}`);
        continue;
      }

      stats.jobsFetched += fetched.length;
      await processFetched(fetched, now, stats, rejectionReasons, budget, country.iso, false, companyGuard);
    }
  }

  const status = stats.errors.length > 0 ? (stats.jobsFetched > 0 ? "partial" : "failed") : "success";
  stats.details = {
    rejectionReasons,
    countries: selected.map((c) => c.iso),
    stoppedByBudget,
    budget: budget.snapshot(),
    companyGuard: companyGuard.snapshot(),
  };
  await withTransaction((client) => finishRun(client, runId, status, stats));

  return { source: adapter.name, status, stats };
}

export async function ingestAll(options: IngestOptions = {}): Promise<IngestReport[]> {
  const names = options.sources && options.sources.length > 0 ? options.sources : DEFAULT_SOURCES;
  const reports: IngestReport[] = [];
  // One budget for the whole run so the per-country cap counts Indeed and LinkedIn together.
  const budget = options.budget ?? new IngestBudget(resolveIngestLimits());
  // One company guard for the whole run, seeded from the trailing window, so inserts from an
  // earlier source count against the same per-company cap in the next source.
  const companyGuard =
    options.companyGuard ?? (await CompanyGuard.load(undefined, options.now ?? new Date()));
  const invocationId = options.invocationId ?? randomUUID();
  const shared: IngestOptions = { ...options, budget, companyGuard, invocationId };

  for (const name of names) {
    try {
      if (name === "linkedin") {
        const timeBudgetMs =
          options.deadline !== undefined
            ? Math.max(0, options.deadline - Date.now())
            : undefined;
        reports.push(await ingestLinkedIn({ ...shared, timeBudgetMs }));
      } else if (name === "indeed") {
        reports.push(await ingestIndeed(shared));
      } else {
        const adapter = SOURCE_ADAPTERS[name];
        if (!adapter) {
          reports.push({
            source: name,
            status: "failed",
            stats: { ...emptyStats(), errors: [`unknown source: ${name}`] },
          });
          continue;
        }
        reports.push(await ingestSource(adapter, shared));
      }
    } catch (err) {
      reports.push({
        source: name,
        status: "failed",
        stats: { ...emptyStats(), errors: [errorMessage(err)] },
      });
    }
  }

  return reports;
}
