import { appLogin, LABELS, reasonMark } from '../lib/config.ts';
import { parseChildMarker, renderChildBody, type SplitChild } from '../lib/epic.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Plan } from '../lib/plan.ts';
import { appRecords, type PlanGateRecord } from '../lib/state.ts';
import { appComment, type GateContext } from './context.ts';

/**
 * Epic の子 Issue を作り、Sub-issues と依存を登録する。
 */

interface IssueItem {
  id: number;
  number: number;
  body: string | null;
  state?: string;
  repository_url?: string;
  labels: ({ name: string } | string)[];
  user: { login: string } | null;
}

export interface EpicSplitRecord {
  version: 1;
  planCommentId: number;
  children: number[];
}

/** 親から子に引き継ぐ停止のラベル */
const STOP_LABELS: readonly string[] = [LABELS.hold, LABELS.blocked, LABELS.waiting];

/** 分割の前に読む親の状態 */
export interface EpicState {
  subIssues: IssueItem[];
  /** App が作った目印付きの子 Issue（添字ごと） */
  existing: Map<number, IssueItem>;
  /** 同じ計画コメントの通過の記録（plan-gate）が既にある（再実行） */
  gateRecorded: boolean;
  /** 別の計画で既に分けている（分け直し）。止める理由 */
  resplit: string | null;
}

/**
 * 親の記録と子 Issue を読む。同じ計画コメントの再実行なら続きから作り、
 * 別の計画で既に分けていれば（epic-split の記録か、App が作った目印付きの子がある）分け直しとして止める。
 */
export async function inspectEpic(ctx: GateContext, parent: number, planCommentId: number): Promise<EpicState> {
  const app = appLogin(ctx.config);
  const comments = await ctx.gh.listComments(parent);
  const splits = appRecords<EpicSplitRecord>(ctx.config, comments, 'epic-split');
  const gateRecorded = appRecords<PlanGateRecord>(ctx.config, comments, 'plan-gate').some((g) => g.value.pass && g.value.planCommentId === planCommentId);
  const samePlan = gateRecorded || splits.some((s) => s.value.planCommentId === planCommentId);

  const subIssues = await ctx.gh.paginate<IssueItem>(`/issues/${parent}/sub_issues`);
  const created = await ctx.gh.paginate<IssueItem>(`/issues?state=all&creator=${encodeURIComponent(app)}`);
  const existing = new Map<number, IssueItem>();
  for (const item of [...subIssues, ...created]) {
    const mark = parseChildMarker(item.body);
    if (item.user?.login !== app || mark?.parent !== parent || existing.has(mark.index)) continue;
    existing.set(mark.index, item);
  }

  let resplit: string | null = null;
  const prev = splits.at(-1);
  if (!samePlan && (prev || existing.size > 0)) {
    const numbers = prev ? prev.value.children : [...existing.values()].map((c) => c.number).sort((a, b) => a - b);
    resplit = `この Issue は既に子課題に分けています（${numbers.map((n) => `#${n}`).join('、')}）。分け直すか（既存の子課題をどうするか）は人が判断してください`;
  }
  return { subIssues, existing, gateRecorded, resplit };
}

/**
 * split 付きの計画が計画ゲートを通ったとき：親に epic を付け、子 Issue・Sub-issues・依存を作る。
 * 途中で失敗して再実行しても二重に作らないよう、inspectEpic が見つけた目印付きの Issue を使い回し、
 * 未登録の Sub-issue・依存・ラベルだけを足す。途中で失敗したら親を agent:blocked にして失敗を投げ直す。
 */
export async function splitEpic(
  ctx: GateContext,
  issue: { number: number; labels: { name: string }[] },
  comment: IssueComment,
  plan: Plan & { split: SplitChild[] },
  record: PlanGateRecord,
  state: EpicState,
): Promise<void> {
  const parent = issue.number;
  await ctx.gh.removeLabel(parent, LABELS.planOk);
  await ctx.gh.addLabels(parent, [LABELS.epic]);
  try {
    await createChildren(ctx, issue, comment, plan, record, state);
  } catch (e) {
    try {
      await ctx.gh.addLabels(parent, [LABELS.blocked]);
      await appComment(
        ctx,
        parent,
        'epic-split-failed',
        [
          reasonMark('split-failed'),
          '子課題を作る途中で失敗しました。`agent:blocked` にしました。原因を直して `agent:blocked` を外し、失敗した実行をやり直してください（作った子課題は使い回します）。',
          '',
          `- ${e instanceof Error ? e.message : String(e)}`,
        ].join('\n'),
      );
    } catch (inner) {
      ctx.log(`agent:blocked を付けられませんでした: ${inner instanceof Error ? inner.message : String(inner)}`);
    }
    throw e;
  }
}

async function createChildren(
  ctx: GateContext,
  issue: { number: number; labels: { name: string }[] },
  comment: IssueComment,
  plan: Plan & { split: SplitChild[] },
  record: PlanGateRecord,
  state: EpicState,
): Promise<void> {
  const parent = issue.number;
  const split = plan.split;
  if (!state.gateRecorded) {
    await appComment(ctx, parent, 'plan-gate', `計画ゲートを通過しました（[計画](${comment.html_url})）。Epic として ${split.length} 件の子課題に分けます（この Issue は実装しません）。`, record);
  }

  const registered = new Set(state.subIssues.map((s) => s.number));
  const children: IssueItem[] = [];
  for (let i = 0; i < split.length; i++) {
    let child = state.existing.get(i);
    if (!child) {
      const body = renderChildBody(parent, i, split, split[i]!.dependsOn.map((d) => children[d]!.number));
      child = await ctx.gh.request<IssueItem>('POST', '/issues', { body: { title: split[i]!.title, body } });
      ctx.log(`子課題 #${child.number} を作りました（Epic #${parent} の ${i}）`);
    }
    // 作ったらすぐ Sub-issue にする（再実行時に見つけられるように）
    if (!registered.has(child.number)) {
      await ctx.gh.request('POST', `/issues/${parent}/sub_issues`, { body: { sub_issue_id: child.id } });
      registered.add(child.number);
    }
    children.push(child);
  }

  // 依存：兄弟の dependsOn と、親の開いた blocker（同じリポジトリのもの）
  const repoUrl = `/repos/${ctx.repository}`;
  const parentBlockers = (await ctx.gh.paginate<IssueItem>(`/issues/${parent}/dependencies/blocked_by`)).filter(
    (b) => b.state === 'open' && (b.repository_url ?? '').endsWith(repoUrl),
  );
  for (let i = 0; i < split.length; i++) {
    const child = children[i]!;
    const needed = [...split[i]!.dependsOn.map((d) => children[d]!), ...parentBlockers];
    if (needed.length === 0) continue;
    const blockedBy = new Set((await ctx.gh.paginate<IssueItem>(`/issues/${child.number}/dependencies/blocked_by`)).map((b) => b.number));
    for (const blocker of needed) {
      if (blockedBy.has(blocker.number)) continue;
      await ctx.gh.request('POST', `/issues/${child.number}/dependencies/blocked_by`, { body: { issue_id: blocker.id } });
      blockedBy.add(blocker.number);
    }
  }

  // 親の停止（hold / blocked / waiting）を先に引き継いでから agent:ready を付ける
  // （ready が付くと on-issue が子の書式を検査し、queue に乗る）
  const parentLabels = issue.labels.map((l) => l.name);
  const stops = parentLabels.filter((n) => STOP_LABELS.includes(n));
  const ready = parentLabels.filter((n) => n === LABELS.ready || n.startsWith('priority:'));
  const labelsOf = (child: IssueItem) => new Set(child.labels.map((l) => (typeof l === 'string' ? l : l.name)));
  for (const child of children) {
    const missing = stops.filter((n) => !labelsOf(child).has(n));
    if (missing.length === 0) continue;
    await ctx.gh.addLabels(child.number, missing);
    const text = `Epic #${parent} の停止（${missing.map((n) => `\`${n}\``).join('、')}）を引き継ぎました。親の停止を外すときは、子課題のものも人が外してください。`;
    await appComment(ctx, child.number, 'epic-inherit', missing.includes(LABELS.blocked) ? `${reasonMark('other')}\n${text}` : text);
  }
  for (const child of children) {
    const missing = ready.filter((n) => !labelsOf(child).has(n));
    if (missing.length > 0) await ctx.gh.addLabels(child.number, missing);
  }

  await appComment(
    ctx,
    parent,
    'epic-split',
    ['子課題を作りました。子課題ごとに計画・実装・判定を進めます。全部閉じるとこの Issue を閉じます。', '', ...children.map((c, i) => `- #${c.number}${split[i]!.dependsOn.length > 0 ? `（${split[i]!.dependsOn.map((d) => `#${children[d]!.number}`).join('、')} の後）` : ''}`)].join('\n'),
    { version: 1, planCommentId: comment.id, children: children.map((c) => c.number) } satisfies EpicSplitRecord,
  );
}
