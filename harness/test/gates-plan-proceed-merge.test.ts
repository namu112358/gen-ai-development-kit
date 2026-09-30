/**
 * `agent:plan-review` で人が「進める」と決めた計画（App の kind=plan-proceed の記録）の PR が、bypass・委任承認（計画＋Merge）の範囲照合を通ることを確かめる（Issue #365、harness/lib/state.ts の issueDelegateFiles）。
 * Planner の申告で止まった計画（planReviewOrigin: planner）でも、App の plan-proceed（ok）の planCommentId・planBodySha256 が最新の計画ゲートの記録と今の計画コメントに一致すれば、
 * 判定の受け付けで bypass.eligible・delegate.eligible が真になり auto-merge が付く。記録が無い・決定の後に計画が編集された・計画を出し直した・App 以外の名義の記録・ineligible の記録では、照合に使える計画が無い扱いのまま。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import { bypassMergeConfig, delegateConfig } from '../lib/config.ts';
import { GitHub } from '../lib/github.ts';
import type { Plan } from '../lib/plan.ts';
import { issueDelegateFiles, issuePlannedFiles, plannedFilesForDelegate } from '../lib/state.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config, CRITIQUE, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';
import { postedRecord } from './support/stack-fixtures.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const BYPASS = bypassMergeConfig(config).label;
const DELEGATE = delegateConfig(config).mergeLabel;
/** ガードレールにも delegateMergeExclude にも当たる（bypass でだけ乗る） */
const CONFIG_FILE = 'harness.config.json';
/** ガードレールに当たるが delegateMergeExclude には当たらない（委任で乗る） */
const GUARDED = 'harness/lib/epic.ts';
const MISSING = '#3 に委任承認で照合できる計画がありません（ゲートを通ったか、ゲートの停止で止まった計画だけを使う）';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const ev = (name: string, at: string) => ({ event: 'labeled', created_at: at, actor: { login: 'me' }, label: { name } });

const planOf = (files: string[]): Plan => ({
  version: 1, issue: 3, risk: 'low', needsHuman: true, needsHumanReasons: ['既定値を決める'], acChangeProposed: false, openQuestions: [], files, critique: CRITIQUE,
});
const planBodyOf = (p: Plan) => `${CLAUDE_MARK}\n## 計画\n\n${renderBlock('agent-plan', p)}`;

function comment(id: number, body: string, login: string, createdAt = '2026-09-27T00:00:00Z') {
  return {
    id, body, html_url: `c${id}`, created_at: createdAt, updated_at: createdAt,
    author_association: login === APP ? 'NONE' : 'OWNER', user: { login, type: login === APP ? 'Bot' : 'User' },
  };
}
const record = (id: number, kind: string, value: unknown, login = APP) => comment(id, `${appMark(kind)}\n記録\n${renderBlock('agent-app', value)}`, login);

const stopRecord = (id: number, planCommentId: number, p: Plan) =>
  record(id, 'plan-gate', { version: 1, planCommentId, planBodySha256: sha256(planBodyOf(p)), pass: false, reasons: ['Planner が人間の判断が必要と申告しています'], plan: p, planReviewOrigin: 'planner' });

const proceedRecord = (id: number, planCommentId: number, p: Plan, patch: Record<string, unknown> = {}, login = APP) =>
  record(id, 'plan-proceed', { version: 1, decisionCommentId: 100, planCommentId, planBodySha256: sha256(planBodyOf(p)), status: 'ok', ...patch }, login);

const decisionComment = comment(100, `${CLAUDE_MARK}\n## 人の決定\n\n${renderBlock('agent-decision', { version: 1, issue: 3, planCommentId: 80, proceed: { quote: '進めて', at: '2026-09-27T10:00:00+09:00' } })}`, 'me');

/** Issue #3 のコメントの組み立て（計画 80 → 停止 90 → 決定 100 → App の plan-proceed 110） */
function issueComments(files: string[], variant: 'proceed' | 'none' | 'edited' | 'reposted' | 'not-app' | 'ineligible' = 'proceed') {
  const p = planOf(files);
  const body = planBodyOf(p);
  const base = [comment(80, body, 'me'), stopRecord(90, 80, p), decisionComment];
  switch (variant) {
    case 'proceed':
      return [...base, proceedRecord(110, 80, p)];
    case 'none':
      return base;
    case 'edited':
      // 決定の後に計画コメントの本文が変わった（今の本文の sha256 が記録と合わない）
      return [comment(80, `${body}\n追記`, 'me'), stopRecord(90, 80, p), decisionComment, proceedRecord(110, 80, p)];
    case 'reposted': {
      // 進めると決めた後に計画を出し直し、最新の計画ゲートの記録の planCommentId が変わった
      const p2 = planOf([...files, 'docs/b.md']);
      return [...base, proceedRecord(110, 80, p), comment(120, planBodyOf(p2), 'me'), stopRecord(130, 120, p2)];
    }
    case 'not-app':
      return [...base, proceedRecord(110, 80, p, {}, 'me')];
    case 'ineligible':
      return [...base, proceedRecord(110, 80, p, { status: 'ineligible', reasons: ['窓の外で付いた印'] })];
  }
}

function fakeFor(o: { files: string[]; comments: unknown[]; dashboardLabels?: string[]; events?: unknown[] }): FakeGitHub {
  return acceptanceFake({ pr: pr(), dashboardLabels: o.dashboardLabels ?? [], dashboardEvents: o.events ?? [] })
    .on('GET', /\/issues\/3\/comments/, () => o.comments)
    .on('GET', /\/issues\/comments\/(\d+)$/, (m) => {
      const found = (o.comments as { id: number }[]).find((c) => c.id === Number(m[1]));
      if (!found) throw new Error(`404 comments/${m[1]}`);
      return found;
    })
    .on('GET', /\/pulls\/5\/files/, () => o.files.map((filename) => ({ filename, additions: 1, deletions: 1 })));
}

const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

async function accept(fake: FakeGitHub): Promise<void> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', critical()))));
}

// ---- 範囲照合に使う計画（issueDelegateFiles・plannedFilesForDelegate） ----

test('issueDelegateFiles：Planner の停止の計画でも、App の plan-proceed（ok）が一致すればその計画の files を返す', async () => {
  const gh = new GitHub(fakeFor({ files: [GUARDED], comments: issueComments([GUARDED]) }), 'o/r');
  assert.deepEqual(await issueDelegateFiles(gh, config, 3), { files: [GUARDED] });
  assert.deepEqual(await plannedFilesForDelegate(gh, config, 5), { files: [GUARDED] });
});

test('issuePlannedFiles（agent/scope）は plan-proceed があっても変わらず、計画ゲートを通過した計画が無い扱い', async () => {
  const gh = new GitHub(fakeFor({ files: [GUARDED], comments: issueComments([GUARDED]) }), 'o/r');
  assert.deepEqual(await issuePlannedFiles(gh, config, 3), { missing: '#3 に計画ゲートを通過した計画がありません' });
});

const unusable = ['none', 'edited', 'reposted', 'not-app', 'ineligible'] as const;
const unusableName: Record<(typeof unusable)[number], string> = {
  none: '人の決定の記録（plan-proceed）が無い',
  edited: '決定の後に計画コメントの本文が変わった',
  reposted: '計画を出し直した（最新の記録の planCommentId が変わった）',
  'not-app': 'App 以外の名義の plan-proceed の形のコメント',
  ineligible: 'App の plan-proceed が ineligible',
};

for (const variant of unusable) {
  test(`issueDelegateFiles：${unusableName[variant]} → 照合に使える計画が無い（今までと同じ文）`, async () => {
    const gh = new GitHub(fakeFor({ files: [GUARDED], comments: issueComments([GUARDED], variant) }), 'o/r');
    assert.deepEqual(await issueDelegateFiles(gh, config, 3), { missing: MISSING });
  });
}

// ---- AC1：bypass ----

test('AC1 bypass が有効：人が進めると決めた計画の PR は bypass.eligible が真で、auto-merge が付く', async () => {
  const fake = fakeFor({ files: [CONFIG_FILE], comments: issueComments([CONFIG_FILE]), dashboardLabels: [BYPASS], events: [ev(BYPASS, minutesAgo(300))] });
  await accept(fake);
  const a = postedRecord(fake, 'acceptance');
  assert.equal(a.scopeOk, false, 'agent/scope の照合は通過した計画だけ（変えない）');
  assert.equal(a.bypass?.eligible, true, JSON.stringify(a.bypass));
  assert.deepEqual(a.bypass?.reasons, []);
  const w = fake.writes();
  assert.ok(w.includes('comment:bypass-merge'), w.join('\n'));
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
});

// ---- AC3：委任承認（計画＋Merge） ----

test('AC3 委任承認（計画＋Merge）：人が進めると決めた計画の PR は delegate.eligible が真で、auto-merge が付く', async () => {
  const fake = fakeFor({ files: [GUARDED], comments: issueComments([GUARDED]), dashboardLabels: [DELEGATE], events: [ev(DELEGATE, minutesAgo(10))] });
  await accept(fake);
  const a = postedRecord(fake, 'acceptance');
  assert.equal(a.delegate?.scopeOk, true, JSON.stringify(a.delegate));
  assert.equal(a.delegate?.eligible, true, JSON.stringify(a.delegate));
  const w = fake.writes();
  assert.ok(w.includes('comment:delegated-merge'), w.join('\n'));
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
});

test('AC1・AC3 範囲照合は plan-proceed の計画の files で行い、外のファイルがあれば bypass・委任とも不可', async () => {
  const fake = fakeFor({ files: [GUARDED, 'docs/x.md'], comments: issueComments([GUARDED]), dashboardLabels: [BYPASS, DELEGATE], events: [ev(BYPASS, minutesAgo(300)), ev(DELEGATE, minutesAgo(10))] });
  await accept(fake);
  const a = postedRecord(fake, 'acceptance');
  assert.equal(a.delegate?.scopeOk, false);
  assert.deepEqual(a.delegate?.outside, ['docs/x.md']);
  assert.equal(a.bypass?.eligible, false);
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'));
});

// ---- AC2：照合に使える計画が無い扱い ----

for (const variant of unusable) {
  test(`AC2 ${unusableName[variant]} → delegate.scopeOk・bypass.eligible が偽で、auto-merge を付けない`, async () => {
    const fake = fakeFor({ files: [GUARDED], comments: issueComments([GUARDED], variant), dashboardLabels: [BYPASS, DELEGATE], events: [ev(BYPASS, minutesAgo(300)), ev(DELEGATE, minutesAgo(10))] });
    await accept(fake);
    const a = postedRecord(fake, 'acceptance');
    assert.equal(a.delegate?.scopeOk, false, JSON.stringify(a.delegate));
    assert.equal(a.delegate?.eligible, false);
    assert.ok((a.delegate?.outside as string[]).some((o) => o.includes(MISSING)), JSON.stringify(a.delegate?.outside));
    assert.equal(a.bypass?.eligible, false, JSON.stringify(a.bypass));
    const w = fake.writes();
    assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
    assert.ok(!w.includes('comment:bypass-merge'), w.join('\n'));
    assert.ok(!w.includes('comment:delegated-merge'), w.join('\n'));
  });
}
