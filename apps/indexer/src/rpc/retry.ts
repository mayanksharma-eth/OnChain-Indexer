import { RpcRetriesExhaustedError } from "./errors.js";

export interface RetryOptions {
  method: string;
  maxRetries: number;
  baseDelayMs: number;
  /** Called for every failed attempt (including ones that go on to be retried) — e.g. for
   * metrics. Not called for the synthetic final RpcRetriesExhaustedError wrapper. */
  onError?: (error: unknown, attempt: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries `fn` with exponential backoff (baseDelayMs * 2^attempt). Throws
 * RpcRetriesExhaustedError, wrapping the last failure as `cause`, once maxRetries is used up. */
export async function withRetry<T>(fn: () => Promise<T>, { method, maxRetries, baseDelayMs, onError }: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      onError?.(error, attempt);
      if (attempt > maxRetries) {
        throw new RpcRetriesExhaustedError(method, attempt, error);
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
