import "dotenv/config";
import { randomUUID } from "node:crypto";
import { closePool } from "../db.js";
import { applyRetention } from "../core/retention.js";
import { ingestAll } from "../ingest/pipeline.js";
import type { IngestReport } from "../ingest/types.js";

/**
 * Self-imposed wall-clock budget, kept below Cloud Run's timeout so the job can exit cleanly
 * and persist the LinkedIn resume cursor instead of being killed mid-flight.
 */
export const DEFAULT_SCHEDULER_TIME_BUDGET_MS = 55 * 60 * 1000;

/**
 * Ingestion cadence: 06:00 every 3rd day.
 * Used for the Cloud Scheduler cron expression and documented here as the single source of truth.
 */
export const SCHEDULE_CRON = "0 6 */3 * *";

export interface ScheduledRunResult {
  /** Groups every `runs` row written by this invocation (indeed + linkedin + retention). */
  invocationId: string;
  reports: IngestReport[];
  failed: string[];
  partial: string[];
}

function optionalList(name: string, separator: string): string[] | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parts = value
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Paid Indeed first, then the free LinkedIn sweep, then anything else. */
function sourceRank(name: string): number {
  if (name === "indeed") return 0;
  if (name === "linkedin") return 1;
  return 2;
}

export function orderSources(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => sourceRank(a) - sourceRank(b));
}

/**
 * Run the scheduled ingestion across all configured sources. `ingestAll` isolates each source, so
 * one failed source never prevents the others from completing, and every source writes its own
 * row to `runs`.
 */
export async function runScheduledIngestion(
  invocationId: string = randomUUID(),
): Promise<ScheduledRunResult> {
  const pagesRaw = process.env.INGEST_PAGES?.trim();
  const timeBudgetMs = envInt("SCHEDULER_TIME_BUDGET_MS", DEFAULT_SCHEDULER_TIME_BUDGET_MS);

  const reports = await ingestAll({
    sources: orderSources(optionalList("INGEST_SOURCES", ",") ?? ["indeed", "linkedin"]),
    countries: optionalList("INGEST_COUNTRIES", ",")?.map((c) => c.toUpperCase()),
    queries: optionalList("INGEST_QUERIES", "|"),
    pages: pagesRaw ? Number(pagesRaw) : undefined,
    deadline: Date.now() + timeBudgetMs,
    invocationId,
  });

  return {
    invocationId,
    reports,
    failed: reports.filter((r) => r.status === "failed").map((r) => r.source),
    partial: reports.filter((r) => r.status === "partial").map((r) => r.source),
  };
}

/** Entry point for the Cloud Run Job (`pnpm scheduler`). */
export async function main(): Promise<void> {
  const startedAt = new Date();
  const invocationId = randomUUID();
  console.log(
    JSON.stringify({
      event: "scheduler_start",
      invocationId,
      cron: SCHEDULE_CRON,
      startedAt: startedAt.toISOString(),
    }),
  );

  try {
    const { reports, failed, partial } = await runScheduledIngestion(invocationId);

    for (const report of reports) {
      const s = report.stats;
      console.log(
        JSON.stringify({
          event: "source_finished",
          source: report.source,
          status: report.status,
          fetched: s.jobsFetched,
          accepted: s.jobsAccepted,
          rejected: s.jobsRejected,
          inserted: s.jobsInserted,
          updated: s.jobsUpdated,
          errors: s.errors.length,
          companyCapped: (
            s.details as { companyGuard?: { skipped?: number } } | undefined
          )?.companyGuard?.skipped,
          rejectionReasons: (s.details as { rejectionReasons?: unknown } | undefined)
            ?.rejectionReasons,
        }),
      );
      if (s.errors.length > 0) {
        console.error(JSON.stringify({ event: "source_errors", source: report.source, errors: s.errors }));
      }
    }

    if (failed.length > 0) {
      process.exitCode = 1;
    }

    try {
      const retention = await applyRetention(new Date(), invocationId);
      console.log(JSON.stringify({ event: "retention_finished", ...retention }));
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "retention_error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exitCode = 1;
    }

    console.log(
      JSON.stringify({
        event: "scheduler_finished",
        invocationId,
        durationMs: Date.now() - startedAt.getTime(),
        sources: reports.length,
        failed,
        partial,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "scheduler_error",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

const isDirectRun = process.argv[1]?.endsWith("scheduler/index.ts") ?? false;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
