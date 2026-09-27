import { appLogin, LABELS } from '../lib/config.ts';
import { parseChildMarker, renderChildBody, type SplitChild } from '../lib/epic.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Plan } from '../lib/plan.ts';
import type { PlanGateRecord } from '../lib/state.ts';
import { appComment, type GateContext } from './context.ts';

interface IssueItem {
  id: number;
  number: number;
  body: string | null;
  labels: ({ name: string } | string)[];
  user: { login: string } | null;
}

/**
 * split 付きの計画が計画ゲートを通ったとき：親に epic を付け、子 Issue・Sub-issues・依存を作る。
 * 途中で失敗して再実行しても二重に作らないよう、App が作った目印付きの Issue（Sub-issues と App 作成の Issue）を先に読んで使い回し、
 * 未登録の Sub-issue・依存だけを登録する。
 */
export async function splitEpic(
  ctx: GateContext,
  issue: { number: number; labels: { name: string }[] },
  comment: IssueComment,
  plan: Plan & { split: SplitChild[] },
  record: PlanGateRecord,
): Promise<void> {
  const parent = issue.number;
  const split = plan.split;
  await ctx.gh.removeLabel(parent, LABELS.planOk);
  await ctx.gh.addLabels(parent, [LABELS.epic]);
  await appComment(ctx, parent, 'plan-gate', `計画ゲートを通過しました（[計画](${comment.html_url})）。Epic として ${split.length} 件の子課題に分けます（この Issue は実装しません）。`, record);

  const app = appLogin(ctx.config);
  const subIssues = await ctx.gh.paginate<IssueItem>(`/issues/${parent}/sub_issues`);
  const created = await ctx.gh.paginate<IssueItem>(`/issues?state=all&creator=${encodeURIComponent(app)}`);
  const existing = new Map<number, IssueItem>();
  for (const item of [...subIssues, ...created]) {
    const mark = parseChildMarker(item.body);
    if (item.user?.login !== app || mark?.parent !== parent || existing.has(mark.index)) continue;
    existing.set(mark.index, item);
  }
  const registered = new Set(subIssues.map((s) => s.number));

  const children: IssueItem[] = [];
  for (let i = 0; i < split.length; i++) {
    let child = existing.get(i);
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

  for (let i = 0; i < split.length; i++) {
    if (split[i]!.dependsOn.length === 0) continue;
    const child = children[i]!;
    const blockedBy = new Set((await ctx.gh.paginate<IssueItem>(`/issues/${child.number}/dependencies/blocked_by`)).map((b) => b.number));
    for (const d of split[i]!.dependsOn) {
      const blocker = children[d]!;
      if (!blockedBy.has(blocker.number)) await ctx.gh.request('POST', `/issues/${child.number}/dependencies/blocked_by`, { body: { issue_id: blocker.id } });
    }
  }

  // 依存を登録してから agent:ready を付ける（付くと on-issue が子の書式を検査し、queue に乗る）
  const inherit = issue.labels.map((l) => l.name).filter((n) => n === LABELS.ready || n.startsWith('priority:'));
  for (const child of children) {
    const have = new Set(child.labels.map((l) => (typeof l === 'string' ? l : l.name)));
    const missing = inherit.filter((n) => !have.has(n));
    if (missing.length > 0) await ctx.gh.addLabels(child.number, missing);
  }

  await appComment(
    ctx,
    parent,
    'epic-split',
    ['子課題を作りました。子課題ごとに計画・実装・判定を進めます。全部閉じるとこの Issue を閉じます。', '', ...children.map((c, i) => `- #${c.number}${split[i]!.dependsOn.length > 0 ? `（${split[i]!.dependsOn.map((d) => `#${children[d]!.number}`).join('、')} の後）` : ''}`)].join('\n'),
    { version: 1, planCommentId: comment.id, children: children.map((c) => c.number) },
  );
}
