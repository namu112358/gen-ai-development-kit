import type { HarnessConfig } from '../lib/config.ts';
import { findDashboard } from '../lib/state.ts';
import type { GateContext } from './context.ts';
import { onScheduleWithLabels } from './label-apply.ts';
import { publishQueue } from './publish-queue.ts';
import { ensureDashboard } from './stale.ts';

/**
 * イベントで動いた gate が、前回の定期の仕事（label-apply → stale の onSchedule → queue の公開）からしきい値以上空いていれば、定期の仕事を1回補う（Issue #418）。
 * 前回の時刻はダッシュボード本文の末尾の印（agent-harness:periodic）に書く。重なりは、印を書いて少し待ち、読み直して自分の印だったときだけ行うことで避ける。
 */
export const DEFAULT_PERIODIC_CATCH_UP_MINUTES = 90;
/** 印を書いてから読み直すまでの待ち（同時に書いたほかの実行に譲るため） */
export const PERIODIC_SETTLE_MS = 10_000;
/** 印の時刻が今よりこれを超えて未来なら、読めないものとして扱う（時計のずれの許容） */
const FUTURE_TOLERANCE_MINUTES = 5;

export interface PeriodicMark {
  at: string;
  run: string;
  event: string;
}

const MARK_RE = /<!-- agent-harness:periodic at=(\S+) run=(\S+) event=(\S+) -->/g;

export function periodicCatchUpMinutes(config: HarnessConfig): number {
  return config.periodicCatchUpMinutes ?? DEFAULT_PERIODIC_CATCH_UP_MINUTES;
}

export function renderPeriodicMark(mark: PeriodicMark): string {
  return `<!-- agent-harness:periodic at=${mark.at} run=${mark.run} event=${mark.event} -->`;
}

/** 本文の最後の印。無い・時刻が読めないなら null */
export function readPeriodicMark(body: string): PeriodicMark | null {
  const all = [...body.matchAll(MARK_RE)];
  const last = all[all.length - 1];
  if (!last) return null;
  const mark = { at: last[1]!, run: last[2]!, event: last[3]! };
  return Number.isNaN(Date.parse(mark.at)) ? null : mark;
}

/** 印を1つにして書く（あれば置き換え、無ければ末尾に空行を挟んで足す） */
export function replacePeriodicMark(body: string, mark: PeriodicMark): string {
  const rendered = renderPeriodicMark(mark);
  const matches = [...body.matchAll(MARK_RE)];
  if (matches.length === 0) return `${body.trimEnd()}\n\n${rendered}`;
  const first = matches[0]!.index!;
  let replaced = false;
  return body.replace(MARK_RE, () => {
    if (replaced) return '';
    replaced = true;
    return rendered;
  }).replace(/\n{3,}/g, (m, offset: number) => (offset >= first ? '\n\n' : m));
}

export function catchUpDecision(mark: PeriodicMark | null, now: Date, minutes: number): { due: boolean; elapsedMinutes: number | null; reason: string } {
  if (!mark) return { due: true, elapsedMinutes: null, reason: '前回の記録が無い' };
  const elapsed = Math.floor((now.getTime() - Date.parse(mark.at)) / 60_000);
  if (elapsed < -FUTURE_TOLERANCE_MINUTES) return { due: true, elapsedMinutes: elapsed, reason: `前回の記録の時刻が未来（${mark.at}）で読めない` };
  const due = elapsed >= minutes;
  const from = `前回の定期の仕事 ${mark.at}（${mark.event}、run ${mark.run}）から ${elapsed} 分`;
  return { due, elapsedMinutes: elapsed, reason: due ? `${from}空いた。しきい値 ${minutes} 分` : `${from}。しきい値 ${minutes} 分` };
}

/** ダッシュボードの印を書く（無ければダッシュボードを作る）。ダッシュボードの番号を返す */
export async function markPeriodic(ctx: GateContext, mark: PeriodicMark): Promise<number> {
  const dashboard = await ensureDashboard(ctx);
  const issue = await ctx.gh.get<{ body: string | null }>(`/issues/${dashboard}`);
  const body = replacePeriodicMark(issue.body ?? '', mark);
  if (body !== issue.body) await ctx.gh.request('PATCH', `/issues/${dashboard}`, { body: { body } });
  return dashboard;
}

async function defaultWork(ctx: GateContext, now: Date): Promise<void> {
  let failed: unknown = null;
  try {
    await onScheduleWithLabels(ctx, now);
  } catch (e) {
    failed = e;
  }
  try {
    await publishQueue(ctx);
  } catch (e) {
    failed ??= e;
  }
  if (failed) throw failed;
}

export async function catchUpPeriodic(
  ctx: GateContext,
  opts: { now?: Date; runId?: string; sleep?: (ms: number) => Promise<void>; work?: (ctx: GateContext, now: Date) => Promise<void> } = {},
): Promise<'ran' | 'not-due' | 'yielded'> {
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? process.env.GITHUB_RUN_ID ?? 'unknown';
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const work = opts.work ?? defaultWork;
  const minutes = periodicCatchUpMinutes(ctx.config);

  const found = await findDashboard(ctx.gh, ctx.config);
  const current = found ? readPeriodicMark((await ctx.gh.get<{ body: string | null }>(`/issues/${found.number}`)).body ?? '') : null;
  const decision = catchUpDecision(current, now, minutes);
  if (!decision.due) {
    ctx.log(`定期の仕事は補いません（${decision.reason}）`);
    return 'not-due';
  }

  const dashboard = await markPeriodic(ctx, { at: now.toISOString(), run: runId, event: ctx.eventName });
  await sleep(PERIODIC_SETTLE_MS);
  const after = readPeriodicMark((await ctx.gh.get<{ body: string | null }>(`/issues/${dashboard}`)).body ?? '');
  if (after?.run !== runId) {
    ctx.log(`定期の仕事はほかの実行に譲ります（印は run ${after?.run ?? '無し'}。${decision.reason}）`);
    return 'yielded';
  }
  ctx.log(`定期の仕事を補います（${decision.reason}）`);
  await work(ctx, now);
  return 'ran';
}
