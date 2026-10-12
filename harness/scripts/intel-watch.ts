/**
 * intel の見張り（Issue #854）。intel がターンを終える前に、Bash の run_in_background で置く。決まった時刻に digest、人の Merge 待ち（Human Merge）の PR か
 * 計画ゲートで止まった Issue が新しく出たら notice、--timeout-hours で timeout の JSON を標準出力に1行出して終わる。GitHub には書かない。
 *
 *   node harness/scripts/intel-watch.ts [--at 08:30,17:30] [--interval 300] [--timeout-hours 24]
 *
 * - 出力：`{"wake":"digest","slot":"08:30","missed":false}`・`{"wake":"notice","items":[{id,kind,number,url,title,reason}]}`・`{"wake":"timeout"}`。
 * - 時刻は手元の時刻。置いた時点で、直近の過ぎた時刻より前回のまとめ（digest/state.json の lastDigestAt）も前回この見張りが起こした時刻（digestWokeAt）も前なら、
 *   待たずにすぐ `missed: true` の digest で終わる（intel が止まっていた間に時刻を過ぎたとき）。
 * - すぐ知らせるのは todos の merge-pr-（人の Merge 待ち）と review-issue-（計画ゲートで止まった Issue）だけ。知らせた id の控えは
 *   git の共通ディレクトリの下の agent-harness/digest/intel-watch.json（`{ "version": 1, "notified": [id...], "digestWokeAt": "<ISO>" | null }`）。
 *   控えが無い最初の回は、今の項目を控えに入れるだけで知らせない。前回のまとめの state.json は読むだけ。
 * - GitHub はダッシュボードの部品（UpdateWatcher の条件付きリクエスト・DashboardData・buildGraph）で --interval 秒ごと（60 未満は 60）に確かめる。
 *   置き直すたびに新しいプロセスになり、最初の poll は必ず full（DashboardData.loadAll で全件を読む）。読み取りだけ（ReadOnlyTransport）。
 *   読めないときは標準エラーに1行書いて次の回に読み直す（時刻の digest と timeout は GitHub が読めなくても出す）。
 * - 見張りが失敗した（トークンが無い・git の外・引数の誤り）ときは標準エラーに1行書いて終了コード 1。
 * - 時刻・新しく出た人待ちの見分けは純粋関数で、CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { GitHub } from '../lib/github.ts';
import { gitCommonDir, harnessStateDir, writeLocalJson } from '../lib/local-state.ts';
import { resolveRepository } from '../lib/repository.ts';
import { DashboardData, ReadOnlyTransport, UpdateWatcher } from './dashboard/github.ts';
import { buildGraph, type Todo } from './dashboard/graph.ts';
import { readDigestState } from './dashboard/digest.ts';
import { limitFetch, RateLimitedTransport, RateLimitState } from './dashboard/rate-limit.ts';

export const DEFAULT_SLOTS = '08:30,17:30';
const DEFAULT_INTERVAL_SEC = 300;
const MIN_INTERVAL_SEC = 60;
const DEFAULT_TIMEOUT_HOURS = 24;

export interface Slot { h: number; m: number }

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatSlot(s: Slot): string {
  return `${pad(s.h)}:${pad(s.m)}`;
}

/** `08:30,17:30` を時刻の順に読む（前後の空白は除き、重複は1つ）。HH:MM（時 0〜23・分 0〜59、2桁）でないもの・空は例外 */
export function parseSlots(text: string): Slot[] {
  const seen = new Map<number, Slot>();
  for (const part of text.split(',')) {
    const t = part.trim();
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    const h = m ? Number(m[1]) : Number.NaN;
    const min = m ? Number(m[2]) : Number.NaN;
    if (!m || h > 23 || min > 59) throw new Error(`時刻は HH:MM（00:00〜23:59）で指定してください: ${JSON.stringify(t)}`);
    seen.set(h * 60 + min, { h, m: min });
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}

const at = (base: Date, dayOffset: number, s: Slot): Date => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, s.h, s.m);

/** 次の時刻：今より後（ちょうど同じ時刻は含めない）の最初の手元の時刻。今日の時刻をすべて過ぎていたら翌日の最初 */
export function nextSlot(now: Date, slots: Slot[]): { at: Date; slot: Slot } {
  for (const offset of [0, 1]) {
    for (const slot of slots) {
      const d = at(now, offset, slot);
      if (d.getTime() > now.getTime()) return { at: d, slot: { h: slot.h, m: slot.m } };
    }
  }
  throw new Error('時刻がありません');
}

/** 直近の時刻：今以前（ちょうど同じ時刻を含む）で一番新しい手元の時刻。今日の最初より前なら昨日の最後 */
export function prevSlot(now: Date, slots: Slot[]): { at: Date; slot: Slot } {
  for (const offset of [0, -1]) {
    for (const slot of [...slots].reverse()) {
      const d = at(now, offset, slot);
      if (d.getTime() <= now.getTime()) return { at: d, slot: { h: slot.h, m: slot.m } };
    }
  }
  throw new Error('時刻がありません');
}

/**
 * 出しそびれた時刻。前回のまとめ・前回起こした時刻のうち読めて新しいほうが直近の時刻より前か、どちらも無い・読めないなら直近の時刻、そうでなければ null
 */
export function missedSlot(now: Date, slots: Slot[], lastDigestAt: string | null, digestWokeAt: string | null): Slot | null {
  const prev = prevSlot(now, slots);
  const times = [lastDigestAt, digestWokeAt].flatMap((s) => {
    const t = s === null ? Number.NaN : Date.parse(s);
    return Number.isNaN(t) ? [] : [t];
  });
  if (times.length === 0) return prev.slot;
  return Math.max(...times) < prev.at.getTime() ? prev.slot : null;
}

export interface WatchState { version: 1; notified: string[]; digestWokeAt: string | null }

/** 控えのファイルの中身を読む。無い（null）・JSON でない・version が 1 でない・notified が文字列の配列でない・digestWokeAt が null でも読める時刻でもないものは null */
export function readWatchState(text: string | null): WatchState | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = (v ?? {}) as { version?: unknown; notified?: unknown; digestWokeAt?: unknown };
  if (o.version !== 1) return null;
  if (!Array.isArray(o.notified) || !o.notified.every((x): x is string => typeof x === 'string')) return null;
  if (o.digestWokeAt !== null && (typeof o.digestWokeAt !== 'string' || Number.isNaN(Date.parse(o.digestWokeAt)))) return null;
  return { version: 1, notified: o.notified, digestWokeAt: o.digestWokeAt };
}

export interface UrgentItem { id: string; kind: 'issue' | 'pr'; number: number; url: string; title: string; reason: string }

const URGENT_PREFIXES = ['merge-pr-', 'review-issue-'];

const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** すぐ知らせる範囲：人の Merge 待ち（merge-pr-）と計画ゲートで止まった Issue（review-issue-）だけを todos の順に拾う。題と理由は1行にする */
export function urgentItems(todos: Todo[]): UrgentItem[] {
  return todos
    .filter((t) => URGENT_PREFIXES.some((p) => t.id.startsWith(p)))
    .map((t) => ({ id: t.id, kind: t.kind, number: t.number, url: t.url, title: oneLine(t.title), reason: oneLine(t.reason) }));
}

/** 控えが無ければ知らせず今の id を全部控える。あれば控えに無い今の項目だけ知らせ、控えは今の id（消えたものは外れる） */
export function newUrgent(state: WatchState | null, current: UrgentItem[]): { notify: UrgentItem[]; notified: string[] } {
  const notified = current.map((i) => i.id);
  if (state === null) return { notify: [], notified };
  const known = new Set(state.notified);
  return { notify: current.filter((i) => !known.has(i.id)), notified };
}

export type WatchOutcome =
  | { wake: 'digest'; slot: string; missed: boolean }
  | { wake: 'notice'; items: UrgentItem[] }
  | { wake: 'timeout' };

export interface WatchArgs { slots: Slot[]; intervalMs: number; timeoutMs: number }

/** 引数を読む。--interval は秒（既定 300、60 未満は 60）、--timeout-hours は時間（既定 24、0 以下・数でないものは例外）。知らない引数は例外 */
export function parseWatchArgs(argv: string[]): WatchArgs {
  let at = DEFAULT_SLOTS;
  let interval = DEFAULT_INTERVAL_SEC;
  let hours = DEFAULT_TIMEOUT_HOURS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a !== '--at' && a !== '--interval' && a !== '--timeout-hours') throw new Error(`知らない引数です: ${a}`);
    if (v === undefined) throw new Error(`${a} に値がありません`);
    i++;
    if (a === '--at') {
      at = v;
      continue;
    }
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n)) throw new Error(`${a} は数で指定してください: ${JSON.stringify(v)}`);
    if (a === '--interval') interval = n;
    else if (n <= 0) throw new Error('--timeout-hours は 0 より大きい数で指定してください');
    else hours = n;
  }
  return { slots: parseSlots(at), intervalMs: Math.max(MIN_INTERVAL_SEC, interval) * 1000, timeoutMs: hours * 3_600_000 };
}

// ---- CLI（import.meta.main の中だけで動く） ----

function repository(): string {
  const r = resolveRepository(process.env.GITHUB_REPOSITORY, () => spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim() ?? '');
  if (!r.ok) throw new Error(r.error);
  return r.repository;
}

function token(): string {
  const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (env) return env;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  const t = (r.stdout ?? '').trim();
  if (r.status !== 0 || !t) throw new Error('GitHub のトークンが見つかりません（gh auth login をするか、GH_TOKEN を設定してください）');
  return t;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const out = (o: WatchOutcome): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

async function main(argv: string[]): Promise<number> {
  try {
    const args = parseWatchArgs(argv);
    const common = gitCommonDir();
    if (common === null) throw new Error('git の共通ディレクトリが見つかりません（git のリポジトリの中で実行してください）');
    const config = loadConfig();
    const repo = repository();
    const tok = token();
    const digestDir = join(harnessStateDir(common), 'digest');
    const watchPath = join(digestDir, 'intel-watch.json');
    const digestPath = join(digestDir, 'state.json');
    const readWatch = (): WatchState | null => readWatchState(readText(watchPath));

    const limits = new RateLimitState();
    const gh = new GitHub(new ReadOnlyTransport(new RateLimitedTransport({ fetch: (url, init) => fetch(url, init), token: tok, state: limits })), repo);
    const data = new DashboardData(gh, config);
    const watcher = new UpdateWatcher({ fetch: limitFetch((url, init) => fetch(url, init), limits), token: tok, repository: repo });

    /** 確かめて、変わったときだけ今のすぐ知らせる範囲の項目を返す（変わっていなければ null）。commit は呼び出し側が控えを書いた後にする */
    const readUrgent = async (): Promise<UrgentItem[] | null> => {
      const r = await watcher.poll();
      if (r.kind === 'full') await data.loadAll();
      else if (r.kind === 'changed') await data.refresh(r.numbers);
      if (r.kind === 'unchanged') return null;
      const graph = buildGraph(data.issues(), data.prs(), [], { now: new Date(), humanClaimStaleHours: config.routine.humanClaimStaleHours });
      return urgentItems(graph.todos);
    };

    /** digest で起こす。出す前に digestWokeAt を今にする（控えが無いときは今の項目を先に控える。読めなければ書かずに出す） */
    const wakeDigest = async (slot: Slot, missed: boolean): Promise<void> => {
      let st = readWatch();
      if (st === null) {
        try {
          const items = await readUrgent();
          if (items !== null) {
            watcher.commit();
            st = { version: 1, notified: items.map((i) => i.id), digestWokeAt: null };
          }
        } catch (e) {
          console.error(`GitHub を読めません（${(e as Error).message}）`);
        }
      }
      if (st !== null) writeLocalJson(watchPath, { ...st, digestWokeAt: new Date().toISOString() } satisfies WatchState);
      out({ wake: 'digest', slot: formatSlot(slot), missed });
    };

    const start = new Date();
    const missed = missedSlot(start, args.slots, readDigestState(readText(digestPath))?.lastDigestAt ?? null, readWatch()?.digestWokeAt ?? null);
    if (missed !== null) {
      await wakeDigest(missed, true);
      return 0;
    }

    const deadline = start.getTime() + args.timeoutMs;
    const next = nextSlot(start, args.slots);
    for (;;) {
      const now = Date.now();
      if (now >= next.at.getTime()) {
        await wakeDigest(next.slot, false);
        return 0;
      }
      if (now >= deadline) {
        out({ wake: 'timeout' });
        return 0;
      }
      if (limits.pausedUntil() === null && limits.retryNotBefore() === null) {
        try {
          const current = await readUrgent();
          if (current !== null) {
            const st = readWatch();
            const { notify, notified } = newUrgent(st, current);
            if (st === null || JSON.stringify(st.notified) !== JSON.stringify(notified)) {
              writeLocalJson(watchPath, { version: 1, notified, digestWokeAt: st?.digestWokeAt ?? null } satisfies WatchState);
            }
            watcher.commit();
            if (notify.length > 0) {
              out({ wake: 'notice', items: notify });
              return 0;
            }
          }
        } catch (e) {
          console.error(`更新に失敗しました（${(e as Error).message}）。次の回に読み直します`);
        }
      }
      const wait = Math.min(args.intervalMs, next.at.getTime() - Date.now(), deadline - Date.now());
      await sleep(Math.max(100, wait));
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
