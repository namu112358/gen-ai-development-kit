// Issue #318：担当（lens・ac-scope・safety）が返した提案（suggestions）を読み、組み立ての nonBlocking の末尾に入れ、記録に書いて読み戻せる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composePanel, parsePanelOutputs, parsePanelRecord, renderPanelRecord,
  type CheckResult, type PanelComposition, type PanelFinding, type PanelRecord,
} from '../lib/review-panel.ts';
import { HEAD } from './support/gate-fixtures.ts';

const CHECK_OK: CheckResult = { headSha: HEAD, exitCode: 0, outputTail: 'tests 10 pass 10' };

function ok<T>(r: { ok: true; value: T } | { ok: false; errors: string[] }): T {
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.value;
}

const emptyScope = { findings: [], concerns: [], checkPoints: [] };
/** 8つの担当の出力（既定は指摘も提案も無い） */
function outputs(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intake: { eligible: true, reason: '対象', claudeMd: ['CLAUDE.md'], summary: 'PR の要約' },
    lens1: { lens: 1, findings: [] }, lens2: { lens: 2, findings: [] }, lens3: { lens: 3, findings: [] }, lens4: { lens: 4, findings: [] }, lens5: { lens: 5, findings: [] },
    'ac-scope': emptyScope, safety: emptyScope,
    ...patch,
  };
}

// ---- parsePanelOutputs ----

test('suggestions：lens・ac-scope・safety の提案を読み、担当の順に [提案・<担当>] を付けて連結する', () => {
  const v = ok(parsePanelOutputs(outputs({
    lens1: { lens: 1, findings: [], suggestions: ['①の提案'] },
    lens2: { lens: 2, findings: [], suggestions: ['②の提案A', '②の提案B'] },
    lens5: { lens: 5, findings: [], suggestions: ['⑤の提案'] },
    'ac-scope': { ...emptyScope, suggestions: ['⑥の提案'] },
    safety: { ...emptyScope, suggestions: ['⑦の提案'] },
  })));
  assert.deepEqual(v.suggestions, [
    '[提案・lens1] ①の提案',
    '[提案・lens2] ②の提案A',
    '[提案・lens2] ②の提案B',
    '[提案・lens5] ⑤の提案',
    '[提案・ac-scope] ⑥の提案',
    '[提案・safety] ⑦の提案',
  ]);
  assert.deepEqual(v.findings, [], '提案は指摘にならない');
  assert.deepEqual(v.notes, { concerns: [], checkPoints: [] }, '提案は humanNotes に混ざらない');
});

test('suggestions：無くても通り、空になる', () => {
  const v = ok(parsePanelOutputs(outputs()));
  assert.deepEqual(v.suggestions, []);
});

test('suggestions：指摘と提案が両方あっても、指摘の ID と kind は変わらない', () => {
  const v = ok(parsePanelOutputs(outputs({
    lens2: { lens: 2, findings: [{ file: 'a.ts', line: 3, detail: '②の指摘' }], suggestions: ['②の提案'] },
    safety: { findings: [{ kind: 'regression', detail: '⑦の指摘', unfixedPrevious: false }], concerns: [], checkPoints: [], suggestions: ['⑦の提案'] },
  })));
  assert.deepEqual(v.findings.map((f) => [f.id, f.kind]), [['lens2-0', 'bug'], ['safety-0', 'regression']]);
  assert.deepEqual(v.suggestions, ['[提案・lens2] ②の提案', '[提案・safety] ⑦の提案']);
});

test('suggestions：配列でない値・文字列でない要素は拒否する（lens・ac-scope・safety とも）', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['lens の文字列', { lens3: { lens: 3, findings: [], suggestions: '提案' } }],
    ['lens の数', { lens3: { lens: 3, findings: [], suggestions: [1] } }],
    ['lens の null', { lens3: { lens: 3, findings: [], suggestions: null } }],
    ['ac-scope のオブジェクト', { 'ac-scope': { ...emptyScope, suggestions: { a: '提案' } } }],
    ['ac-scope の要素のオブジェクト', { 'ac-scope': { ...emptyScope, suggestions: [{ detail: '提案' }] } }],
    ['safety の文字列', { safety: { ...emptyScope, suggestions: '提案' } }],
    ['safety の要素の null', { safety: { ...emptyScope, suggestions: ['提案', null] } }],
  ];
  for (const [name, patch] of cases) assert.ok(!parsePanelOutputs(outputs(patch)).ok, name);
});

test('suggestions：intake には suggestions を足さない（未知のキーとして拒否する）', () => {
  assert.ok(!parsePanelOutputs(outputs({ intake: { eligible: true, reason: 'r', claudeMd: [], summary: 's', suggestions: [] } })).ok);
});

// ---- composePanel ----

const blockingFinding: PanelFinding = { id: 'lens2-0', source: 'lens2', kind: 'bug', file: 'a.ts', line: 3, detail: '②の指摘' };
const SUGGESTIONS = ['[提案・lens2] 名前を分かりやすくする', '[提案・safety] 失敗時のメッセージを足す'];

test('compose：提案は nonBlocking の末尾にそのまま入り、ブロッキングが無ければ pass は true のまま', () => {
  const v = ok(composePanel({ findings: [], scores: [], check: CHECK_OK, previous: null, changedLines: null, suggestions: SUGGESTIONS }));
  assert.equal(v.review.pass, true);
  assert.deepEqual(v.review.blocking, []);
  assert.deepEqual(v.review.nonBlocking, SUGGESTIONS);
  assert.deepEqual(v.findings, [], '提案は findings に入らない');
});

test('compose：提案は再レビューの nonBlocking の指摘より後に入り、blocking・findings の扱いは変わらない', () => {
  const OLD_HEAD = 'c'.repeat(40);
  const base = {
    findings: [blockingFinding, { ...blockingFinding, id: 'lens3-0', source: 'lens3' as const, file: 'b.ts', line: 9, detail: '③の指摘' }],
    scores: [{ id: 'lens2-0', score: 90, reason: 'r' }, { id: 'lens3-0', score: 90, reason: 'r' }],
    check: CHECK_OK,
    previous: { headSha: OLD_HEAD, blocking: [] },
    changedLines: { 'a.ts': [3] },
  };
  const without = ok(composePanel(base));
  const withS = ok(composePanel({ ...base, suggestions: SUGGESTIONS }));
  assert.equal(withS.review.pass, without.review.pass);
  assert.deepEqual(withS.review.blocking, without.review.blocking);
  assert.deepEqual(withS.review.humanNotes, without.review.humanNotes);
  assert.deepEqual(withS.findings, without.findings);
  assert.ok(without.review.nonBlocking.length > 0, '前提：変わっていない行への指摘が nonBlocking にある');
  assert.deepEqual(withS.review.nonBlocking, [...without.review.nonBlocking, ...SUGGESTIONS]);
});

test('compose：ブロッキングがあれば提案があっても pass は false のまま', () => {
  const v = ok(composePanel({
    findings: [blockingFinding], scores: [{ id: 'lens2-0', score: 90, reason: 'r' }],
    check: CHECK_OK, previous: null, changedLines: null, suggestions: SUGGESTIONS,
  }));
  assert.equal(v.review.pass, false);
  assert.equal(v.review.blocking.length, 1);
  assert.deepEqual(v.review.nonBlocking, SUGGESTIONS);
});

test('compose：suggestions を渡さなければ今までどおり（nonBlocking は空）', () => {
  const v = ok(composePanel({ findings: [], scores: [], check: CHECK_OK, previous: null, changedLines: null }));
  assert.deepEqual(v.review.nonBlocking, []);
});

test('compose：parsePanelOutputs の提案を渡すと、担当の順のまま nonBlocking に入る', () => {
  const parsed = ok(parsePanelOutputs(outputs({
    lens4: { lens: 4, findings: [], suggestions: ['④の提案'] },
    'ac-scope': { ...emptyScope, suggestions: ['⑥の提案'] },
  })));
  const v = ok(composePanel({ findings: parsed.findings, notes: parsed.notes, scores: [], check: CHECK_OK, previous: null, changedLines: null, suggestions: parsed.suggestions }));
  assert.deepEqual(v.review.nonBlocking, ['[提案・lens4] ④の提案', '[提案・ac-scope] ⑥の提案']);
  assert.equal(v.review.pass, true);
});

// ---- 記録 ----

function recordOf(c: PanelComposition): PanelRecord {
  return {
    version: 1, pr: 5, headSha: HEAD, mode: 'shadow',
    review: c.review, findings: c.findings,
    check: { exitCode: 0 },
    material: { pastPrs: 0, pastPrsWithoutComments: 0 },
    cost: { panel: null, reviewer: null },
  };
}

test('記録：提案の入った組み立てを書いて読み戻しても nonBlocking が同じ', () => {
  const withFence = [...SUGGESTIONS, '[提案・lens1] ```agent-verdict を含む提案'];
  const c = ok(composePanel({ findings: [], scores: [], check: CHECK_OK, previous: null, changedLines: null, suggestions: withFence }));
  const back = ok(parsePanelRecord(renderPanelRecord(recordOf(c))));
  assert.deepEqual(back.review.nonBlocking, withFence);
  assert.deepEqual(back.review, c.review);
});
