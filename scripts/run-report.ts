#!/usr/bin/env tsx
/**
 * Post-run ingestion report.
 *
 * Groups the `runs` rows of the last N scheduler invocations (linked by `invocation_id`) and
 * prints what actually happened next to what we expected: per-country quota achievement, the
 * remote/non-remote split, how much the company diversity guard skipped, Indeed paid-search
 * efficiency and LinkedIn sweep progress. Anomalies are collected at the end so a run can be
 * judged at a glance.
 *
 * Usage:
 *   pnpm report                 # last 3 invocations
 *   pnpm report --limit=6       # last 6 invocations
 *   pnpm report --json          # machine-readable output
 *   pnpm report --strict        # exit 2 when any anomaly is found (for alerting/CI)
 */

import "dotenv/config";
import { closePool, withClient } from "../src/db.js";

interface RunRow {
  id: string;
  source: string;
  invocation_id: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  jobs_fetched: number;
  jobs_accepted: number;
  jobs_rejected: number;
  jobs_inserted: number;
  jobs_updated: number;
  error_count: number;
  stats: unknown;
  errors: unknown;
}

interface CountryTarget {
  total: number;
  remote: number;
  nonRemote: number;
}

interface BudgetSnapshot {
  maxTotal: number;
  total: number;
  remoteTotal: number;
  skipped: number;
  totalReached: boolean;
  perCountry: Record<string, number>;
  remotePerCountry: Record<string, number>;
  targets?: Record<string, CountryTarget>;
  remoteShare?: number;
}

interface GuardSnapshot {
  enabled: boolean;
  dryRun: boolean;
  cap: number;
  windowDays: number;
  skipped: number;
  cappedCompanies: string[];
}

interface InvocationReport {
  invocationId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  sources: Array<{
    source: string;
    status: string;
    fetched: number;
    accepted: number;
    rejected: number;
    inserted: number;
    updated: number;
    errors: number;
  }>;
  jobs: { fetched: number; accepted: number; rejected: number; inserted: number; updated: number; errors: number };
  budget: BudgetSnapshot | null;
  guard: GuardSnapshot | null;
  indeed: Record<string, unknown> | null;
  linkedin: Record<string, unknown> | null;
  retention: { deleted: number } | null;
  anomalies: string[];
  warnings: string[];
}

// --- small JSON helpers -----------------------------------------------------

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function duration(from: Date, to: Date | null): string {
  if (!to) return "running";
  const ms = to.getTime() - from.getTime();
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function parseArgs(argv: string[]): { limit: number; json: boolean; strict: boolean } {
  let limit = 3;
  let json = false;
  let strict = false;
  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value) && value > 0) limit = Math.floor(value);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    }
  }
  return { limit, json, strict };
}

// --- analysis ---------------------------------------------------------------

function pickBudget(rows: RunRow[]): BudgetSnapshot | null {
  let best: BudgetSnapshot | null = null;
  for (const row of rows) {
    const details = obj(row.stats) ?? {};
    const raw = obj(details.runBudget) ?? obj(details.budget);
    if (!raw) continue;
    const snapshot: BudgetSnapshot = {
      maxTotal: num(raw.maxTotal) ?? 0,
      total: num(raw.total) ?? 0,
      remoteTotal: num(raw.remoteTotal) ?? 0,
      skipped: num(raw.skipped) ?? 0,
      totalReached: raw.totalReached === true,
      perCountry: (obj(raw.perCountry) ?? {}) as Record<string, number>,
      remotePerCountry: (obj(raw.remotePerCountry) ?? {}) as Record<string, number>,
      targets: obj(raw.targets) as Record<string, CountryTarget> | undefined,
      remoteShare: num(raw.remoteShare) ?? undefined,
    };
    if (!best || snapshot.total >= best.total) best = snapshot;
  }
  return best;
}

function pickGuard(rows: RunRow[]): GuardSnapshot | null {
  let skipped = 0;
  let base: Record<string, unknown> | null = null;
  const capped = new Set<string>();
  for (const row of rows) {
    const details = obj(row.stats) ?? {};
    const raw = obj(details.companyGuard);
    if (!raw) continue;
    base = raw;
    skipped = Math.max(skipped, num(raw.skipped) ?? 0);
    for (const name of strArray(raw.cappedCompanies)) capped.add(name);
  }
  if (!base) return null;
  return {
    enabled: base.enabled === true,
    dryRun: base.dryRun === true,
    cap: num(base.cap) ?? 0,
    windowDays: num(base.windowDays) ?? 0,
    skipped,
    cappedCompanies: [...capped].sort(),
  };
}

function detailsOf(row: RunRow): Record<string, unknown> {
  return obj(row.stats) ?? {};
}

function buildInvocation(invocationId: string, rows: RunRow[]): InvocationReport {
  const started = new Date(Math.min(...rows.map((row) => row.started_at.getTime())));
  const finishedTimes = rows.map((row) => row.finished_at?.getTime()).filter((t): t is number => t !== undefined);
  const finished = finishedTimes.length === rows.length ? new Date(Math.max(...finishedTimes)) : null;

  const sources = rows.map((row) => ({
    source: row.source,
    status: row.status,
    fetched: row.jobs_fetched,
    accepted: row.jobs_accepted,
    rejected: row.jobs_rejected,
    inserted: row.jobs_inserted,
    updated: row.jobs_updated,
    errors: row.error_count,
  }));

  const jobs = {
    fetched: sources.reduce((sum, s) => sum + s.fetched, 0),
    accepted: sources.reduce((sum, s) => sum + s.accepted, 0),
    rejected: sources.reduce((sum, s) => sum + s.rejected, 0),
    inserted: sources.reduce((sum, s) => sum + s.inserted, 0),
    updated: sources.reduce((sum, s) => sum + s.updated, 0),
    errors: sources.reduce((sum, s) => sum + s.errors, 0),
  };

  const indeed = rows.find((row) => row.source === "indeed") ?? null;
  const linkedin = rows.find((row) => row.source === "linkedin") ?? null;
  const retention = rows.find((row) => row.source === "retention") ?? null;
  const budget = pickBudget(rows);
  const guard = pickGuard(rows);
  const anomalies: string[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    if (row.status === "failed") anomalies.push(`${row.source}: failed`);
    else if (row.status === "partial") warnings.push(`${row.source}: partial`);
    else if (row.status === "running") anomalies.push(`${row.source}: still running (no finished_at)`);
    if (row.error_count > 0) warnings.push(`${row.source}: ${row.error_count} error(s)`);
  }
  if (jobs.fetched > 0 && jobs.inserted === 0) anomalies.push("no new jobs inserted despite fetched > 0");

  if (budget?.targets) {
    const shortfalls: string[] = [];
    for (const [iso, target] of Object.entries(budget.targets)) {
      const actual = budget.perCountry[iso] ?? 0;
      if (target.total > 0 && actual === 0) anomalies.push(`${iso}: target ${target.total}, inserted 0`);
      else if (target.total > 0 && actual / target.total < 0.5)
        shortfalls.push(`${iso} ${actual}/${target.total} (${pct(actual, target.total)})`);
    }
    if (shortfalls.length > 0) warnings.push(`quota shortfall (<50%): ${shortfalls.join(", ")}`);
    if (budget.remoteShare !== undefined && budget.total > 0) {
      const achieved = budget.remoteTotal / budget.total;
      if (Math.abs(achieved - budget.remoteShare) > 0.1)
        warnings.push(
          `remote share ${pct(budget.remoteTotal, budget.total)} vs target ${pct(budget.remoteShare, 1)}`,
        );
    }
  }

  if (guard && guard.enabled) {
    if (guard.dryRun) warnings.push("company guard is in DRY-RUN mode (nothing actually skipped)");
    if (guard.skipped > 0) {
      warnings.push(
        `${guard.skipped} job(s) skipped by the company cap across ${guard.cappedCompanies.length} compan${guard.cappedCompanies.length === 1 ? "y" : "ies"}`,
      );
    }
  }

  if (indeed) {
    const details = detailsOf(indeed);
    const searches = num(details.searches) ?? 0;
    const acceptedTotal = num(details.acceptedTotal) ?? 0;
    const remaining = num(details.remaining);
    if (searches > 0 && acceptedTotal === 0) warnings.push("indeed: 0 accepted jobs from paid searches");
    if (remaining === 0 && num(details.stoppedByBudget) === 1)
      warnings.push("indeed: rolling paid-search budget exhausted");
  }

  if (linkedin) {
    const details = detailsOf(linkedin);
    if (details.timedOut === true && details.completed !== true) {
      warnings.push("linkedin: timed out mid-sweep (resumes from cursor next run)");
    }
  }

  return {
    invocationId,
    startedAt: started.toISOString(),
    finishedAt: finished?.toISOString() ?? null,
    durationMs: finished ? finished.getTime() - started.getTime() : null,
    sources,
    jobs,
    budget,
    guard,
    indeed: indeed ? detailsOf(indeed) : null,
    linkedin: linkedin ? detailsOf(linkedin) : null,
    retention: retention ? { deleted: num(detailsOf(retention).deleted) ?? 0 } : null,
    anomalies,
    warnings,
  };
}

// --- rendering --------------------------------------------------------------

function render(report: InvocationReport): void {
  const header = report.finishedAt
    ? `${report.startedAt} → ${report.finishedAt} (${duration(new Date(report.startedAt), new Date(report.finishedAt))})`
    : `${report.startedAt} → running`;
  console.log(`\n▶ invocation ${report.invocationId}  ${header}`);
  console.log(`  sources: ${report.sources.map((s) => `${s.source}=${s.status}`).join(" ") || "(none)"}`);
  console.log(
    `  jobs: fetched=${report.jobs.fetched} accepted=${report.jobs.accepted} rejected=${report.jobs.rejected} ` +
      `inserted=${report.jobs.inserted} updated=${report.jobs.updated} errors=${report.jobs.errors}`,
  );

  if (report.budget) {
    const b = report.budget;
    console.log(
      `  quota: ${b.total}/${b.maxTotal} inserted  remote=${b.remoteTotal} (${pct(b.remoteTotal, b.total)})  ` +
        `budget-skipped=${b.skipped}${b.totalReached ? "  [total cap reached]" : ""}`,
    );
    if (b.targets) {
      console.log("    country  target  actual  remote (t)   non-remote (t)");
      for (const [iso, target] of Object.entries(b.targets).sort((a, c) => c[1].total - a[1].total)) {
        const actual = b.perCountry[iso] ?? 0;
        const remote = b.remotePerCountry[iso] ?? 0;
        console.log(
          `    ${iso.padEnd(7)}  ${String(target.total).padStart(6)}  ${String(actual).padStart(6)}  ` +
            `${String(remote).padStart(4)}/${String(target.remote).padEnd(4)}  ` +
            `${String(actual - remote).padStart(4)}/${String(target.nonRemote).padEnd(4)}`,
        );
      }
    }
  }

  if (report.guard) {
    const g = report.guard;
    const top = g.cappedCompanies.slice(0, 5).join(", ");
    console.log(
      `  companies: cap=${g.cap}/${g.windowDays}d${g.dryRun ? " (dry-run)" : ""} ` +
        `skipped=${g.skipped} capped=${g.cappedCompanies.length}${top ? `  top: ${top}` : ""}`,
    );
  }

  if (report.indeed) {
    const d = report.indeed;
    console.log(
      `  indeed: searches=${num(d.searches) ?? 0} remote=${num(d.remoteSearches) ?? 0} ` +
        `accepted=${num(d.acceptedTotal) ?? 0} remaining=${num(d.remaining) ?? "?"} ` +
        `stoppedByBudget=${d.stoppedByBudget === true}`,
    );
  }

  if (report.linkedin) {
    const d = report.linkedin;
    const cursor = obj(d.cursor) ?? {};
    console.log(
      `  linkedin: tasks=${num(d.tasks) ?? "?"} cursor=${num(cursor.taskIndex) ?? "?"}/${num(cursor.start) ?? "?"} ` +
        `completed=${d.completed === true} timedOut=${d.timedOut === true} elapsed=${Math.round((num(d.elapsedMs) ?? 0) / 60000)}m`,
    );
  }

  if (report.retention) console.log(`  retention: deleted=${report.retention.deleted}`);
}

function renderSummary(reports: InvocationReport[]): void {
  const anomalies = reports.flatMap((r) => r.anomalies.map((a) => `${r.invocationId.slice(0, 8)} ${a}`));
  const warnings = reports.flatMap((r) => r.warnings.map((w) => `${r.invocationId.slice(0, 8)} ${w}`));

  console.log("\n── summary ─────────────────────────────────────────────");
  if (reports.length === 0) {
    console.log("no invocations found (runs.invocation_id is only set on new runs)");
    return;
  }
  const totalInserted = reports.reduce((sum, r) => sum + r.jobs.inserted, 0);
  const totalRemote = reports.reduce((sum, r) => sum + (r.budget?.remoteTotal ?? 0), 0);
  console.log(
    `invocations=${reports.length} inserted=${totalInserted} remote=${totalRemote} (${pct(totalRemote, totalInserted)}) ` +
      `anomalies=${anomalies.length} warnings=${warnings.length}`,
  );
  for (const line of anomalies) console.log(`  ✖ ${line}`);
  for (const line of warnings) console.log(`  ⚠ ${line}`);
  if (anomalies.length === 0 && warnings.length === 0) console.log("  ✓ ran as expected");
}

async function main(): Promise<void> {
  const { limit, json, strict } = parseArgs(process.argv.slice(2));

  let rows: RunRow[];
  try {
    rows = await withClient(async (client) => {
      const result = await client.query<RunRow>(
        `select id, source, invocation_id, status, started_at, finished_at,
              jobs_fetched, jobs_accepted, jobs_rejected, jobs_inserted, jobs_updated,
              error_count, stats, errors
         from runs
        where invocation_id in (
          select invocation_id
            from runs
           where invocation_id is not null
           group by invocation_id
           order by max(started_at) desc
           limit $1
        )
        order by started_at asc`,
        [limit],
      );
      return result.rows;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "42703") {
      console.error(
        "runs.invocation_id is missing — apply the latest migrations (`pnpm migrate`, 0020_runs_invocation.sql).",
      );
      await closePool();
      process.exit(1);
    }
    throw err;
  }

  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const group = groups.get(row.invocation_id) ?? [];
    group.push(row);
    groups.set(row.invocation_id, group);
  }

  const reports = [...groups.entries()].map(([id, group]) => buildInvocation(id, group));

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    console.log(`Ingestion run report — last ${reports.length} invocation(s)`);
    for (const report of reports) render(report);
    renderSummary(reports);
  }

  if (strict && reports.some((report) => report.anomalies.length > 0)) process.exitCode = 2;

  await closePool();
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
