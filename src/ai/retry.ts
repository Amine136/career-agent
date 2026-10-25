export interface RetryOptions {
  /** Number of retries after the first attempt. */
  retries: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Return false to stop retrying immediately (e.g. a non-recoverable limit error). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Run `fn`, retrying with exponential backoff on failure. The final error is rethrown.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (options.signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === options.retries || options.signal?.aborted) break;
      if (options.shouldRetry && !options.shouldRetry(err, attempt + 1)) break;
      const delayMs = baseDelayMs * 2 ** attempt;
      options.onRetry?.(err, attempt + 1, delayMs);
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError;
}
