/**
 * 失敗の後の待ち方（full jitter の exponential backoff）。floorMs（Retry-After・リセットの時刻までの残り）より短くしない。
 * #248 の harness/lib/backoff.ts と同じ形で、そちらが入ったらそれに置き換える。
 */

export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  /** これより短くしない（Retry-After・リセットの時刻までの残り） */
  floorMs?: number;
  random?: () => number;
}

/** floorMs + random() × min(capMs, baseMs × 2^attempt) の整数 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions): number {
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.max(0, opts.floorMs ?? 0) + Math.floor(random() * ceiling);
}
