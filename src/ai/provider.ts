import type { AiScore, ScoreableJob } from "./types.js";

export interface ScoreRequest {
  job: ScoreableJob;
  prompt: string;
  signal?: AbortSignal;
}

/** Provider failure annotated with the HTTP status so callers can decide whether to retry. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** True when retrying will not help (bad request, auth, not found, ...) — but 429 is retryable. */
export function isNonRetryableProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

/** Provider-agnostic interface: turn one job prompt into a validated `AiScore`. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Optional separate key used only for rate-limit accounting. A one-off backfill that runs on a
   * temporary API key can budget under its own key (e.g. `oneoff:gemini-3.5-flash-lite`) so it
   * neither reads nor pollutes the production budget, while `model` still records the real model.
   */
  readonly rateLimitModel?: string;
  score(request: ScoreRequest): Promise<AiScore>;
}

export interface LlmProviderConfig {
  apiKey: string;
  model: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}
