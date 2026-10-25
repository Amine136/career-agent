import type { AiScore, ScoreableJob } from "../ai/types.js";
import type { PoolClient } from "../db.js";
import type { NormalizedJob } from "./types.js";

export interface JobUpsertResult {
  jobId: string;
  jobInserted: boolean;
  jobUpdated: boolean;
  sourceInserted: boolean;
}

export interface CompanyWindowCount {
  company: string;
  count: number;
}

/**
 * Newly inserted jobs per company inside the trailing window, keyed by the same normalized
 * company name the ingestion guard uses. Used once per ingest invocation to seed the in-memory
 * counters; `first_seen_at` is the ingestion timestamp, so the count reflects how many jobs we
 * actually stored for that company recently.
 */
export async function countJobsByCompanySince(
  client: PoolClient,
  windowDays: number,
  now: Date = new Date(),
): Promise<CompanyWindowCount[]> {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const result = await client.query<CompanyWindowCount>(
    `select coalesce(company_normalized, lower(btrim(company_name))) as company,
            count(*)::int as count
       from jobs
      where first_seen_at >= $1
      group by 1`,
    [since],
  );
  return result.rows;
}

export async function upsertCompany(
  client: PoolClient,
  name: string,
  normalizedName: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into companies (name, normalized_name)
     values ($1, $2)
     on conflict (normalized_name) do update set name = excluded.name
     returning id`,
    [name, normalizedName],
  );
  return result.rows[0]!.id;
}

/**
 * Idempotent upsert of one normalized job.
 * Dedupes by canonical_url first, then by the fuzzy dedupe_key.
 */
export async function upsertJob(client: PoolClient, job: NormalizedJob): Promise<JobUpsertResult> {
  const companyId = await upsertCompany(client, job.company, job.companyNormalized);
  const rawJson = JSON.stringify(job.raw ?? null);

  let existingId: string | null = null;
  const byUrl = await client.query<{ id: string }>("select id from jobs where canonical_url = $1", [
    job.url,
  ]);
  existingId = byUrl.rows[0]?.id ?? null;
  if (!existingId) {
    const byKey = await client.query<{ id: string }>("select id from jobs where dedupe_key = $1", [
      job.dedupeKey,
    ]);
    existingId = byKey.rows[0]?.id ?? null;
  }

  let jobId: string;
  let jobInserted = false;
  let jobUpdated = false;

  if (existingId) {
    jobId = existingId;
    await client.query(
      `update jobs set
         last_seen_at = now(),
         is_active = true,
         company_id = coalesce(company_id, $2),
         company_normalized = $10,
         description = coalesce(description, $3),
         snippet = coalesce(snippet, $4),
         employment_type = coalesce(employment_type, $5),
         seniority = coalesce(seniority, $6),
         experience_requirement = coalesce(experience_requirement, $7),
         posted_at = coalesce(posted_at, $8::date),
         remote = $9,
         updated_at = now()
       where id = $1`,
      [
        jobId,
        companyId,
        job.description,
        job.snippet,
        job.employmentType,
        job.seniority,
        job.experienceRequirement,
        job.postedAt,
        job.remote,
        job.companyNormalized,
      ],
    );
    jobUpdated = true;
  } else {
    const inserted = await client.query<{ id: string }>(
      `insert into jobs (
         canonical_url, dedupe_key, title, title_normalized, company_id, company_name,
         country_code, city, region, remote, employment_type, job_type_weight, seniority,
         entry_level, experience_requirement, description, snippet, language, posted_at, raw,
         company_normalized, source_count
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb,
         $21, 0
       ) returning id`,
      [
        job.url,
        job.dedupeKey,
        job.title,
        job.titleNormalized,
        companyId,
        job.company,
        job.countryCode,
        job.city,
        job.region,
        job.remote,
        job.employmentType,
        job.jobTypeWeight,
        job.seniority,
        job.entryLevel,
        job.experienceRequirement,
        job.description,
        job.snippet,
        job.language,
        job.postedAt,
        rawJson,
        job.companyNormalized,
      ],
    );
    jobId = inserted.rows[0]!.id;
    jobInserted = true;
  }

  const existingSource = await client.query(
    "select 1 from job_sources where source = $1 and source_job_id = $2",
    [job.source, job.sourceJobId],
  );

  let sourceInserted = false;
  if (existingSource.rowCount === 0) {
    await client.query(
      `insert into job_sources (job_id, source, source_job_id, url, raw)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [jobId, job.source, job.sourceJobId, job.url, rawJson],
    );
    await client.query("update jobs set source_count = source_count + 1 where id = $1", [jobId]);
    sourceInserted = true;
  } else {
    await client.query(
      `update job_sources set scraped_at = now(), url = $3, raw = $4::jsonb
       where source = $1 and source_job_id = $2`,
      [job.source, job.sourceJobId, job.url, rawJson],
    );
  }

  return { jobId, jobInserted, jobUpdated, sourceInserted };
}

export type RunStatus = "running" | "success" | "partial" | "failed";

export interface RunStats {
  jobsFetched: number;
  jobsAccepted: number;
  jobsRejected: number;
  jobsInserted: number;
  jobsUpdated: number;
  errors: string[];
  details?: Record<string, unknown>;
}

interface ScoreableJobRow {
  id: string;
  title: string;
  company_name: string;
  country_code: string | null;
  city: string | null;
  region: string | null;
  employment_type: string | null;
  seniority: string | null;
  experience_requirement: string | null;
  description: string | null;
  snippet: string | null;
}

/**
 * Active, not-yet-scored jobs **found on or after `since`** (and, when given, before `until`), in
 * ingestion order. Scoring is scoped to the current pass (normally "everything first seen today")
 * instead of grinding the whole historical catalog: an overflow beyond `limit` is simply left
 * unscored, and each run starts from a fresh, day-bounded candidate set. A failed job stays NULL
 * and is retried if it is still in scope on a later run.
 */
export async function listJobsToScore(
  client: PoolClient,
  limit: number,
  since: Date,
  until?: Date,
): Promise<ScoreableJob[]> {
  const result = await client.query<ScoreableJobRow>(
    `select id, title, company_name, country_code, city, region, employment_type,
            seniority, experience_requirement, description, snippet
       from jobs
      where is_active = true and ai_scored_at is null
        and first_seen_at >= $2
        and ($3::timestamptz is null or first_seen_at < $3)
      order by first_seen_at asc
      limit $1`,
    [limit, since.toISOString(), until?.toISOString() ?? null],
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    companyName: row.company_name,
    countryCode: row.country_code,
    city: row.city,
    // `region` holds the raw source location (e.g. "Berlin, Germany (Remote)"); fall back to the
    // parsed city so the scorer always gets the best available location signal.
    location: row.region ?? row.city,
    employmentType: row.employment_type,
    seniority: row.seniority,
    experienceRequirement: row.experience_requirement,
    description: row.description,
    snippet: row.snippet,
  }));
}

export async function countUnscoredJobs(
  client: PoolClient,
  since: Date,
  until?: Date,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `select count(*)::int as count from jobs
      where is_active = true and ai_scored_at is null
        and first_seen_at >= $1
        and ($2::timestamptz is null or first_seen_at < $2)`,
    [since.toISOString(), until?.toISOString() ?? null],
  );
  return result.rows[0]?.count ?? 0;
}

export async function saveJobScore(
  client: PoolClient,
  jobId: string,
  score: AiScore,
  model: string,
  promptVersion: string,
): Promise<void> {
  await client.query(
    `update jobs set
       ai_score = $2,
       ai_decision = $3,
       ai_confidence = $4,
       ai_reason = $5,
       ai_missing_critical_requirements = $6,
       ai_workplace = $7,
       ai_visa = $8,
       ai_model = $9,
       ai_prompt_version = $10,
       ai_scored_at = now(),
       updated_at = now()
     where id = $1`,
    [
      jobId,
      score.score,
      score.decision,
      score.confidence,
      score.reason,
      score.missing_critical_requirements,
      score.workplace,
      score.visa,
      model,
      promptVersion,
    ],
  );
}

export async function startRun(
  client: PoolClient,
  source: string,
  invocationId?: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    "insert into runs (source, status, invocation_id) values ($1, 'running', $2) returning id",
    [source, invocationId ?? null],
  );
  return result.rows[0]!.id;
}

export async function finishRun(
  client: PoolClient,
  runId: string,
  status: Exclude<RunStatus, "running">,
  stats: RunStats,
): Promise<void> {
  await client.query(
    `update runs set
       finished_at = now(),
       status = $2,
       jobs_fetched = $3,
       jobs_accepted = $4,
       jobs_rejected = $5,
       jobs_inserted = $6,
       jobs_updated = $7,
       error_count = $8,
       stats = $9::jsonb,
       errors = $10::jsonb
     where id = $1`,
    [
      runId,
      status,
      stats.jobsFetched,
      stats.jobsAccepted,
      stats.jobsRejected,
      stats.jobsInserted,
      stats.jobsUpdated,
      stats.errors.length,
      JSON.stringify(stats.details ?? {}),
      JSON.stringify(stats.errors),
    ],
  );
}
