/**
 * 失敗の後の待ち方（full jitter の exponential backoff）と Retry-After の読み取り。GitHub API・Jev・ダッシュボードのやり直しが使う（#248）。
 * floorMs（Retry-After・リセットの時刻までの残り）より短くしない。
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

/** Retry-After の値（秒数か HTTP-date）を待ちの ms にする。読めない値・空は null、過去の日時は 0 */
export function retryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (/^-?[\d.]+$/.test(v)) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}
