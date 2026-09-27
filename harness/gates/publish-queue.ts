import { extractBlock, renderBlock } from '../lib/blocks.ts';
import { computeQueue, type QueueResult } from '../lib/facts.ts';
import type { GateContext } from './context.ts';
import { ensureDashboard } from './stale.ts';

/**
 * 次にやること（queue）を App が計算し、ダッシュボード Issue の本文に公開する。
 * Routine は GitHub API を直接呼べない（MCP ツールのみ）ため、このダッシュボードを読んで従う。
 * 状態の判定（plan-ok を付けたのが App か、判定が現在の差分に有効か など）を App 側で行うので、Routine 側で偽装しにくい。
 */

export const QUEUE_START = '<!-- agent-harness:queue:start -->';
export const QUEUE_END = '<!-- agent-harness:queue:end -->';

export function renderQueueSection(q: QueueResult): string {
  const describe = (a: QueueResult['actions'][number] | QueueResult['skipped'][number]): string => {
    switch (a.kind) {
      case 'plan': return `#${a.issue} 計画`;
      case 'implement': return `#${a.issue} 実装`;
      case 'wait-dependency': return `#${a.issue} 依存待ちにする（${a.blockers.map((b) => `#${b}`).join(', ')}）`;
      case 'judge': return `PR #${a.pr} 判定（head ${a.headSha.slice(0, 7)}）`;
      case 'fix': return `PR #${a.pr} 修正（${a.reason === 'review' ? 'Reviewer' : '人'}の指摘）`;
      case 'resolve-conflict': return `PR #${a.pr} main との衝突の解消`;
      case 'skip': return `${a.target}: ${a.reason}`;
    }
  };
  return [
    QUEUE_START,
    `### 次の Routine がやること（${q.computedAt}）`,
    '',
    ...(q.actions.length ? q.actions.map((a, i) => `${i + 1}. ${describe(a)}`) : ['なし']),
    ...(q.skipped.length ? ['', '<details><summary>スキップ</summary>', '', ...q.skipped.map((a) => `- ${describe(a)}`), '', '</details>'] : []),
    '',
    renderBlock('agent-app', { version: 1, kind: 'queue', ...q }),
    QUEUE_END,
  ].join('\n');
}

/** 本文の queue 節を差し替える（なければ末尾に足す） */
export function replaceQueueSection(body: string, section: string): string {
  const start = body.indexOf(QUEUE_START);
  const end = body.indexOf(QUEUE_END);
  if (start >= 0 && end > start) return body.slice(0, start) + section + body.slice(end + QUEUE_END.length);
  return `${body.trimEnd()}\n\n${section}`;
}

/** ダッシュボード本文から queue を読む（検証用・人のセッション用） */
export function readQueueSection(body: string): QueueResult | null {
  const start = body.indexOf(QUEUE_START);
  const end = body.indexOf(QUEUE_END);
  if (start < 0 || end < start) return null;
  const block = extractBlock(body.slice(start, end), 'agent-app');
  return block.found && block.ok ? (block.value as QueueResult) : null;
}

export async function publishQueue(ctx: GateContext): Promise<void> {
  const q = await computeQueue(ctx.gh, ctx.config, null);
  const dashboard = await ensureDashboard(ctx);
  const issue = await ctx.gh.get<{ body: string | null }>(`/issues/${dashboard}`);
  const body = replaceQueueSection(issue.body ?? '', renderQueueSection(q));
  if (body !== issue.body) await ctx.gh.request('PATCH', `/issues/${dashboard}`, { body: { body } });
  ctx.log(`queue published to #${dashboard}: ${q.actions.length} action(s)`);
}
