export interface RetryOptions {
  max: number;
  baseMs: number;
  isRetryable: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Calls `fn` once, then up to `max` more times while the failure is retryable,
// doubling the wait each time. A non-retryable failure is thrown at once.
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!opts.isRetryable(err) || attempt >= opts.max) throw err;
      await sleep(opts.baseMs * 2 ** attempt);
    }
  }
}
