export function debugLog(message: string): void {
  if (process.env.HCODE_DEBUG === "1") {
    process.stderr.write(`[hcode debug] ${message}\n`);
  }
}

export async function withTiming<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    debugLog(`${label} ${Math.round(performance.now() - started)}ms`);
  }
}
