export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  signal?: AbortSignal;
  shouldRetry?(error: unknown, attempt: number): boolean;
  onRetry?(error: unknown, nextAttempt: number, delayMs: number): void;
  random?: () => number;
}

function cancelledError(): Error {
  return new Error("Operation cancelled.");
}

export async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelledError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, milliseconds));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(cancelledError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(5, Math.trunc(options.attempts ?? 3)));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 2_000);
  const jitter = Math.max(0, Math.min(1, options.jitter ?? 0.2));
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw cancelledError();
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        options.signal?.aborted ||
        attempt >= attempts ||
        (options.shouldRetry && !options.shouldRetry(error, attempt))
      ) {
        throw error;
      }
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.round(exponential * (1 - jitter + random() * jitter * 2));
      options.onRetry?.(error, attempt + 1, delayMs);
      await abortableDelay(delayMs, options.signal);
    }
  }
  throw new Error("Retry attempts exhausted.");
}
