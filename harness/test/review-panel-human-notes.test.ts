// 合体版のレビューで ac-scope の出力の acNotes が parsePanelOutputs → composePanel → 記録の読み込みで review.humanNotes.acNotes に引き継がれ、無ければ鍵が無く、有無で pass・blocking が変わらないことを確かめる（Issue #972）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composePanel, parsePanelOutputs, parsePanelRecord, renderPanelRecord, type PanelRecord } from '../lib/review-panel.ts';
import { HEAD } from './support/gate-fixtures.ts';

const AC_NOTES = ['AC1：acNotes を読む → 満たす', 'AC2：未知の鍵を拒む → 満たす'];

function ok<T>(r: { ok: true; value: T } | { ok: false; errors: string[] }): T {
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.value;
}

/** 担当の出力（ac-scope にブロッキングになる指摘1つ。acNotes は渡したときだけ）から組み立て、記録に書いて読み戻す */
function run(acNotes?: string[]) {
  const acScope: Record<string, unknown> = { findings: [{ kind: 'ac-unmet', file: 'a.ts', detail: 'AC2 を確かめるテストが無い', unfixedPrevious: false }], concerns: [], checkPoints: [] };
  if (acNotes) acScope.acNotes = acNotes;
  const parsed = ok(parsePanelOutputs({
    intake: { eligible: true, reason: '対象', claudeMd: [], summary: '要約' },
    lens1: { lens: 1, findings: [] }, lens2: { lens: 2, findings: [] }, lens3: { lens: 3, findings: [] }, lens4: { lens: 4, findings: [] }, lens5: { lens: 5, findings: [] },
    'ac-scope': acScope, safety: { findings: [], concerns: [], checkPoints: [] }, overbuild: { findings: [] },
  }));
  const composed = ok(composePanel({
    findings: parsed.findings, notes: parsed.notes, suggestions: parsed.suggestions, overbuildMissing: parsed.overbuildMissing,
    scores: parsed.findings.map((f) => ({ id: f.id, score: 90, reason: '理由' })),
    check: { headSha: HEAD, exitCode: 0, outputTail: '' }, previous: null, changedLines: null,
  }));
  const record: PanelRecord = {
    version: 1, pr: 5, headSha: HEAD, mode: 'shadow', review: composed.review, findings: composed.findings,
    check: { exitCode: 0 }, material: { pastPrs: 0, pastPrsWithoutComments: 0 }, cost: { panel: null, reviewer: null },
  };
  return { composed, back: ok(parsePanelRecord(renderPanelRecord(record))) };
}

test('合体版：ac-scope の acNotes は composePanel と記録の読み込みで review.humanNotes.acNotes に入り、無ければ鍵が無く、有無で pass・blocking は変わらない', () => {
  const withAc = run(AC_NOTES);
  assert.deepEqual(withAc.composed.review.humanNotes.acNotes, AC_NOTES);
  assert.deepEqual(withAc.back.review.humanNotes.acNotes, AC_NOTES);

  const without = run();
  assert.ok(!('acNotes' in without.composed.review.humanNotes), 'composePanel の humanNotes に acNotes の鍵がある');
  assert.ok(!('acNotes' in without.back.review.humanNotes), '記録の humanNotes に acNotes の鍵がある');

  assert.equal(withAc.composed.review.pass, false);
  assert.deepEqual(
    { pass: withAc.back.review.pass, blocking: withAc.back.review.blocking },
    { pass: without.back.review.pass, blocking: without.back.review.blocking },
  );
});
