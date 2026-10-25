import { withTransaction } from "../db.js";

export interface RateLimitConfig {
  /** Maximum model requests allowed in any rolling 60-second window (per model). */
  maxPerMinute: number;
  /** Maximum model requests allowed per UTC day (per model). */
  maxPerDay: number;
}

export type RateLimitReason = "per_minute" | "per_day";

export interface RateLimitDecision {
  allowed: boolean;
  reason?: RateLimitReason;
  /** When `reason === "per_minute"`, how long to wait before retrying. */
  retryAfterMs?: number;
  usedToday: number;
  remainingToday: number;
}

/**
 * Thrown when one model's daily request budget is exhausted. The scorer catches this, marks the
 * model as exhausted and retries the same job with the next configured model.
 */
export class ModelDailyLimitError extends Error {
  constructor(readonly model: string) {
    super(`daily AI request limit reached for ${model}`);
    this.name = "ModelDailyLimitError";
  }
}

interface CountsRow {
  last_minute: number;
  today: number;
  oldest_in_window: string | null;
}

/**
 * Reserve one model-request slot for `model`. Every attempt (including retries) must call this
 * before hitting the provider. Counts live in `ai_request_log` and are tracked per model, so the
 * daily budget is shared across invocations yet independent between primary and fallback models.
 */
export async function reserveAiRequest(
  model: string,
  config: RateLimitConfig,
): Promise<RateLimitDecision> {
  return withTransaction((client) => reserveWithClient(client, model, config));
}

export async function reserveWithClient(
  client: import("../db.js").PoolClient,
  model: string,
  config: RateLimitConfig,
): Promise<RateLimitDecision> {
  // Serialize reservations so two concurrent invocations can never both pass the budget check.
  await client.query("select pg_advisory_xact_lock(hashtext('ai-request-log'))");

  // Keep the table small: only today and yesterday can ever be counted.
  await client.query(
    "delete from ai_request_log where requested_at < date_trunc('day', now()) - interval '1 day'",
  );

  const { rows } = await client.query<CountsRow>(
    `select
       count(*) filter (where requested_at > now() - interval '1 minute')::int as last_minute,
       count(*) filter (where requested_at >= date_trunc('day', now()))::int as today,
       min(requested_at) filter (where requested_at > now() - interval '1 minute') as oldest_in_window
     from ai_request_log
     where model = $1 and requested_at >= date_trunc('day', now()) - interval '1 minute'`,
    [model],
  );
  const counts = rows[0] ?? { last_minute: 0, today: 0, oldest_in_window: null };
  const usedToday = counts.today;

  if (usedToday >= config.maxPerDay) {
    return {
      allowed: false,
      reason: "per_day",
      usedToday,
      remainingToday: 0,
    };
  }

  if (counts.last_minute >= config.maxPerMinute) {
    const oldest = counts.oldest_in_window
      ? Date.parse(counts.oldest_in_window)
      : Number.NaN;
    const elapsed = Number.isNaN(oldest) ? 0 : Date.now() - oldest;
    const retryAfterMs = Math.max(50, 60_000 - elapsed);
    return {
      allowed: false,
      reason: "per_minute",
      retryAfterMs,
      usedToday,
      remainingToday: Math.max(0, config.maxPerDay - usedToday),
    };
  }

  await client.query("insert into ai_request_log (model) values ($1)", [model]);
  const nextUsed = usedToday + 1;
  return {
    allowed: true,
    usedToday: nextUsed,
    remainingToday: Math.max(0, config.maxPerDay - nextUsed),
  };
}
