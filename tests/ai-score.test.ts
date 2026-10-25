import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildJobBlock, buildPrompt, JOB_DESCRIPTION_MAX_CHARS, PROMPT_VERSION, truncate } from "../src/ai/prompt.js";
import { reserveAiRequest } from "../src/ai/rate-limit.js";
import { scorePendingJobs } from "../src/ai/scorer.js";
import { aiScoreSchema, type AiScore, type ScoreableJob } from "../src/ai/types.js";
import {
  isNonRetryableProviderError,
  ProviderError,
  type LlmProvider,
  type ScoreRequest,
} from "../src/ai/provider.js";
import { getPool } from "../src/db.js";
import { closePool, hasDb, migrate, resetTables } from "./helpers/db.js";

const baseJob: ScoreableJob = {
  id: "job-1",
  title: "Junior AI Engineer",
  companyName: "Acme GmbH",
  countryCode: "DE",
  city: "Berlin",
  location: "Berlin, Germany (Remote)",
  employmentType: "Full-time",
  seniority: null,
  experienceRequirement: "0-2 years",
  description: "Build AI systems.",
  snippet: null,
};

class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly calls: ScoreableJob[] = [];
  constructor(
    private readonly result: AiScore | ((job: ScoreableJob) => AiScore),
    private readonly failingIds: Set<string> = new Set(),
    readonly model = "fake-model",
  ) {}

  async score({ job }: ScoreRequest): Promise<AiScore> {
    this.calls.push(job);
    if (this.failingIds.has(job.title)) throw new Error("model exploded");
    return typeof this.result === "function" ? this.result(job) : this.result;
  }
}

const KEEP_SCORE: AiScore = {
  score: 82,
  decision: "KEEP",
  confidence: 91,
  workplace: "remote",
  visa: "sponsors",
  missing_critical_requirements: [],
  reason: "Good match.",
};

describe("ai types", () => {
  it("normalizes REJECT/DISCARD to DISCARD and rounds numeric strings", () => {
    const parsed = aiScoreSchema.parse({
      score: "78.4",
      decision: "reject",
      confidence: 90.6,
      missing_critical_requirements: ["German C1"],
      reason: "Language is mandatory.",
    });
    expect(parsed).toEqual({
      score: 78,
      decision: "DISCARD",
      confidence: 91,
      workplace: "unknown",
      visa: "unknown",
      missing_critical_requirements: ["German C1"],
      reason: "Language is mandatory.",
    });
  });

  it("normalizes workplace and defaults missing values to unknown", () => {
    const base = {
      score: 70,
      decision: "KEEP",
      confidence: 80,
      missing_critical_requirements: [],
      reason: "",
    };
    expect(aiScoreSchema.parse({ ...base, workplace: "Remote" }).workplace).toBe("remote");
    expect(aiScoreSchema.parse({ ...base, workplace: "hybrid" }).workplace).toBe("hybrid");
    expect(aiScoreSchema.parse({ ...base, workplace: "on-site" }).workplace).toBe("onsite");
    expect(aiScoreSchema.parse({ ...base, workplace: "flexible" }).workplace).toBe("unknown");
    expect(aiScoreSchema.parse(base).workplace).toBe("unknown");
  });

  it("normalizes visa sponsorship and defaults missing values to unknown", () => {
    const base = {
      score: 70,
      decision: "KEEP",
      confidence: 80,
      missing_critical_requirements: [],
      reason: "",
    };
    expect(aiScoreSchema.parse({ ...base, visa: "Sponsors" }).visa).toBe("sponsors");
    expect(aiScoreSchema.parse({ ...base, visa: "visa sponsorship available" }).visa).toBe(
      "sponsors",
    );
    expect(aiScoreSchema.parse({ ...base, visa: "no sponsorship" }).visa).toBe("no_sponsorship");
    expect(aiScoreSchema.parse({ ...base, visa: "We cannot sponsor" }).visa).toBe(
      "no_sponsorship",
    );
    expect(aiScoreSchema.parse({ ...base, visa: "maybe" }).visa).toBe("unknown");
    expect(aiScoreSchema.parse(base).visa).toBe("unknown");
  });

  it("rejects out-of-range scores", () => {
    expect(() => aiScoreSchema.parse({ ...KEEP_SCORE, score: 140 })).toThrow();
  });

  it("classifies provider errors as retryable or not", () => {
    expect(isNonRetryableProviderError(new ProviderError("bad request", 400))).toBe(true);
    expect(isNonRetryableProviderError(new ProviderError("not found", 404))).toBe(true);
    expect(isNonRetryableProviderError(new ProviderError("unauthorized", 401))).toBe(true);
    expect(isNonRetryableProviderError(new ProviderError("rate limited", 429))).toBe(false);
    expect(isNonRetryableProviderError(new ProviderError("server error", 500))).toBe(false);
    expect(isNonRetryableProviderError(new Error("network"))).toBe(false);
  });
});

describe("ai prompt", () => {
  it("caps the job block at 10000 characters", () => {
    const block = buildJobBlock({ ...baseJob, description: "x".repeat(50_000) });
    expect(block.length).toBe(JOB_DESCRIPTION_MAX_CHARS);
    expect(truncate("abc", 2)).toBe("ab");
  });

  it("includes the static profile and the job details", () => {
    const prompt = buildPrompt(baseJob);
    expect(prompt).not.toContain("{{JOB_DESCRIPTION}}");
    expect(prompt).not.toContain("{{CANDIDATE_PROFILE}}");
    expect(prompt).toContain("Example degree in Computer Science");
    expect(prompt).toContain("conservative AI job-matching evaluator");
    expect(prompt).toContain("Title: Junior AI Engineer");
    expect(prompt).toContain("Location: Berlin, Germany (Remote)");
    expect(prompt).toContain("Experience requirement: 0-2 years");
    expect(prompt).toContain("Build AI systems.");
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\./);
  });
});

describe.skipIf(!hasDb)("ai scorer (requires DATABASE_URL)", () => {
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

  /** UTC midnight `days` whole days before today. */
  function utcDayStart(days: number): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 86_400_000,
    );
  }

  /** Midday of the UTC day `days` ago, safely inside that day's lookback window. */
  function daysAgoNoon(days: number): Date {
    return new Date(utcDayStart(days).getTime() + 12 * 3_600_000);
  }

  async function insertJob(opts: {
    title: string;
    url: string;
    description?: string;
    active?: boolean;
    scored?: boolean;
    firstSeenAt?: Date;
  }): Promise<void> {
    await getPool().query(
      `insert into jobs (
         title, title_normalized, company_name, country_code, dedupe_key, canonical_url,
         description, is_active, entry_level, source_count, ai_scored_at, first_seen_at
       ) values ($1, $2, 'Acme GmbH', 'DE', $3, $4, $5, $6, true, 1, $7, $8)`,
      [
        opts.title,
        opts.title.toLowerCase(),
        `${opts.title.toLowerCase()}|de`,
        opts.url,
        opts.description ?? null,
        opts.active ?? true,
        opts.scored ? new Date().toISOString() : null,
        (opts.firstSeenAt ?? new Date()).toISOString(),
      ],
    );
  }

  it("scores pending active jobs and persists every field", async () => {
    await insertJob({ title: "keep me", url: "https://example.com/keep" });
    await insertJob({ title: "discard me", url: "https://example.com/discard" });
    await insertJob({ title: "already scored", url: "https://example.com/done", scored: true });
    await insertJob({ title: "inactive", url: "https://example.com/inactive", active: false });

    const provider = new FakeProvider((job) =>
      job.title.includes("discard")
        ? { ...KEEP_SCORE, score: 12, decision: "DISCARD", missing_critical_requirements: ["German C1"] }
        : KEEP_SCORE,
    );

    const result = await scorePendingJobs({ providers: [provider], limit: 10 });

    expect(result).toMatchObject({ status: "success", scored: 2, failed: 0, remaining: 0 });
    expect(provider.calls.map((j) => j.title).sort()).toEqual(["discard me", "keep me"]);

    const rows = await getPool().query<{
      title: string;
      ai_score: number | null;
      ai_decision: string | null;
      ai_reason: string | null;
      ai_workplace: string | null;
      ai_visa: string | null;
      is_sponsored: boolean;
      ai_model: string | null;
      ai_prompt_version: string | null;
      ai_missing_critical_requirements: string[];
    }>(
      `select title, ai_score, ai_decision, ai_reason, ai_workplace, ai_visa, is_sponsored,
              ai_model, ai_prompt_version, ai_missing_critical_requirements
         from jobs order by title`,
    );
    const byTitle = Object.fromEntries(rows.rows.map((r) => [r.title, r]));
    expect(byTitle["keep me"]).toMatchObject({
      ai_score: 82,
      ai_decision: "KEEP",
      ai_reason: "Good match.",
      ai_workplace: "remote",
      ai_visa: "sponsors",
      is_sponsored: true,
      ai_model: "fake-model",
      ai_prompt_version: PROMPT_VERSION,
      ai_missing_critical_requirements: [],
    });
    expect(byTitle["discard me"]).toMatchObject({
      ai_decision: "DISCARD",
      ai_missing_critical_requirements: ["German C1"],
    });
    expect(byTitle["already scored"]!.ai_decision).toBeNull();
    expect(byTitle["inactive"]!.ai_decision).toBeNull();

    const runs = await getPool().query<{ source: string; status: string; jobs_updated: number }>(
      "select source, status, jobs_updated from runs",
    );
    expect(runs.rows[0]).toMatchObject({ source: "ai-score", status: "success", jobs_updated: 2 });
  });

  it("is one-shot: a second run finds nothing to score", async () => {
    await insertJob({ title: "keep me", url: "https://example.com/keep" });
    const provider = new FakeProvider(KEEP_SCORE);

    await scorePendingJobs({ providers: [provider], limit: 10 });
    const second = await scorePendingJobs({ providers: [provider], limit: 10 });

    expect(second).toMatchObject({ status: "success", scored: 0, failed: 0, remaining: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it("leaves failed jobs pending and records a failed run", async () => {
    await insertJob({ title: "keep me", url: "https://example.com/keep" });
    const provider = new FakeProvider(KEEP_SCORE, new Set(["keep me"]));

    const result = await scorePendingJobs({ providers: [provider], limit: 10 });

    expect(result).toMatchObject({ status: "failed", scored: 0, failed: 1, remaining: 1 });
    const row = await getPool().query<{ ai_scored_at: string | null }>(
      "select ai_scored_at from jobs",
    );
    expect(row.rows[0]!.ai_scored_at).toBeNull();
    const run = await getPool().query<{ status: string; error_count: number }>(
      "select status, error_count from runs",
    );
    expect(run.rows[0]).toMatchObject({ status: "failed" });
    expect(run.rows[0]!.error_count).toBe(1);
  });

  it("respects the limit and stops on the time budget", async () => {
    await insertJob({ title: "one", url: "https://example.com/one" });
    await insertJob({ title: "two", url: "https://example.com/two" });
    const provider = new FakeProvider(KEEP_SCORE);

    const result = await scorePendingJobs({ providers: [provider], limit: 1 });
    expect(result.scored).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it("scores the whole lookback window oldest-first and skips older finds", async () => {
    await insertJob({ title: "recent", url: "https://example.com/recent", firstSeenAt: daysAgoNoon(1) });
    await insertJob({ title: "older", url: "https://example.com/older", firstSeenAt: daysAgoNoon(2) });
    await insertJob({ title: "ancient", url: "https://example.com/ancient", firstSeenAt: daysAgoNoon(5) });
    const provider = new FakeProvider(KEEP_SCORE);

    const result = await scorePendingJobs({ providers: [provider], limit: 10, lookbackDays: 3 });

    expect(result).toMatchObject({ status: "success", scored: 2, failed: 0, remaining: 0 });
    expect(provider.calls.map((j) => j.title)).toEqual(["older", "recent"]);

    const ancient = await getPool().query<{ ai_scored_at: string | null }>(
      "select ai_scored_at from jobs where title = 'ancient'",
    );
    expect(ancient.rows[0]!.ai_scored_at).toBeNull();
  });

  it("defaults to today only when lookbackDays is 1", async () => {
    await insertJob({ title: "today", url: "https://example.com/today", firstSeenAt: daysAgoNoon(0) });
    await insertJob({ title: "yesterday", url: "https://example.com/yesterday", firstSeenAt: daysAgoNoon(1) });
    const provider = new FakeProvider(KEEP_SCORE);

    const result = await scorePendingJobs({ providers: [provider], limit: 10, lookbackDays: 1 });

    expect(result).toMatchObject({ status: "success", scored: 1, remaining: 0 });
    expect(provider.calls.map((j) => j.title)).toEqual(["today"]);
  });

  it("carries over the previous day's leftovers on a later pass", async () => {
    await insertJob({ title: "leftover", url: "https://example.com/leftover", firstSeenAt: daysAgoNoon(1) });
    const provider = new FakeProvider(KEEP_SCORE);

    const first = await scorePendingJobs({ providers: [provider], limit: 10, lookbackDays: 1 });
    expect(first).toMatchObject({ scored: 0, remaining: 0 });
    expect(provider.calls).toHaveLength(0);

    const second = await scorePendingJobs({ providers: [provider], limit: 10, lookbackDays: 3 });
    expect(second).toMatchObject({ status: "success", scored: 1, remaining: 0 });
    expect(provider.calls.map((j) => j.title)).toEqual(["leftover"]);
  });

  it("lets an explicit since override the lookback window", async () => {
    await insertJob({ title: "old but requested", url: "https://example.com/old", firstSeenAt: daysAgoNoon(10) });
    const provider = new FakeProvider(KEEP_SCORE);

    const result = await scorePendingJobs({
      providers: [provider],
      limit: 10,
      lookbackDays: 1,
      since: utcDayStart(11),
    });

    expect(result).toMatchObject({ status: "success", scored: 1, remaining: 0 });
    expect(provider.calls.map((j) => j.title)).toEqual(["old but requested"]);
  });

  it("enforces the per-minute request budget", async () => {
    const rateLimit = { maxPerMinute: 2, maxPerDay: 100 };

    expect((await reserveAiRequest("test-model", rateLimit)).allowed).toBe(true);
    expect((await reserveAiRequest("test-model", rateLimit)).allowed).toBe(true);

    const third = await reserveAiRequest("test-model", rateLimit);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("per_minute");
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.remainingToday).toBe(98);
  });

  it("enforces the per-day request budget", async () => {
    const rateLimit = { maxPerMinute: 100, maxPerDay: 2 };

    expect((await reserveAiRequest("test-model", rateLimit)).allowed).toBe(true);
    expect((await reserveAiRequest("test-model", rateLimit)).allowed).toBe(true);

    const third = await reserveAiRequest("test-model", rateLimit);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("per_day");
    expect(third.remainingToday).toBe(0);
  });

  it("tracks daily budgets independently per model", async () => {
    const rateLimit = { maxPerMinute: 100, maxPerDay: 1 };
    expect((await reserveAiRequest("model-a", rateLimit)).allowed).toBe(true);
    expect((await reserveAiRequest("model-a", rateLimit)).reason).toBe("per_day");
    // A different model has its own fresh budget.
    expect((await reserveAiRequest("model-b", rateLimit)).allowed).toBe(true);
  });

  it("stops the scoring pass when the daily budget is reached", async () => {
    await insertJob({ title: "a", url: "https://example.com/a" });
    await insertJob({ title: "b", url: "https://example.com/b" });
    await insertJob({ title: "c", url: "https://example.com/c" });
    const provider = new FakeProvider(KEEP_SCORE);

    const result = await scorePendingJobs({
      providers: [provider],
      limit: 10,
      rateLimit: { maxPerMinute: 100, maxPerDay: 2 },
    });

    expect(result).toMatchObject({
      status: "partial",
      scored: 2,
      failed: 0,
      remaining: 1,
      rateLimited: true,
      modelsExhausted: ["fake-model"],
    });
    expect(provider.calls).toHaveLength(2);

    const run = await getPool().query<{ status: string }>(
      "select status from runs where source = 'ai-score'",
    );
    expect(run.rows[0]!.status).toBe("partial");
  });

  it("falls back to the next model when the primary hits its daily budget", async () => {
    await insertJob({ title: "a", url: "https://example.com/a" });
    await insertJob({ title: "b", url: "https://example.com/b" });
    const primary = new FakeProvider(KEEP_SCORE, new Set(), "primary-model");
    const fallback = new FakeProvider(KEEP_SCORE, new Set(), "fallback-model");

    const result = await scorePendingJobs({
      providers: [primary, fallback],
      limit: 10,
      rateLimit: { maxPerMinute: 100, maxPerDay: 1 },
    });

    expect(result).toMatchObject({
      status: "success",
      scored: 2,
      failed: 0,
      remaining: 0,
      rateLimited: false,
      modelsExhausted: ["primary-model"],
    });
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);

    const models = await getPool().query<{ ai_model: string }>(
      "select ai_model from jobs order by ai_model",
    );
    expect(models.rows.map((row) => row.ai_model)).toEqual(["fallback-model", "primary-model"]);
  });
});
