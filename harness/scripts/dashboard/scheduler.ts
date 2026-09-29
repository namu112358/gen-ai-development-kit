/**
 * 見張りの回し方：決まった間隔で読み、上限の残りが下限を切ったらリセットまで止め、失敗の後は backoff + jitter で遅らせる。
 * SSE の接続が0の間は読まず、接続が戻ったらすぐ1回読む。時計・乱数・タイマー・接続の数は差し替えられる。
 */
import { backoffDelayMs } from './backoff.ts';
import { RateLimitPaused } from './rate-limit.ts';

export type PollStatus =
  | { state: 'running' }
  | { state: 'paused'; until: number; resource: string }
  | { state: 'backoff'; until: number; attempt: number; error: string };

export interface SchedulerOptions {
  intervalMs: number;
  /** backoff の待ちの上限（既定 15 分） */
  capMs?: number;
  /** 1回の読み直し */
  run: () => Promise<void>;
  state: { pausedUntil(): { until: number; resource: string } | null; retryNotBefore(): number | null };
  connections: () => number;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => Promise<void>, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 状態が変わったときだけ呼ぶ */
  onStatus?: (s: PollStatus) => void;
  onError?: (e: Error) => void;
}

export class PollScheduler {
  private readonly o: SchedulerOptions;
  private readonly now: () => number;
  private readonly capMs: number;
  private readonly setTimer: (fn: () => Promise<void>, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private current: PollStatus = { state: 'running' };
  private attempt = 0;
  private busy = false;
  private stopped = false;
  private timer: unknown = null;
  /** 次に読んでよい時刻（止める・backoff の時刻。0 ならいつでも） */
  private nextAt = 0;

  constructor(opts: SchedulerOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
    this.capMs = opts.capMs ?? 15 * 60_000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(() => void fn(), ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  status(): PollStatus {
    return this.current;
  }

  /** 接続が来たとき・起動のとき。止める・backoff の時刻が未来ならそこまで待ち、そうでなければすぐ1回読む */
  wake(): Promise<void> {
    if (this.stopped || this.busy || this.timer !== null) return Promise.resolve();
    const wait = this.nextAt - this.now();
    if (wait > 0) {
      this.schedule(wait);
      return Promise.resolve();
    }
    return this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private setStatus(s: PollStatus): void {
    const same = JSON.stringify(s) === JSON.stringify(this.current);
    this.current = s;
    if (!same) this.o.onStatus?.(s);
  }

  private schedule(ms: number): void {
    this.nextAt = this.now() + ms;
    if (this.stopped || this.o.connections() === 0) return;
    this.timer = this.setTimer(() => this.tick(), Math.max(0, ms));
  }

  private pause(p: { until: number; resource: string }): void {
    this.setStatus({ state: 'paused', until: p.until, resource: p.resource });
    this.schedule(p.until - this.now());
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || this.busy || this.o.connections() === 0) return;
    const paused = this.o.state.pausedUntil();
    if (paused) {
      this.pause(paused);
      return;
    }
    this.busy = true;
    try {
      await this.o.run();
      this.attempt = 0;
      this.setStatus({ state: 'running' });
      this.schedule(this.o.intervalMs);
    } catch (e) {
      const err = e as Error;
      const p = this.o.state.pausedUntil() ?? (err instanceof RateLimitPaused ? { until: err.until, resource: err.resource } : null);
      if (p) {
        this.pause(p);
      } else {
        this.attempt++;
        const floorMs = Math.max(0, (this.o.state.retryNotBefore() ?? 0) - this.now());
        const delay = backoffDelayMs(this.attempt, { baseMs: this.o.intervalMs, capMs: this.capMs, floorMs, random: this.o.random });
        this.setStatus({ state: 'backoff', until: this.now() + delay, attempt: this.attempt, error: err.message });
        this.o.onError?.(err);
        this.schedule(delay);
      }
    } finally {
      this.busy = false;
    }
  }
}
