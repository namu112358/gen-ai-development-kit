// 判定の集計で fix の PR を元の PR に結び付ける条件（変えた行の一致か参照）と、その根拠の表示のテスト（Issue #267）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import { loadConfig } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { fixLinksFor, fixPrFilesOf, fixPrsFor, panelPairs, patchLines, references, renderReport, summarize } from '../lib/report.ts';
import type { FixLink, MergedPr, ReportRow } from '../lib/report.ts';
import { renderPanelRecord, type PanelRecord } from '../lib/review-panel.ts';
import type { BlockingFinding } from '../lib/verdict.ts';
import { APP, verdict } from './support/gate-fixtures.ts';

const config = loadConfig();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** fix を探すときの PR の fake */
function mpr(o: Partial<MergedPr> & { number: number }): MergedPr {
  return { title: 'feat: 追加', headRef: `claude/issue-${o.number}-x`, mergedAt: at(0), files: [], ...o };
}

// ---- patchLines ----

test('patchLines：hunk ヘッダと文脈行を除き、足した行・消した行の内容を前後の空白を除いて返す', () => {
  const patch = ['@@ -1,4 +1,4 @@', ' 文脈の行はそのまま', '-  消した行です  ', '+  足した行です\t', ' もう一つの文脈', '@@ -20,2 +20,3 @@', '+二つ目の hunk で足した行'].join('\n');
  assert.deepEqual(patchLines(patch), { added: ['足した行です', '二つ目の hunk で足した行'], removed: ['消した行です'] });
});

test('patchLines：文字・数字を含まない行や 4 文字未満の行（空行・}・---・| --- |・```）は比べないので除く', () => {
  const patch = ['@@ -1,6 +1,6 @@', '+', '+   ', '+}', '+---', '+| --- |', '+```', '+abc', '-', '-```', '-  ---  ', '+abcd', '-消した一行です'].join('\n');
  assert.deepEqual(patchLines(patch), { added: ['abcd'], removed: ['消した一行です'] });
});

test('patchLines：CRLF の patch でも行の内容に改行を残さない', () => {
  assert.deepEqual(patchLines('@@ -1 +1 @@\r\n-古い一行です\r\n+新しい一行です\r\n'), { added: ['新しい一行です'], removed: ['古い一行です'] });
});

// ---- references ----

test('references：#n・/pull/n・/issues/n を見つける', () => {
  assert.equal(references('#182 の続き', 182), true);
  assert.equal(references('Closes #182', 182), true);
  assert.equal(references('（#182）', 182), true);
  assert.equal(references('https://github.com/o/r/pull/182', 182), true);
  assert.equal(references('https://github.com/o/r/issues/182#issuecomment-1', 182), true);
  assert.equal(references('文末の #182', 182), true);
});

test('references：後ろに数字が続くもの・# の直前が英数字のもの・参照の無いものは false', () => {
  assert.equal(references('#1820 を直す', 182), false);
  assert.equal(references('/pull/1820', 182), false);
  assert.equal(references('/issues/18200', 182), false);
  assert.equal(references('abc#182', 182), false);
  assert.equal(references('x1#182', 182), false);
  assert.equal(references('182 を直す', 182), false);
  assert.equal(references('#18 を直す', 182), false);
  assert.equal(references('', 182), false);
});

// ---- fixLinksFor：AC1（同じファイルに別の節を足しただけは結び付けない） ----

const SETUP_A = ['@@ -40,3 +40,9 @@ ## 7. 既存の節', ' 既存の本文です', ' ', '+## 8. プラグイン（全員に同じ版で入れる）', '+', '+プラグインは全員に同じ版で入れる。', '+---', '+```', '+npm run plugins', '+```'].join('\n');
const SETUP_B = ['@@ -60,3 +60,8 @@ ## 8. プラグイン（全員に同じ版で入れる）', ' npm run plugins', ' ```', '+', '+## 9. Windows の注意', '+', '+Windows では Git Bash を使う。'].join('\n');

test('fixLinksFor：#182 と #244 の形（同じファイルに別の節を足すだけ・消した行も参照も無い）は結び付けない', () => {
  const base = mpr({ number: 182, title: 'docs: プラグインの節を足す', files: ['docs/setup.md'], patches: { 'docs/setup.md': SETUP_A }, closes: [180] });
  const fix = mpr({ number: 244, title: 'fix(harness): Windows の注意を足す', headRef: 'claude/issue-243-windows', mergedAt: at(3 * DAY), files: ['docs/setup.md'], body: 'Closes #243', closes: [243], patches: { 'docs/setup.md': SETUP_B } });
  assert.deepEqual(fixLinksFor(base, [fix]), []);
  assert.deepEqual(fixPrsFor(base, [fix]), []);
});

test('fixLinksFor：fix が消したのが記号だけ・空行だけの行（---・```・空行）なら、元が同じ行を足していても結び付けない', () => {
  const base = mpr({ number: 182, files: ['docs/setup.md'], patches: { 'docs/setup.md': SETUP_A } });
  const fixPatch = ['@@ -70,6 +70,4 @@', ' プラグインは全員に同じ版で入れる。', '----', '-```', '-', '+Windows では Git Bash を使う。'].join('\n');
  const fix = mpr({ number: 244, title: 'fix: 区切りを消す', mergedAt: at(DAY), files: ['docs/setup.md'], patches: { 'docs/setup.md': fixPatch } });
  assert.deepEqual(fixLinksFor(base, [fix]), []);
});

// ---- fixLinksFor：AC2（元の PR が変えた箇所を直す fix はこれまでどおり結び付ける） ----

const BASE_A = ['@@ -1,3 +1,5 @@', ' export const a = 1;', '+export const limit = compute(1, 2);', '+export const name = "old";', ' export const b = 2;'].join('\n');

test('fixLinksFor：元が足した行を fix が書き換える（hunk ヘッダの行番号がずれていても）→ 行', () => {
  const base = mpr({ number: 10, files: ['a.ts', 'b.ts'], patches: { 'a.ts': BASE_A, 'b.ts': '@@ -1 +1 @@\n+export const other = true;' } });
  const fixPatch = ['@@ -31,3 +31,3 @@ function x() {', ' export const a = 1;', '-export const limit = compute(1, 2);', '+export const limit = compute(1, 3);'].join('\n');
  const fix = mpr({ number: 11, title: 'fix: limit を直す', mergedAt: at(2 * DAY), files: ['a.ts', 'b.ts'], patches: { 'a.ts': fixPatch, 'b.ts': '@@ -5 +5,2 @@\n+export const unrelated = 1;' } });
  assert.deepEqual(fixLinksFor(base, [fix]), [{ pr: 11, basis: ['lines'], files: ['a.ts'] }]);
  assert.deepEqual(fixPrsFor(base, [fix]), [11]);
});

test('fixLinksFor：元が消した行を fix が足し戻す → 行', () => {
  const base = mpr({ number: 10, files: ['a.ts'], patches: { 'a.ts': '@@ -1,3 +1,2 @@\n export const a = 1;\n-export const guard = check(input);\n' } });
  const fix = mpr({ number: 11, title: 'fix: guard を戻す', mergedAt: at(DAY), files: ['a.ts'], patches: { 'a.ts': '@@ -8,2 +8,3 @@\n export const a = 1;\n+  export const guard = check(input);\n' } });
  assert.deepEqual(fixLinksFor(base, [fix]), [{ pr: 11, basis: ['lines'], files: ['a.ts'] }]);
});

test('fixLinksFor：fix の本文が元の PR 番号を参照する → 参照（files は重なるファイル全部、元の files の順）', () => {
  const base = mpr({ number: 10, files: ['b.ts', 'a.ts', 'c.ts'] });
  const fix = mpr({ number: 11, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts', 'b.ts'], body: '#10 で入れた処理を直す' });
  assert.deepEqual(fixLinksFor(base, [fix]), [{ pr: 11, basis: ['ref'], files: ['b.ts', 'a.ts'] }]);
});

test('fixLinksFor：fix の題名・/pull/n の参照と、元の PR と同じ Issue を Closes することでも参照になる', () => {
  const base = mpr({ number: 10, files: ['a.ts'], closes: [50] });
  const byTitle = mpr({ number: 11, title: 'fix: #10 の続き', mergedAt: at(DAY), files: ['a.ts'] });
  const byClosing = mpr({ number: 12, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts'], closes: [50] });
  const byUrl = mpr({ number: 13, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts'], body: 'https://github.com/o/r/pull/10 を直す' });
  assert.deepEqual(fixLinksFor(base, [byTitle, byClosing, byUrl]).map((l) => [l.pr, l.basis]), [[11, ['ref']], [12, ['ref']], [13, ['ref']]]);
});

test('fixLinksFor：元の PR が Closes した Issue の番号を fix の本文で参照する → 参照', () => {
  const base = mpr({ number: 10, files: ['a.ts'], closes: [7, 8] });
  const fix = mpr({ number: 11, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts'], body: 'Issue #8 の直し漏れ' });
  assert.deepEqual(fixLinksFor(base, [fix]), [{ pr: 11, basis: ['ref'], files: ['a.ts'] }]);
});

test('fixLinksFor：#100 のように後ろに数字が続く参照だけなら結び付けない', () => {
  const base = mpr({ number: 10, files: ['a.ts'] });
  const fix = mpr({ number: 11, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts'], body: '#100 を直す。abc#10 と /issues/101' });
  assert.deepEqual(fixLinksFor(base, [fix]), []);
});

test('fixLinksFor：#267 の形（背景で過去の PR を名指しする Issue を Closes する fix の PR）は、Issue の本文を見ないので結び付けない', () => {
  // 元の PR #244 は Issue #243 を Closes した。fix の PR #271 は Issue #267（本文で #182・#244 に触れる）を Closes し、同じ README を触る
  const base = mpr({ number: 244, files: ['harness/test/README.md', '.gitattributes'], closes: [243] });
  const fix = mpr({ number: 271, title: 'fix(harness): 判定の集計で結び付けを絞る', headRef: 'claude/issue-267-fix-link', mergedAt: at(DAY), files: ['harness/test/README.md'], body: 'Closes #267', closes: [267] });
  assert.deepEqual(fixLinksFor(base, [fix]), []);
});

test('fixLinksFor：元の PR と違う Issue を Closes するだけなら結び付けない', () => {
  const base = mpr({ number: 10, files: ['a.ts'], closes: [7] });
  const fix = mpr({ number: 11, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts'], body: 'Closes #9', closes: [9] });
  assert.deepEqual(fixLinksFor(base, [fix]), []);
});

test('fixLinksFor：行と参照の両方 → basis は [lines, ref] の順、files は行が一致したファイル', () => {
  const base = mpr({ number: 10, files: ['a.ts', 'b.ts'], patches: { 'a.ts': BASE_A } });
  const fix = mpr({ number: 11, title: 'fix: #10 の limit を直す', mergedAt: at(DAY), files: ['a.ts', 'b.ts'], patches: { 'a.ts': '@@ -2 +2 @@\n-export const limit = compute(1, 2);\n+export const limit = 3;' } });
  assert.deepEqual(fixLinksFor(base, [fix]), [{ pr: 11, basis: ['lines', 'ref'], files: ['a.ts'] }]);
});

test('fixLinksFor：行が一致したファイルが複数なら元の files の順に並べる', () => {
  const base = mpr({ number: 10, files: ['b.ts', 'a.ts'], patches: { 'a.ts': BASE_A, 'b.ts': '@@ -1 +1 @@\n+export const name = "old";' } });
  const fix = mpr({ number: 11, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts', 'b.ts'], patches: { 'a.ts': '@@ -2 +2 @@\n-export const limit = compute(1, 2);', 'b.ts': '@@ -1 +1 @@\n-export const name = "old";' } });
  assert.deepEqual(fixLinksFor(base, [fix]), [{ pr: 11, basis: ['lines'], files: ['b.ts', 'a.ts'] }]);
});

test('fixLinksFor：ファイルが重ならなければ、参照があっても行が同じでも結び付けない', () => {
  const base = mpr({ number: 10, files: ['a.ts'], patches: { 'a.ts': BASE_A } });
  const fix = mpr({ number: 11, title: 'fix: #10 を直す', mergedAt: at(DAY), files: ['c.ts'], patches: { 'c.ts': '@@ -2 +2 @@\n-export const limit = compute(1, 2);' } });
  assert.deepEqual(fixLinksFor(base, [fix]), []);
});

test('fixLinksFor：どちらかに patch が無いファイルは行の比較をしない', () => {
  const removed = '@@ -2 +2 @@\n-export const limit = compute(1, 2);';
  const noBasePatch = mpr({ number: 10, files: ['a.ts'] });
  const fix = mpr({ number: 11, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts'], patches: { 'a.ts': removed } });
  assert.deepEqual(fixLinksFor(noBasePatch, [fix]), []);
  const base = mpr({ number: 20, files: ['a.ts'], patches: { 'a.ts': BASE_A } });
  const noFixPatch = mpr({ number: 21, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts'], patches: { 'a.ts': undefined } });
  assert.deepEqual(fixLinksFor(base, [noFixPatch]), []);
});

test('fixLinksFor：7 日を超えた・fix でない・Merge より前・未 Merge・自分自身は、参照があっても結び付けない', () => {
  const base = mpr({ number: 10, files: ['a.ts'] });
  const body = '#10 を直す';
  const all = [
    base,
    mpr({ number: 11, title: 'fix: 直す', mergedAt: at(7 * DAY + 1), files: ['a.ts'], body }), // 7 日を超えた
    mpr({ number: 12, title: 'feat: 足す', mergedAt: at(DAY), files: ['a.ts'], body }), // fix でない
    mpr({ number: 13, title: 'fix: 直す', mergedAt: at(-DAY), files: ['a.ts'], body }), // Merge より前
    mpr({ number: 14, title: 'fix: 直す', mergedAt: at(0), files: ['a.ts'], body }), // 同時
    mpr({ number: 15, title: 'fix: 直す', mergedAt: null, files: ['a.ts'], body }), // 未 Merge
    mpr({ number: 16, title: 'fix: 直す', mergedAt: at(7 * DAY), files: ['a.ts'], body }), // ちょうど 7 日：結び付く
  ];
  assert.deepEqual(fixLinksFor(base, all).map((l) => l.pr), [16]);
  assert.deepEqual(fixLinksFor(mpr({ number: 10, mergedAt: null, files: ['a.ts'] }), all), []);
});

test('fixLinksFor：mergedPrs の順に返し、fixPrsFor はその番号', () => {
  const base = mpr({ number: 10, files: ['a.ts'] });
  const all = [13, 11, 12].map((n) => mpr({ number: n, title: 'fix: 直す', mergedAt: at(DAY), files: ['a.ts'], body: '#10' }));
  assert.deepEqual(fixLinksFor(base, all).map((l) => l.pr), [13, 11, 12]);
  assert.deepEqual(fixPrsFor(base, all), [13, 11, 12]);
});

// ---- fixPrFilesOf ----

test('fixPrFilesOf：fix の PR 番号ごとの根拠のファイル', () => {
  const links: FixLink[] = [
    { pr: 11, basis: ['lines'], files: ['a.ts'] },
    { pr: 12, basis: ['ref'], files: ['a.ts', 'b.ts'] },
  ];
  assert.deepEqual(fixPrFilesOf(links), { 11: ['a.ts'], 12: ['a.ts', 'b.ts'] });
  assert.deepEqual(fixPrFilesOf([]), {});
});

test('合体版の比較：fixPrFilesOf の値を渡すと、根拠のファイルの指摘だけに fix-pr の裏付けが付く', () => {
  const head = 'a'.repeat(40);
  const pr = 30;
  const T = Date.parse('2026-09-01T00:00:00Z');
  const t = (min: number, sec = 0) => new Date(T + min * 60_000 + sec * 1000).toISOString();
  let id = 5000;
  const comment = (body: string, when: string, login = 'me', association = 'OWNER'): IssueComment => {
    const cid = id++;
    return { id: cid, body, html_url: `u${cid}`, created_at: when, updated_at: when, author_association: association, user: { login, type: login === APP ? 'Bot' : 'User' } };
  };
  const f = (file: string): BlockingFinding => ({ kind: 'bug', file, detail: `${file} の指摘` });
  const record: PanelRecord = {
    version: 1,
    pr,
    headSha: head,
    mode: 'shadow',
    review: { pass: false, blocking: [f('a.ts'), f('b.ts')], nonBlocking: [], humanNotes: { concerns: [], checkPoints: [] } },
    findings: [],
    check: { exitCode: 0 },
    material: { pastPrs: 0, pastPrsWithoutComments: 0 },
    cost: { panel: null, reviewer: null },
  };
  const rec = comment(renderPanelRecord(record), t(0));
  const v = verdict({ pr, headSha: head, review: { pass: true, blocking: [], nonBlocking: [] } });
  const vc = comment(`${CLAUDE_MARK}\n判定\n${renderBlock('agent-verdict', v)}`, t(1));
  const value: Acceptance = {
    version: 1, verdictCommentId: vc.id, verdictHeadSha: head, patchId: 'p'.repeat(40), reviewPass: true,
    riskLevel: 'critical', riskOk: false, scopeOk: true, outside: [], guardrail: [], autoEligible: false, reasons: ['理由'],
  };
  const ac = comment(`${appMark('acceptance')}\n受け付け\n${renderBlock('agent-app', value)}`, t(1, 1), APP, 'NONE');

  // fix の PR #31 は a.ts と b.ts を触ったが、根拠は a.ts の行だけ
  const links: FixLink[] = [{ pr: 31, basis: ['lines'], files: ['a.ts'] }];
  const { rows } = panelPairs(config, {
    pr,
    mergedAt: t(10),
    reverted: false,
    fixedBy: links.map((l) => l.pr),
    fixRequests: 0,
    comments: [rec, vc, ac],
    acceptances: [{ comment: ac, value }],
    fixRequestReviews: [],
    reviewComments: [],
    fixPrFiles: fixPrFilesOf(links),
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.panelOnly.map((x) => [x.file, x.backing, x.evidence]), [
    ['a.ts', 'backed', ['fix-pr']],
    ['b.ts', 'suspected', []],
  ]);
});

// ---- AC3：集計の表に根拠を出す ----

function acc(): Acceptance {
  return {
    version: 1, verdictCommentId: 1, verdictHeadSha: 'a'.repeat(40), patchId: 'p'.repeat(40), reviewPass: true,
    riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], guardrail: [], autoEligible: true, reasons: [],
  };
}

function row(pr: number, over: Partial<ReportRow> = {}): ReportRow {
  return { pr, createdAt: at(0), mergedAt: at(HOUR), closedAt: null, acceptance: acc(), rejected: 0, fixRequests: 0, reverted: false, fixedBy: [], ...over };
}

test('renderReport：fix PR の列に、結び付いた fix の PR ごとの根拠（行・参照・行・参照）を出す', () => {
  const links: FixLink[] = [
    { pr: 11, basis: ['lines'], files: ['a.ts'] },
    { pr: 12, basis: ['ref'], files: ['a.ts'] },
    { pr: 13, basis: ['lines', 'ref'], files: ['a.ts'] },
  ];
  const rows = [row(1, { fixedBy: [11, 12, 13], fixLinks: links }), row(2, { fixedBy: [21] })];
  const md = renderReport(summarize(config, rows), rows, 30);
  const line1 = md.split('\n').find((l) => l.startsWith('| #1 |'));
  assert.ok(line1, '#1 の行が無い');
  assert.ok(line1.includes('| #11（行） #12（参照） #13（行・参照） |'), line1);
  const line2 = md.split('\n').find((l) => l.startsWith('| #2 |'));
  assert.ok(line2, '#2 の行が無い');
  assert.ok(line2.includes('| #21 |'), `fixLinks の無い行は従来どおり: ${line2}`);
  assert.ok(!line2.includes('#21（'), line2);
});
