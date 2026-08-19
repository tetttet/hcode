export const OPENROUTER_TIMEOUT_MS = 120_000;
export const SHELL_TIMEOUT_MS = 120_000;

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label = "Operation",
  parentSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Timeout must be a positive number of milliseconds.");
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      if (!timedOut) {
        reject(new Error("Operation cancelled."));
      }
    }, { once: true });
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new TimeoutError(`${label} timed out after ${timeoutMs}ms.`));
      reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    if (controller.signal.aborted) {
      throw new Error("Operation cancelled.");
    }
    const operationPromise = operation(controller.signal);
    return await Promise.race([operationPromise, timeoutPromise, abortPromise]);
  } catch (error) {
    if (timedOut) {
      throw new TimeoutError(`${label} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}
