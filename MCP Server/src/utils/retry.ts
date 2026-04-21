/**
 * Retry utilities for transient CDP failures and stale element refs.
 *
 * Provides generic retries with configurable back-off, plus a
 * specialised wrapper for element-resolution actions that need
 * Playwright-style auto-waiting.
 */

import { sleep } from './wait.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of attempts (default: 3). */
  maxAttempts?: number;
  /** Initial delay between attempts in ms (default: 500). */
  delayMs?: number;
  /** Multiplier applied to the delay after each failure (default: 2). */
  backoffMultiplier?: number;
  /** Predicate: return `true` to retry, `false` to rethrow immediately. */
  retryOn?: (error: Error) => boolean;
}

// ─── withRetry ──────────────────────────────────────────────────────

/**
 * Retry `fn` up to `maxAttempts` times with exponential back-off.
 *
 * @example
 * const result = await withRetry(() => fetchSomething(), {
 *   maxAttempts: 4,
 *   delayMs: 300,
 *   retryOn: (e) => e.message.includes('ECONNRESET'),
 * });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 500,
    backoffMultiplier = 2,
    retryOn,
  } = options;

  let lastError: Error | undefined;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // If a predicate was supplied and it says "don't retry", rethrow now
      if (retryOn && !retryOn(lastError)) throw lastError;

      // Last attempt — don't wait, just throw
      if (attempt === maxAttempts) break;

      await sleep(currentDelay);
      currentDelay = Math.round(currentDelay * backoffMultiplier);
    }
  }

  throw lastError;
}

// ─── retryElementAction ─────────────────────────────────────────────

/**
 * Retry wrapper tuned for element resolution and actionability checks.
 *
 * Uses the same logic as the server.js `withRetry` — poll with a fixed
 * interval until timeout, fast-failing on errors that can never recover
 * (stale uid refs, missing params).
 *
 * @param fn        - Async function to retry (resolve element → act on it)
 * @param timeout   - Overall timeout in ms (default: 5 000)
 * @param interval  - Polling interval in ms (default: 200)
 */
export async function retryElementAction<T>(
  fn: () => Promise<T>,
  timeout = 5000,
  interval = 200,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: Error | undefined;

  while (true) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      const msg = lastError.message;

      // Fast-fail on errors that won't recover with retries
      if (msg.includes('ref=') && msg.includes('not found')) throw lastError;
      if (msg.includes('Provide either')) throw lastError;

      if (Date.now() + interval > deadline) throw lastError;
      await sleep(interval);
    }
  }
}
