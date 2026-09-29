import assert from 'node:assert/strict';
import { appMark, extractBlock, renderBlock } from '../../lib/blocks.ts';
import { reasonMark } from '../../lib/config.ts';
import { patchId } from '../../lib/patch-id.ts';
import { APP, config, DIFF, HEAD, acceptanceFake, pr, type FakeGitHub } from './gate-fixtures.ts';

/** スタックでない別ブランチ（orphan-base になる base） */
export const FEATURE_BASE = { ref: 'feature/base', sha: 'b'.repeat(40) };

/** REST が返す PR の stack（スタックの一番下が既定ブランチ宛て） */
export const STACK = { base: { ref: 'main', sha: 'c'.repeat(40) }, id: 1, number: 1, position: 2, size: 2 };

/** スタックでないのに base が既定ブランチ以外の PR */
export function orphanPr(patch: Record<string, unknown> = {}) {
  return pr({ base: FEATURE_BASE, ...patch });
}

/** スタックに組み込まれた上の層の PR（base は下の層のブランチ） */
export function stackedPr(patch: Record<string, unknown> = {}) {
  return pr({ base: FEATURE_BASE, stack: STACK, ...patch });
}

/** App のコメント（kind の印と agent-app の記録） */
export function appRecordComment(id: number, kind: string, text: string, record?: unknown) {
  return {
    id, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: [appMark(kind), text, ...(record === undefined ? [] : [renderBlock('agent-app', record)])].join('\n'),
  };
}

/** App の orphan-base の記録（理由コード付き） */
export function orphanRecord(id = 95, base = FEATURE_BASE.ref) {
  return appRecordComment(id, 'orphan-base', `${reasonMark('orphan-base')}\nbase が既定ブランチではありません。`, { version: 1, base, headSha: HEAD });
}

/** App の base-resolved の記録 */
export function baseResolvedRecord(id = 96, kind: 'stacked' | 'default' = 'stacked', base = FEATURE_BASE.ref) {
  return appRecordComment(id, 'base-resolved', 'base の問題が解消しました。', { version: 1, base, kind });
}

/** 修正回数の上限で App が止めた記録（理由コード fix-limit） */
export function fixLimitComment(id = 97) {
  return appRecordComment(id, 'fix-limit', `${reasonMark('fix-limit')}\n修正回数の上限に達しました。`);
}

/** 現在の差分（DIFF）に対する受け付けの記録 */
export function acceptanceComment(id = 91, patch: Record<string, unknown> = {}) {
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: false, reasons: ['Stacked PR のため Human Merge（GitHub の auto-merge と Merge API が使えない）'], ...patch };
  return appRecordComment(id, 'acceptance', '受け付けました。', acceptance);
}

/** events API の labeled／unlabeled（agent:blocked） */
export const blockedLabeledBy = (login: string) => ({ event: 'labeled', created_at: '2026-09-26T00:00:00Z', label: { name: 'agent:blocked' }, actor: { login } });
export const blockedUnlabeledBy = (login: string) => ({ event: 'unlabeled', created_at: '2026-09-26T01:00:00Z', label: { name: 'agent:blocked' }, actor: { login } });

export const BLOCKED = [{ name: 'agent:blocked' }];

/**
 * 判定の受け付けに必要な応答（acceptanceFake）に、PR #5 の events を足した偽の GitHub。
 * DELETE ラベル・POST ラベルは acceptanceFake が応答する。
 */
export function stackFake(state: { pr: ReturnType<typeof pr>; prComments?: unknown[]; events?: unknown[]; dashboardLabels?: string[] }): FakeGitHub {
  return acceptanceFake({ pr: state.pr, dashboardLabels: state.dashboardLabels ?? [], prComments: state.prComments ?? [] })
    .on('GET', /\/issues\/5\/events/, () => state.events ?? []);
}

/**
 * 定期実行（onSchedule）用。stackFake に、開いた PR の一覧・Issue の一覧・ダッシュボードの読み書きを足す。
 * list は GET /pulls?state=open の応答（既定では state.pr だけ）。
 * 閉じた PR の一覧（GET /pulls?state=closed、委任承認で Merge された PR の節）は acceptanceFake の空の一覧を引き継ぐ。
 */
export function scheduleStackFake(state: { pr: ReturnType<typeof pr>; list?: unknown[]; prComments?: unknown[]; events?: unknown[] }): FakeGitHub {
  const dashboard = { number: 1, title: config.dashboardIssueTitle, html_url: 'd', updated_at: '2026-09-27T00:00:00Z', user: { login: APP }, labels: [] };
  return stackFake({ pr: state.pr, prComments: state.prComments, events: state.events })
    .on('GET', /\/issues\?state=open&creator=/, () => [dashboard])
    .on('GET', /\/issues\?state=open&per_page/, () => [dashboard])
    .on('GET', /\/pulls\?state=open/, () => state.list ?? [state.pr])
    .on('GET', /\/issues\/1$/, () => ({ body: '' }))
    .on('PATCH', /\/issues\/1$/, () => ({}));
}

/** ダッシュボード（#1）へのラベルの付け外しのイベント（issues の labeled／unlabeled。labels は出来事の後のダッシュボードのラベル） */
export const dashboardLabelEvent = (action: 'labeled' | 'unlabeled', label: string, sender: string, labels: string[]) => ({
  action,
  issue: { number: 1, title: config.dashboardIssueTitle, body: '', labels: labels.map((name) => ({ name })), state: 'open' },
  label: { name: label },
  sender: { login: sender },
});

/** POST された App のコメント（kind 指定）の本文 */
export function postedBodies(fake: FakeGitHub, kind: string): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && /\/issues\/\d+\/comments$/.test(c.path) && String(c.body?.body).includes(appMark(kind)))
    .map((c) => String(c.body.body));
}

/** POST された App のコメント（kind 指定）の agent-app の記録 */
export function postedRecord(fake: FakeGitHub, kind: string): Record<string, any> {
  const body = postedBodies(fake, kind).at(-1);
  assert.ok(body, `kind=${kind} のコメントを投稿していません`);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok, `kind=${kind} の記録を読めません`);
  return block.value as Record<string, any>;
}

/** 呼び出しの回数（メソッドとパスの完全一致、クエリは除く） */
export function countCalls(fake: FakeGitHub, method: string, path: string): number {
  return fake.calls.filter((c) => c.method === method && c.path.split('?')[0] === path).length;
}
