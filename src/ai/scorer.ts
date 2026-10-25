import { withClient, withTransaction } from "../db.js";
import {
  countUnscoredJobs,
  finishRun,
  listJobsToScore,
  saveJobScore,
  startRun,
  type RunStats,
} from "../core/repository.js";
import { buildPrompt, PROMPT_VERSION } from "./prompt.js";
import { isNonRetryableProviderError, type LlmProvider } from "./provider.js";
import {
  ModelDailyLimitError,
  reserveAiRequest,
  type RateLimitConfig,
} from "./rate-limit.js";
import { sleep, withRetry } from "./retry.js";
import type { AiScore, ScoreableJob } from "./types.js";

export interface ScorerOptions {
  /** Models in priority order (primary first); each has its own daily request budget. */
  providers: LlmProvider[];
  limit: number;
  requestDelayMs?: number;
  timeBudgetMs?: number;
  maxRetries?: number;
  promptVersion?: string;
  /**
   * Only score jobs first seen on/after this instant. When omitted, defaults to the start of the
   * UTC day `lookbackDays - 1` days ago, so a pass evaluates recent days' finds (draining the
   * previous days' unscored leftovers first, oldest-first) instead of the whole historical catalog.
   */
  since?: Date;
  /**
   * UTC days considered when `since` is omitted. 1 = today only. The production default is 3 (the
   * ingestion cadence) so a daily pass carries over whatever the previous day(s) could not score.
   */
  lookbackDays?: number;
  /** Optional exclusive upper bound on `first_seen_at` (used by the one-off day backfill). */
  until?: Date;
  /** Per-minute / per-day request budgets enforced before every provider call, per model. */
  rateLimit?: RateLimitConfig;
  signal?: AbortSignal;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

export interface ScoreRunResult {
  status: "success" | "partial" | "failed";
  scored: number;
  failed: number;
  remaining: number;
  /** True when the pass stopped because every model's daily request budget was reached. */
  rateLimited: boolean;
  /** Models that hit their daily budget during this pass. */
  modelsExhausted: string[];
}

export const AI_SCORE_RUN_SOURCE = "ai-score";

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxPerMinute: 15,
  maxPerDay: 500,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** UTC midnight for the day containing `ms`. */
function startOfUtcDay(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Walks the model list, skipping any model whose daily budget is already exhausted. */
class ModelPool {
  private index = 0;
  private readonly exhausted = new Set<string>();

  constructor(private readonly providers: LlmProvider[]) {}

  next(): LlmProvider | null {
    while (this.index < this.providers.length) {
      const provider = this.providers[this.index]!;
      if (!this.exhausted.has(provider.model)) {
        return provider;
      }
      this.index += 1;
    }
    return null;
  }

  exhaust(model: string): void {
    this.exhausted.add(model);
  }

  get exhaustedModels(): string[] {
    return [...this.exhausted];
  }
}

/**
 * Score pending jobs one at a time and persist each verdict. When one model hits its daily
 * request budget the scorer switches to the next configured model (same key), so the total
 * daily capacity is the sum of each model's budget. The run stops early when the wall-clock
 * budget is exhausted, the signal is aborted, or every model is exhausted; unscored jobs stay
 * pending.
 */
export async function scorePendingJobs(options: ScorerOptions): Promise<ScoreRunResult> {
  const {
    providers,
    limit,
    requestDelayMs = 0,
    timeBudgetMs = Number.POSITIVE_INFINITY,
    maxRetries = 0,
    promptVersion = PROMPT_VERSION,
    since,
    lookbackDays = 1,
    until,
    rateLimit = DEFAULT_RATE_LIMIT,
    signal,
    now = () => Date.now(),
    log,
  } = options;

  if (providers.length === 0) {
    throw new Error("scorePendingJobs requires at least one provider");
  }

  const startedAt = now();
  const windowDays = Math.max(1, lookbackDays);
  const scopeSince =
    since ?? startOfUtcDay(startedAt - (windowDays - 1) * 86_400_000);
  const deadline = startedAt + timeBudgetMs;

  const runId = await withTransaction((client) => startRun(client, AI_SCORE_RUN_SOURCE));
  const candidates = await withClient((client) =>
    listJobsToScore(client, limit, scopeSince, until),
  );

  const pool = new ModelPool(providers);
  let scored = 0;
  let failed = 0;
  let rateLimited = false;
  const errors: string[] = [];

  for (const job of candidates) {
    if (signal?.aborted || now() >= deadline || rateLimited) break;

    let done = false;
    while (!done) {
      const provider = pool.next();
      if (!provider) {
        rateLimited = true;
        log?.({ event: "all_models_exhausted", used: pool.exhaustedModels });
        break;
      }

      try {
        const result = await scoreOne(provider, job, { maxRetries, signal, rateLimit });
        await withTransaction((client) =>
          saveJobScore(client, job.id, result, provider.model, promptVersion),
        );
        scored += 1;
        done = true;
        log?.({
          event: "job_scored",
          jobId: job.id,
          model: provider.model,
          decision: result.decision,
          score: result.score,
        });
      } catch (err) {
        if (err instanceof ModelDailyLimitError) {
          pool.exhaust(provider.model);
          log?.({ event: "model_daily_limit", model: provider.model, rateLimitModel: err.model });
          continue; // retry the same job on the next model
        }
        failed += 1;
        errors.push(`score ${job.id}: ${errorMessage(err)}`);
        log?.({ event: "job_score_failed", jobId: job.id, message: errorMessage(err) });
        break; // give up on this job (network/5xx after retries, bad request, ...)
      }
    }

    if (requestDelayMs > 0 && now() < deadline) {
      await sleep(requestDelayMs, signal).catch(() => {});
    }
  }

  const remaining = await withClient((client) => countUnscoredJobs(client, scopeSince, until));
  const status: ScoreRunResult["status"] =
    failed > 0 ? (scored > 0 ? "partial" : "failed") : rateLimited ? "partial" : "success";

  const stats: RunStats = {
    jobsFetched: candidates.length,
    jobsAccepted: scored,
    jobsRejected: failed,
    jobsInserted: 0,
    jobsUpdated: scored,
    errors,
    details: {
      provider: providers[0]!.name,
      models: providers.map((provider) => provider.model),
      modelsExhausted: pool.exhaustedModels,
      promptVersion,
      remaining,
      since: scopeSince.toISOString(),
      lookbackDays: windowDays,
      until: until?.toISOString() ?? null,
      rateLimited,
      rateLimit: { maxPerMinute: rateLimit.maxPerMinute, maxPerDay: rateLimit.maxPerDay },
      durationMs: now() - startedAt,
    },
  };

  await withTransaction((client) => finishRun(client, runId, status, stats));

  return { status, scored, failed, remaining, rateLimited, modelsExhausted: pool.exhaustedModels };
}

async function scoreOne(
  provider: LlmProvider,
  job: ScoreableJob,
  opts: { maxRetries: number; signal?: AbortSignal; rateLimit: RateLimitConfig },
): Promise<AiScore> {
  const prompt = buildPrompt(job);
  return withRetry(
      () =>
        runWithLimit(
          () => provider.score({ job, prompt, signal: opts.signal }),
          provider.rateLimitModel ?? provider.model,
          opts.rateLimit,
          opts.signal,
        ),
    {
      retries: opts.maxRetries,
      signal: opts.signal,
      // 4xx provider errors and an exhausted model won't improve on retry; let the caller decide.
      shouldRetry: (err) =>
        !(err instanceof ModelDailyLimitError) && !isNonRetryableProviderError(err),
    },
  );
}

/**
 * Reserve a rate-limit slot for `model`, sleeping through per-minute throttling, then call `fn`.
 * Every attempt (including retries) reserves, so the budgets are enforced per actual request.
 */
async function runWithLimit<T>(
  fn: () => Promise<T>,
  model: string,
  rateLimit: RateLimitConfig,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    const decision = await reserveAiRequest(model, rateLimit);
    if (decision.allowed) return fn();
    if (decision.reason === "per_day") throw new ModelDailyLimitError(model);
    await sleep(decision.retryAfterMs ?? 1000, signal);
  }
}
