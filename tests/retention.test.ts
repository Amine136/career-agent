import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyRetention, RETENTION_DELETE_DAYS } from "../src/core/retention.js";
import { getPool } from "../src/db.js";
import { closePool, hasDb, migrate, resetTables } from "./helpers/db.js";

const NOW = new Date("2026-09-12T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function insertJob(opts: {
  title: string;
  url: string;
  postedAt: Date;
  lastSeenAt: Date;
  firstSeenAt?: Date;
  active?: boolean;
  createdBy?: string | null;
}): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `insert into jobs (
       title, title_normalized, company_name, country_code, dedupe_key, canonical_url,
       posted_at, first_seen_at, last_seen_at, is_active, entry_level, source_count, created_by
     ) values ($1, $2, 'Acme GmbH', 'DE', $3, $4, $5::date, $6, $7, $8, true, 1, $9)
     returning id`,
    [
      opts.title,
      opts.title.toLowerCase(),
      `${opts.title.toLowerCase()}|de`,
      opts.url,
      iso(opts.postedAt),
      (opts.firstSeenAt ?? opts.lastSeenAt).toISOString(),
      opts.lastSeenAt.toISOString(),
      opts.active ?? true,
      opts.createdBy ?? null,
    ],
  );
  return result.rows[0]!.id;
}

async function userId(): Promise<string> {
  const user = await getPool().query<{ id: string }>(
    "insert into users (email) values ('retention@example.test') returning id",
  );
  return user.rows[0]!.id;
}

describe.skipIf(!hasDb)("retention (requires DATABASE_URL)", () => {
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

  it("deletes scraped jobs untouched for 14 days, keeping fresh and touched ones", async () => {
    await insertJob({ title: "stale", url: "https://example.com/stale", postedAt: daysAgo(2), lastSeenAt: daysAgo(20) });
    await insertJob({ title: "fresh", url: "https://example.com/fresh", postedAt: daysAgo(2), lastSeenAt: daysAgo(1) });
    await insertJob({ title: "ancient", url: "https://example.com/ancient", postedAt: daysAgo(120), lastSeenAt: daysAgo(1) });
    await insertJob({ title: "recent", url: "https://example.com/recent", postedAt: daysAgo(1), lastSeenAt: daysAgo(1) });

    const result = await applyRetention(NOW);
    expect(result).toEqual({ deleted: 1 });

    const rows = await getPool().query<{ title: string }>("select title from jobs order by title");
    expect(rows.rows.map((row) => row.title)).toEqual(["ancient", "fresh", "recent"]);

    const removals = await getPool().query<{ reason: string }>("select reason from job_removals");
    expect(removals.rows).toEqual([{ reason: "retention" }]);
  });

  it("keeps jobs the user saved or applied to, even when ingestion stopped seeing them", async () => {
    const uid = await userId();
    const saved = await insertJob({ title: "saved", url: "https://example.com/saved", postedAt: daysAgo(2), lastSeenAt: daysAgo(20) });
    const applied = await insertJob({ title: "applied", url: "https://example.com/applied", postedAt: daysAgo(2), lastSeenAt: daysAgo(20) });
    await insertJob({ title: "untouched", url: "https://example.com/untouched", postedAt: daysAgo(2), lastSeenAt: daysAgo(20) });

    await getPool().query("insert into saved_jobs (user_id, job_id) values ($1, $2)", [uid, saved]);
    await getPool().query(
      "insert into applications (user_id, job_id, status) values ($1, $2, 'applied')",
      [uid, applied],
    );

    const result = await applyRetention(NOW);
    expect(result).toEqual({ deleted: 1 });

    const rows = await getPool().query<{ title: string }>("select title from jobs order by title");
    expect(rows.rows.map((row) => row.title)).toEqual(["applied", "saved"]);
  });

  it("bounds the cutoff to the documented policy", () => {
    expect(RETENTION_DELETE_DAYS).toBe(14);
  });

  it("is idempotent and records a run", async () => {
    await insertJob({ title: "stale", url: "https://example.com/stale", postedAt: daysAgo(2), lastSeenAt: daysAgo(20) });

    await applyRetention(NOW);
    const second = await applyRetention(NOW);
    expect(second).toEqual({ deleted: 0 });

    const runs = await getPool().query<{ source: string; status: string; jobs_updated: number }>(
      "select source, status, jobs_updated from runs order by started_at",
    );
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows[0]).toMatchObject({ source: "retention", status: "success", jobs_updated: 1 });
    expect(runs.rows[1]).toMatchObject({ source: "retention", status: "success", jobs_updated: 0 });
  });

  it("never deletes user-added jobs", async () => {
    const uid = await userId();
    await insertJob({
      title: "manual",
      url: "https://example.com/manual",
      postedAt: daysAgo(2),
      lastSeenAt: daysAgo(30),
      createdBy: uid,
    });

    const result = await applyRetention(NOW);
    expect(result).toEqual({ deleted: 0 });

    const rows = await getPool().query<{ title: string }>("select title from jobs");
    expect(rows.rows).toEqual([{ title: "manual" }]);
  });
});
