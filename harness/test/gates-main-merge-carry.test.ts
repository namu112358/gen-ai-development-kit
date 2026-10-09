// main の取り込み（App の update-branch）の push で、PR 自身の変更（追加・削除の行）が前と同じなら、合格の判定を新しい patch-id に
// 引き継いで Draft に戻さないか（harness/gates/main-merge-carry.ts）、変更の行が違う・App 以外の push・merge commit でないときは
// 今までどおり Draft に戻すか、引き継いだ記録（carriedFrom）を判定の回数・auto mode の集計で数えないかを確かめる（Issue #397）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { changedLinesId, patchId } from '../lib/patch-id.ts';
import { verdictCount } from '../lib/qa-retro.ts';
import { autoModeViewRecords } from '../lib/report.ts';
import { AUTO_MODE_JEV_QUESTION_SET } from '../lib/auto-mode.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, HEAD, ctxFor, pr, acceptanceFake } from './support/gate-fixtures.ts';

const OLD = 'c'.repeat(40);
const MAIN = 'd'.repeat(40);

/** 1つの hunk の diff の雛形。文脈・行番号・index の sha・足した行を差し替える */
function diffOf({ file = 'docs/a.md', at = 1, context = 'x', plus = 'b', index = '1111111..2222222' } = {}): string {
  return `diff --git a/${file} b/${file}\nindex ${index} 100644\n--- a/${file}\n+++ b/${file}\n@@ -${at},3 +${at},3 @@\n ${context}\n-a\n+${plus}\n ${context}\n`;
}
const OLD_DIFF = diffOf();
const NEW_DIFF = diffOf({ at: 7, context: 'main で変わった行', index: '3333333..4444444' });
const CHANGED_DIFF = diffOf({ at: 7, context: 'main で変わった行', plus: 'c' });

/** 取り込み前の head（OLD）の差分に合格の受け付け（Human Merge）がある PR。今の head の差分と、head の commit の親を差し替える */
function mergeFake(opts: { current: string; parents?: string[] }) {
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: OLD, patchId: patchId(OLD_DIFF), reviewPass: true, riskLevel: 'high', riskOk: false, scopeOk: true, outside: [], autoEligible: false, reasons: ['risk high'] };
  const prComments = [{ id: 91, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: `${appMark('acceptance')}\n${renderBlock('agent-app', acceptance)}` }];
  return acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], prComments })
    .on('GET', /\/compare\/main\.\.\.([0-9a-f]{40})$/, (m, _b, o) => (o.raw ? (m[1] === OLD ? OLD_DIFF : opts.current) : { behind_by: 0 }))
    .on('GET', /\/commits\/a{40}$/, () => ({ sha: HEAD, commit: { message: 'Merge branch main' }, parents: (opts.parents ?? [OLD, MAIN]).map((sha) => ({ sha })) }));
}

const syncEvent = (sender = APP) => ({ action: 'synchronize', before: OLD, after: HEAD, sender: { login: sender }, pull_request: { number: 5 } });

test('changedLinesId：変更の行が同じでもファイル名が違えば違う値', () => {
  assert.notEqual(changedLinesId(diffOf({ file: 'docs/a.md' })), changedLinesId(diffOf({ file: 'docs/b.md' })));
});

test('App の main の取り込みで、PR 自身の変更の行が同じなら判定を引き継ぎ、Draft に戻さない', async () => {
  assert.notEqual(patchId(OLD_DIFF), patchId(NEW_DIFF), '前提：patch-id は文脈・行番号で変わる');
  const fake = mergeFake({ current: NEW_DIFF });
  await onPullRequest(ctxFor(fake, 'pull_request_target', syncEvent()));
  const w = fake.writes();
  assert.ok(!w.includes('convertPullRequestToDraft'), 'Draft に戻さない');
  assert.ok(!w.includes('comment:draft-until-judged'));
  assert.ok(w.includes('comment:acceptance') && w.includes('check:agent/review=success'), w.join(' '));
  const posted = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/comments') && String(c.body?.body).includes('kind=acceptance'));
  const block = extractBlock(posted?.body.body, 'agent-app');
  assert.ok(block.found && block.ok);
  const value = block.value as { patchId: string; carriedFrom?: { patchId: string; headSha: string } };
  assert.equal(value.patchId, patchId(NEW_DIFF));
  assert.deepEqual(value.carriedFrom, { patchId: patchId(OLD_DIFF), headSha: OLD });
});

/** 引き継がず、今までどおり Draft に戻す場合 */
const notCarried: { name: string; current: string; sender?: string; parents?: string[] }[] = [
  { name: '+ の行が違う（PR 自身の変更が変わった）', current: CHANGED_DIFF },
  { name: 'push した人が App でない（変更の行は同じ）', current: NEW_DIFF, sender: 'me' },
  { name: 'head の親の1つ目が取り込み前の head でない', current: NEW_DIFF, parents: [MAIN, OLD] },
  { name: 'head の親が1つ（merge commit でない）', current: NEW_DIFF, parents: [OLD] },
];
for (const c of notCarried) {
  test(`引き継がず Draft に戻す：${c.name}`, async () => {
    const fake = mergeFake({ current: c.current, ...(c.parents ? { parents: c.parents } : {}) });
    await onPullRequest(ctxFor(fake, 'pull_request_target', syncEvent(c.sender)));
    const w = fake.writes();
    assert.ok(w.includes('convertPullRequestToDraft') && w.includes('comment:draft-until-judged'), w.join(' '));
    assert.ok(!w.includes('comment:acceptance'));
    assert.ok(!w.includes('check:agent/review=success'));
  });
}

test('verdictCount：引き継いだ受け付け（carriedFrom あり）は判定として数えない', () => {
  const carriedFrom = { patchId: 'p1', headSha: OLD };
  assert.equal(verdictCount([{ value: {} }, { value: { carriedFrom } }, { value: {} }]), 2);
});

test('autoModeViewRecords：引き継いだ受け付け（carriedFrom あり）は飛ばす', () => {
  const jev = { status: 'ok' as const, detail: 'jev-test', yes: 0.01, questionSet: AUTO_MODE_JEV_QUESTION_SET };
  const records = autoModeViewRecords([], [
    { patchId: 'p1', autoMode: { jev } },
    { patchId: 'p2', autoMode: { jev }, carriedFrom: { patchId: 'p1', headSha: OLD } },
  ]);
  assert.equal(records.length, 1);
});
