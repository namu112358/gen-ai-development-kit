import { extractBlock, renderBlock } from '../lib/blocks.ts';
import { TRUSTED_ASSOCIATIONS } from '../lib/config.ts';
import { computeQueue, type QueueResult } from '../lib/facts.ts';
import type { IssueComment } from '../lib/github.ts';
import type { GateContext } from './context.ts';
import { ensureDashboard } from './stale.ts';

/**
 * 次にやること（queue）を App が計算し、ダッシュボード Issue の本文に公開する。
 * Routine は GitHub API を直接呼べない（MCP ツールのみ）ため、このダッシュボードを読んで従う。
 * 状態の判定（plan-ok を付けたのが App か、判定が現在の差分に有効か など）を App 側で行うので、Routine 側で偽装しにくい。
 * queue の節の後ろに、Routine が書いたセッションの問題の記録（agent-incident）を並べる「改善の候補」の節も出す（#187。表示だけ）。
 */

/**
 * queue を公開し直すイベントか。定期実行と手動の起動のときだけ（#379）。イベントのたびに計算すると
 * 1回で約80回の API を呼び、App の installation の上限（1時間 5000 回）を超えるため
 */
export function publishesQueueOn(eventName: string): boolean {
  return eventName === 'schedule' || eventName === 'workflow_dispatch';
}

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

export const IMPROVE_START = '<!-- agent-harness:improve:start -->';
export const IMPROVE_END = '<!-- agent-harness:improve:end -->';

/** 改善の候補の節に出す記録の最大の数（コメントの数） */
const IMPROVE_LIMIT = 20;
/** 1件の「起きたこと」を表示する最大の文字数 */
const WHAT_LIMIT = 200;

/** ダッシュボードの Routine のコメント（```agent-incident）1件。表示だけで信頼しない */
export interface IncidentEntry {
  url: string;
  createdAt: string;
  session: string | null;
  incidents: { kind: string; target?: string; what: string }[];
}

/**
 * ダッシュボードのコメント（paginate の古い順）から、コラボレーターの agent-incident のコメントを新しい順に最大 20 件（#187）。
 * ブロックが読めない・形の違うものは飛ばす
 */
export function collectIncidentComments(comments: IssueComment[]): IncidentEntry[] {
  const out: IncidentEntry[] = [];
  for (const c of [...comments].reverse()) {
    if (out.length >= IMPROVE_LIMIT) break;
    if (!TRUSTED_ASSOCIATIONS.has(c.author_association)) continue;
    const block = extractBlock(c.body, 'agent-incident');
    if (!block.found || !block.ok) continue;
    const v = block.value as { session?: unknown; incidents?: unknown } | null;
    if (v === null || typeof v !== 'object' || !Array.isArray(v.incidents)) continue;
    const incidents = (v.incidents as unknown[])
      .filter((i): i is Record<string, unknown> => i !== null && typeof i === 'object' && typeof (i as Record<string, unknown>).kind === 'string' && typeof (i as Record<string, unknown>).what === 'string')
      .map((i) => ({ kind: i.kind as string, what: i.what as string, ...(typeof i.target === 'string' ? { target: i.target } : {}) }));
    out.push({ url: c.html_url, createdAt: c.created_at, session: typeof v.session === 'string' ? v.session : null, incidents });
  }
  return out;
}

/** 表示する文字列を1行にし、目印・HTML として働かないよう < を置き換え、長ければ切る */
function shown(text: string, limit = WHAT_LIMIT): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const cut = line.length > limit ? `${line.slice(0, limit)}…` : line;
  return cut.replace(/</g, '&lt;');
}

/** ダッシュボードの「改善の候補」の節。entries が null なら読めなかった */
export function renderImproveSection(entries: IncidentEntry[] | null): string {
  const lines: string[] = [];
  if (entries === null) lines.push('読めませんでした');
  else if (entries.length === 0) lines.push('なし');
  else {
    for (const e of entries) {
      const counts = new Map<string, number>();
      for (const i of e.incidents) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
      const summary = [...counts].map(([k, n]) => `${shown(k, 40)} ${n} 件`).join('・') || '0 件';
      lines.push(`- [${shown(e.createdAt, 40)}](${e.url})${e.session ? ` session ${shown(e.session, 80)}` : ''}：${summary}`);
      for (const i of e.incidents) lines.push(`  - ${shown(i.kind, 40)}${i.target ? ` ${shown(i.target, 40)}` : ''}：${shown(i.what)}`);
    }
  }
  return [
    IMPROVE_START,
    '### 改善の候補',
    '',
    `Routine がこのダッシュボードに書いたセッションの問題の記録（コラボレーターの \`agent-incident\` のコメント。直近 ${IMPROVE_DAYS} 日のものを新しい順に最大 ${IMPROVE_LIMIT} 件）。表示だけで、ゲートの判断には使いません。起票するかは人が決めます。`,
    '',
    ...lines,
    IMPROVE_END,
  ].join('\n');
}

/** 本文の改善の候補の節を差し替える（無ければ queue の節の直後、それも無ければ末尾に足す） */
export function replaceImproveSection(body: string, section: string): string {
  const start = body.indexOf(IMPROVE_START);
  const end = body.indexOf(IMPROVE_END);
  if (start >= 0 && end > start) return body.slice(0, start) + section + body.slice(end + IMPROVE_END.length);
  const queueEnd = body.indexOf(QUEUE_END);
  if (queueEnd >= 0) {
    const at = queueEnd + QUEUE_END.length;
    return `${body.slice(0, at)}\n\n${section}${body.slice(at)}`;
  }
  return `${body.trimEnd()}\n\n${section}`;
}

/** 改善の候補の節で読むコメントの期間（日）と、読む最大のページ数（100 件ずつ）。#384 の API の節約を崩さないよう、全コメントは読まない */
const IMPROVE_DAYS = 7;
const IMPROVE_MAX_PAGES = 3;

/**
 * ダッシュボードの直近 7 日のコメント（since で絞る。最大 3 ページ）を読んで改善の候補の節を作る。
 * 読めなければ「読めませんでした」の節（投げない。queue の公開とジョブの成否に響かせない）
 */
export async function improveSectionFor(ctx: GateContext, dashboard: number, now: Date = new Date()): Promise<string> {
  try {
    const since = new Date(now.getTime() - IMPROVE_DAYS * 24 * 3600_000).toISOString();
    const comments = await ctx.gh.paginate<IssueComment>(`/issues/${dashboard}/comments?since=${encodeURIComponent(since)}`, IMPROVE_MAX_PAGES);
    return renderImproveSection(collectIncidentComments(comments));
  } catch (e) {
    ctx.log(`改善の候補のコメントが読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return renderImproveSection(null);
  }
}

export async function publishQueue(ctx: GateContext): Promise<void> {
  const q = await computeQueue(ctx.gh, ctx.config, null);
  const dashboard = await ensureDashboard(ctx);
  const issue = await ctx.gh.get<{ body: string | null }>(`/issues/${dashboard}`);
  const withQueue = replaceQueueSection(issue.body ?? '', renderQueueSection(q));
  const body = replaceImproveSection(withQueue, await improveSectionFor(ctx, dashboard));
  if (body !== issue.body) await ctx.gh.request('PATCH', `/issues/${dashboard}`, { body: { body } });
  ctx.log(`queue published to #${dashboard}: ${q.actions.length} action(s)`);
}
