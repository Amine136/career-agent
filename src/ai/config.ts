import { GeminiProvider } from "./providers/gemini.js";
import type { LlmProvider } from "./provider.js";

export type AiProviderName = "gemini";

export interface AiConfig {
  provider: AiProviderName;
  apiKey: string;
  model: string;
  /** Same key, used once the primary model's daily budget is exhausted (its own daily budget). */
  fallbackModel: string;
  /** Safety cap on jobs scored per invocation. */
  maxJobsPerRun: number;
  /** Polite delay between model calls, milliseconds. */
  requestDelayMs: number;
  /** Per-request timeout, milliseconds. */
  timeoutMs: number;
  /** Retries after the first failed attempt. */
  maxRetries: number;
  /** Wall-clock budget for the whole scoring pass, milliseconds. */
  timeBudgetMs: number;
  /**
   * How many UTC days back (inclusive of today) a pass considers. 1 = today only. A value >= the
   * ingestion cadence lets the next day's run drain the previous days' unscored leftovers before
   * moving on to fresh jobs.
   */
  lookbackDays: number;
  /** Model requests allowed in any rolling 60-second window. */
  maxRequestsPerMinute: number;
  /** Model requests allowed per UTC day (shared across invocations). */
  maxRequestsPerDay: number;
}

export const DEFAULT_AI_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_AI_FALLBACK_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_MAX_JOBS_PER_RUN = 200;
export const DEFAULT_AI_REQUEST_DELAY_MS = 250;
export const DEFAULT_AI_TIMEOUT_MS = 30_000;
export const DEFAULT_AI_MAX_RETRIES = 2;
export const DEFAULT_AI_TIME_BUDGET_MS = 70 * 60 * 1000;
export const DEFAULT_AI_MAX_REQUESTS_PER_MINUTE = 15;
export const DEFAULT_AI_MAX_REQUESTS_PER_DAY = 500;
/** UTC days considered per pass. Matches the 3-day ingestion cadence so leftovers carry over. */
export const DEFAULT_SCORE_LOOKBACK_DAYS = 3;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  return {
    provider: "gemini",
    apiKey: (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? "").trim(),
    model: env.AI_MODEL?.trim() || DEFAULT_AI_MODEL,
    fallbackModel: env.AI_FALLBACK_MODEL?.trim() || DEFAULT_AI_FALLBACK_MODEL,
    maxJobsPerRun: envInt(env, "AI_MAX_JOBS_PER_RUN", DEFAULT_MAX_JOBS_PER_RUN),
    requestDelayMs: envInt(env, "AI_REQUEST_DELAY_MS", DEFAULT_AI_REQUEST_DELAY_MS),
    timeoutMs: envInt(env, "AI_TIMEOUT_MS", DEFAULT_AI_TIMEOUT_MS),
    maxRetries: envInt(env, "AI_MAX_RETRIES", DEFAULT_AI_MAX_RETRIES),
    timeBudgetMs: envInt(env, "AI_TIME_BUDGET_MS", DEFAULT_AI_TIME_BUDGET_MS),
    lookbackDays: Math.max(1, envInt(env, "SCORE_LOOKBACK_DAYS", DEFAULT_SCORE_LOOKBACK_DAYS)),
    maxRequestsPerMinute: envInt(
      env,
      "AI_MAX_REQUESTS_PER_MINUTE",
      DEFAULT_AI_MAX_REQUESTS_PER_MINUTE,
    ),
    maxRequestsPerDay: envInt(env, "AI_MAX_REQUESTS_PER_DAY", DEFAULT_AI_MAX_REQUESTS_PER_DAY),
  };
}

/** Build the configured provider. Throws when the API key is missing. */
export function createProvider(config: AiConfig, model: string = config.model): LlmProvider {
  switch (config.provider) {
    case "gemini":
      return new GeminiProvider({
        apiKey: config.apiKey,
        model,
        timeoutMs: config.timeoutMs,
      });
  }
}

/** Providers in priority order: primary model, then the fallback model (same key). */
export function createProviders(config: AiConfig): LlmProvider[] {
  const models = [config.model];
  if (config.fallbackModel && config.fallbackModel !== config.model) {
    models.push(config.fallbackModel);
  }
  return models.map((model) => createProvider(config, model));
}
