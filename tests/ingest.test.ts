import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeSourceJob } from "../src/core/normalize.js";
import { upsertJob } from "../src/core/repository.js";
import { getPool, withTransaction } from "../src/db.js";
import { IngestBudget } from "../src/ingest/budget.js";
import { CompanyGuard } from "../src/ingest/company-guard.js";
import { ingestSource, ingestAll } from "../src/ingest/pipeline.js";
import { emptyStats, processFetched } from "../src/ingest/process.js";
import { SOURCE_ADAPTERS, type SourceAdapter } from "../src/sources/index.js";
import { closePool, hasDb, migrate, resetTables } from "./helpers/db.js";
import { makeSourceJob } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-12T12:00:00Z");

/** Distinct, fresh, entry-level jobs so each one survives the hard filters and dedupe. */
function distinctJobs(prefix: string, count: number): ReturnType<typeof makeSourceJob>[] {
  return Array.from({ length: count }, (_, index) =>
    makeSourceJob({
      source: prefix,
      sourceJobId: `${prefix}-${index}`,
      url: `https://example.com/${prefix}/${index}`,
      title: `Junior AI Engineer ${prefix} ${index}`,
      city: `City ${index}`,
      postedAt: "2026-09-10",
    }),
  );
}

const fakeAdapter: SourceAdapter = {
  name: "fake",
  fetchJobs: async () => [
    makeSourceJob({
      source: "fake",
      sourceJobId: "job-1",
      title: "Junior AI Engineer",
      employmentTypeRaw: "Full-time",
    }),
  ],
};

describe.skipIf(!hasDb)("ingestion (requires DATABASE_URL)", () => {
  beforeAll(async () => {
    await migrate();
  });

  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await resetTables();
    await closePool();
  });

  it("records the invocation id on the source run row", async () => {
    const invocationId = "11111111-1111-4111-8111-111111111111";

    await ingestSource(fakeAdapter, {
      countries: ["DE"],
      queries: ["AI Engineer"],
      now: NOW,
      invocationId,
    });

    const result = await getPool().query<{ invocation_id: string }>(
      "select invocation_id from runs where source = 'fake' order by started_at desc limit 1",
    );
    expect(result.rows[0]!.invocation_id).toBe(invocationId);
  });

  it("does not duplicate jobs when the same source runs twice", async () => {
    const first = await ingestSource(fakeAdapter, {
      countries: ["DE"],
      queries: ["AI Engineer"],
      now: NOW,
    });
    const second = await ingestSource(fakeAdapter, {
      countries: ["DE"],
      queries: ["AI Engineer"],
      now: NOW,
    });

    expect(first.stats.jobsInserted).toBe(1);
    expect(second.stats.jobsInserted).toBe(0);
    expect(second.stats.jobsUpdated).toBe(1);

    const pool = getPool();
    const jobs = await pool.query<{ c: number }>("select count(*)::int as c from jobs");
    const sources = await pool.query<{ c: number }>("select count(*)::int as c from job_sources");
    const sourceCount = await pool.query<{ source_count: number }>(
      "select source_count from jobs limit 1",
    );
    expect(jobs.rows[0]!.c).toBe(1);
    expect(sources.rows[0]!.c).toBe(1);
    expect(sourceCount.rows[0]!.source_count).toBe(1);
  });

  it("records one run per ingestion", async () => {
    await ingestSource(fakeAdapter, { countries: ["DE"], queries: ["AI Engineer"], now: NOW });
    await ingestSource(fakeAdapter, { countries: ["DE"], queries: ["AI Engineer"], now: NOW });
    const runs = await getPool().query<{ c: number }>("select count(*)::int as c from runs");
    expect(runs.rows[0]!.c).toBe(2);
  });

  it("merges the same role from two sources into one job with two source rows", async () => {    const fromLinkedIn = normalizeSourceJob(
      makeSourceJob({
        source: "linkedin",
        sourceJobId: "li-1",
        url: "https://www.linkedin.com/jobs/view/li-1",
      }),
    );
    const fromIndeed = normalizeSourceJob(
      makeSourceJob({
        source: "indeed",
        sourceJobId: "in-1",
        url: "https://de.indeed.com/viewjob?jk=in-1",
      }),
    );

    await withTransaction((client) => upsertJob(client, fromLinkedIn));
    await withTransaction((client) => upsertJob(client, fromIndeed));

    const pool = getPool();
    const jobs = await pool.query<{ c: number }>("select count(*)::int as c from jobs");
    const sources = await pool.query<{ c: number }>("select count(*)::int as c from job_sources");
    const sourceCount = await pool.query<{ source_count: number }>(
      "select source_count from jobs limit 1",
    );
    expect(jobs.rows[0]!.c).toBe(1);
    expect(sources.rows[0]!.c).toBe(2);
    expect(sourceCount.rows[0]!.source_count).toBe(2);
  });

  it("continues with other sources when one fails and records a run per source", async () => {
    const good: SourceAdapter = {
      name: "good",
      fetchJobs: async () => [
        makeSourceJob({
          source: "good",
          sourceJobId: "good-1",
          title: "Junior AI Engineer",
          employmentTypeRaw: "Full-time",
        }),
      ],
    };
    const bad: SourceAdapter = {
      name: "bad",
      fetchJobs: async () => {
        throw new Error("source exploded");
      },
    };
    const registry = SOURCE_ADAPTERS as Record<string, SourceAdapter>;
    registry.good = good;
    registry.bad = bad;
    try {
      const reports = await ingestAll({
        sources: ["bad", "good"],
        countries: ["DE"],
        queries: ["AI Engineer"],
        now: NOW,
      });
      expect(reports.map((r) => `${r.source}:${r.status}`)).toEqual(["bad:failed", "good:success"]);

      const runs = await getPool().query<{ source: string; status: string; error_count: number }>(
        "select source, status, error_count from runs order by source",
      );
      expect(runs.rows.map((r) => r.source)).toEqual(["bad", "good"]);
      expect(runs.rows[0]!.status).toBe("failed");
      expect(runs.rows[0]!.error_count).toBeGreaterThan(0);
      expect(runs.rows[1]!.status).toBe("success");
    } finally {
      delete registry.good;
      delete registry.bad;
    }
  });

  it("stops accepting once the run total cap is reached", async () => {
    const adapter: SourceAdapter = {
      name: "capped",
      fetchJobs: async () => distinctJobs("capped", 3),
    };

    const report = await ingestSource(adapter, {
      countries: ["DE"],
      queries: ["AI Engineer"],
      now: NOW,
      budget: new IngestBudget({ maxTotal: 2, maxPerCountry: 100 }),
    });

    expect(report.stats.jobsAccepted).toBe(2);
    const jobs = await getPool().query<{ c: number }>("select count(*)::int as c from jobs");
    expect(jobs.rows[0]!.c).toBe(2);
  });

  it("counts only confirmed-remote jobs against the remote quota on a remote pass", async () => {
    const budget = new IngestBudget({ maxTotal: 100, maxPerCountry: 10, maxRemotePerCountry: 2 });
    const raws = [
      makeSourceJob({ sourceJobId: "r-1", title: "Junior AI Engineer A", url: "https://example.com/r-1" }),
      makeSourceJob({
        sourceJobId: "r-2",
        title: "Junior AI Engineer B",
        url: "https://example.com/r-2",
        remote: true,
      }),
      makeSourceJob({ sourceJobId: "r-3", title: "Junior AI Engineer C", url: "https://example.com/r-3" }),
    ];
    const stats = emptyStats();

    await processFetched(raws, NOW, stats, {}, budget, "DE", true);

    // The two on-site hits came from the remote pass but must not consume the remote quota.
    expect(stats.jobsAccepted).toBe(3);
    expect(budget.remoteCount("DE")).toBe(1);
    expect(budget.remoteAtLimit("DE")).toBe(false);
  });

  it("shares the per-country cap across sources in one run", async () => {
    const budget = new IngestBudget({ maxTotal: 100, maxPerCountry: 3 });
    const first: SourceAdapter = { name: "a", fetchJobs: async () => distinctJobs("a", 2) };
    const second: SourceAdapter = { name: "b", fetchJobs: async () => distinctJobs("b", 2) };

    const r1 = await ingestSource(first, {
      countries: ["DE"],
      queries: ["AI Engineer"],
      now: NOW,
      budget,
    });
    const r2 = await ingestSource(second, {
      countries: ["DE"],
      queries: ["AI Engineer"],
      now: NOW,
      budget,
    });

    expect(r1.stats.jobsAccepted).toBe(2);
    expect(r2.stats.jobsAccepted).toBe(1);
    expect(budget.count("DE")).toBe(3);
    expect(budget.countryAtLimit("DE")).toBe(true);
  });

  it("skips jobs once a company reaches its window cap", async () => {
    const guard = new CompanyGuard({ cap: 2, windowDays: 10 });
    const raws = ["a", "b", "c"].map((suffix, index) =>
      makeSourceJob({
        source: "acme",
        sourceJobId: `acme-${suffix}`,
        url: `https://example.com/acme/${suffix}`,
        title: `Junior AI Engineer ${suffix}`,
        city: `City ${index}`,
      }),
    );
    const stats = emptyStats();

    await processFetched(raws, NOW, stats, {}, undefined, "DE", false, guard);

    expect(stats.jobsAccepted).toBe(2);
    expect(stats.jobsInserted).toBe(2);
    expect(guard.count("Acme GmbH")).toBe(2);
    expect(guard.snapshot().cappedCompanies).toEqual(["acme gmbh"]);
  });

  it("records dry-run company skips without dropping the jobs", async () => {
    const guard = new CompanyGuard({ cap: 1, windowDays: 10, dryRun: true });
    const raws = ["a", "b"].map((suffix, index) =>
      makeSourceJob({
        source: "acme",
        sourceJobId: `acme-${suffix}`,
        url: `https://example.com/acme/${suffix}`,
        title: `Junior AI Engineer ${suffix}`,
        city: `City ${index}`,
      }),
    );
    const stats = emptyStats();

    await processFetched(raws, NOW, stats, {}, undefined, "DE", false, guard);

    expect(stats.jobsInserted).toBe(2);
    expect(guard.snapshot().skipped).toBe(1);
  });

  it("loads per-company counts from the trailing window", async () => {
    const normalized = normalizeSourceJob(makeSourceJob());
    await withTransaction((client) => upsertJob(client, normalized));

    const guard = await CompanyGuard.load({ cap: 1, windowDays: 10 }, NOW);

    expect(guard.count(normalized.companyNormalized)).toBe(1);
    expect(guard.atCap(normalized.companyNormalized)).toBe(true);
  });
});
