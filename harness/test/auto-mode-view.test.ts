// 計画・判定の見解（authorView）の読み取りと、auto mode の危険の問いの見解あり・なしの要求（author_view・criteria の注意書き）、
// Jev に渡す計画の本文から見解を除く planBodyWithoutView を確かめる（Issue #426）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_VIEW_NOTE, autoModeConfig, autoModePlanJevRequest, autoModePrJevRequest, planBodyWithoutView } from '../lib/auto-mode.ts';
import { extractBlock, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import { parsePlan, type Plan } from '../lib/plan.ts';
import { parseVerdict } from '../lib/verdict.ts';
import { DIFF, config, verdict } from './support/gate-fixtures.ts';

const VIEW = 'この計画はテストを足すだけで、安全装置は変えません。';

const planOf = (patch: Partial<Plan> = {}): Plan => ({
  version: 1, issue: 426, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['harness/lib/epic.ts'], critique: { verdict: 'go', rounds: 1 }, ...patch,
});

const planBody = (plan: Plan) => `計画です。\n\n${renderBlock('agent-plan', plan)}\n\n以上。`;

// ---- parsePlan・parseVerdict が authorView を読む ----

test('parsePlan：authorView があれば plan.authorView に読み、無ければ欄が無い', () => {
  const withView = parsePlan({ ...planOf(), authorView: VIEW });
  assert.ok(withView.ok, withView.ok ? '' : withView.errors.join(' / '));
  assert.equal(withView.value.authorView, VIEW);
  const without = parsePlan(planOf());
  assert.ok(without.ok);
  assert.ok(!('authorView' in without.value), '見解の無い計画に authorView の欄がある');
});

test('parsePlan：authorView が空（trim して空）・2001 文字・文字列でないなら誤り、2000 文字ちょうどは通る', () => {
  for (const [name, view] of [['空', ''], ['空白だけ', '   \n'], ['2001 文字', 'あ'.repeat(2001)], ['数', 1]] as [string, unknown][]) {
    assert.equal(parsePlan({ ...planOf(), authorView: view }).ok, false, name);
  }
  const max = parsePlan({ ...planOf(), authorView: 'あ'.repeat(2000) });
  assert.ok(max.ok, '2000 文字は通る');
});

test('parseVerdict：authorView があれば verdict.authorView に読み、無ければ欄が無い', () => {
  const withView = parseVerdict({ ...verdict(), authorView: VIEW });
  assert.ok(withView.ok, withView.ok ? '' : withView.errors.join(' / '));
  assert.equal(withView.value.authorView, VIEW);
  const without = parseVerdict(verdict());
  assert.ok(without.ok);
  assert.ok(!('authorView' in without.value), '見解の無い判定に authorView の欄がある');
});

test('parseVerdict：authorView が空（trim して空）・2001 文字なら誤り、2000 文字ちょうどは通る', () => {
  for (const [name, view] of [['空', ''], ['空白だけ', '  '], ['2001 文字', 'x'.repeat(2001)]] as [string, unknown][]) {
    assert.equal(parseVerdict({ ...verdict(), authorView: view }).ok, false, name);
  }
  assert.ok(parseVerdict({ ...verdict(), authorView: 'x'.repeat(2000) }).ok, '2000 文字は通る');
});

// ---- 危険の問いの要求 ----

test('AUTO_MODE_JEV_VIEW_NOTE は author_view を根拠にしない旨の英文で、author_view を含む', () => {
  assert.equal(typeof AUTO_MODE_JEV_VIEW_NOTE, 'string');
  assert.ok(AUTO_MODE_JEV_VIEW_NOTE.trim().length > 0);
  assert.ok(AUTO_MODE_JEV_VIEW_NOTE.includes('author_view'), AUTO_MODE_JEV_VIEW_NOTE);
});

test('計画の要求：見解が無ければ今までと同じ形（state は plan と files だけで author_view が無い）', () => {
  const q = autoModeConfig(config).plan;
  const body = planBody(planOf());
  const request = autoModePlanJevRequest(config, body, ['a.ts']);
  assert.deepEqual(request, {
    model: config.jev.model,
    state: { plan: body, files: ['a.ts'] },
    questions: { danger: { type: 'noul', instructions: q.instructions, criteria: { true: q.criteria.true, false: q.criteria.false } } },
  });
  assert.ok(!('author_view' in request.state));
});

test('計画の要求：見解があれば state に author_view が入り、instructions と criteria の true・false の末尾に注意書きが足される', () => {
  const q = autoModeConfig(config).plan;
  const body = planBody(planOf());
  const request = autoModePlanJevRequest(config, body, ['a.ts'], VIEW);
  const state = request.state as Record<string, unknown>;
  assert.equal(state.author_view, VIEW);
  assert.equal(state.plan, body);
  assert.deepEqual(state.files, ['a.ts']);
  const danger = request.questions.danger;
  assert.equal(danger.type, 'noul');
  assert.equal(danger.instructions, `${q.instructions} ${AUTO_MODE_JEV_VIEW_NOTE}`);
  assert.equal(danger.criteria.true, `${q.criteria.true} ${AUTO_MODE_JEV_VIEW_NOTE}`);
  assert.equal(danger.criteria.false, `${q.criteria.false} ${AUTO_MODE_JEV_VIEW_NOTE}`);
});

test('計画の要求：見解ありの要求を作っても、設定の問い（既定）を書き換えない', () => {
  const before = structuredClone(autoModeConfig(config).plan);
  autoModePlanJevRequest(config, 'b', [], VIEW);
  assert.deepEqual(autoModeConfig(config).plan, before);
  assert.ok(!autoModePlanJevRequest(config, 'b', []).questions.danger.instructions.includes(AUTO_MODE_JEV_VIEW_NOTE));
});

test('PR の要求：見解が無ければ今までと同じ形（state は diff と changed_files だけで author_view が無い）', () => {
  const q = autoModeConfig(config).pr;
  const built = autoModePrJevRequest(config, DIFF, ['docs/a.md']);
  assert.deepEqual(built, {
    ask: true,
    request: {
      model: config.jev.model,
      state: { diff: DIFF, changed_files: ['docs/a.md'] },
      questions: { danger: { type: 'noul', instructions: q.instructions, criteria: { true: q.criteria.true, false: q.criteria.false } } },
    },
  });
});

test('PR の要求：見解があれば state に author_view が入り、instructions と criteria の true・false の末尾に注意書きが足される', () => {
  const q = autoModeConfig(config).pr;
  const built = autoModePrJevRequest(config, DIFF, ['docs/a.md'], VIEW);
  assert.ok(built.ask);
  const state = built.request.state as Record<string, unknown>;
  assert.equal(state.author_view, VIEW);
  assert.equal(state.diff, DIFF);
  assert.deepEqual(state.changed_files, ['docs/a.md']);
  const danger = built.request.questions.danger;
  assert.equal(danger.instructions, `${q.instructions} ${AUTO_MODE_JEV_VIEW_NOTE}`);
  assert.equal(danger.criteria.true, `${q.criteria.true} ${AUTO_MODE_JEV_VIEW_NOTE}`);
  assert.equal(danger.criteria.false, `${q.criteria.false} ${AUTO_MODE_JEV_VIEW_NOTE}`);
});

test('PR の要求：diff が大きすぎれば、見解があっても問わずに skipped の記録を返す', () => {
  const small: HarnessConfig = { ...config, jev: { ...config.jev, maxDiffChars: 10 } };
  const built = autoModePrJevRequest(small, DIFF, ['docs/a.md'], VIEW);
  assert.equal(built.ask, false);
  if (!built.ask) assert.equal(built.record.status, 'skipped');
});

// ---- planBodyWithoutView ----

test('planBodyWithoutView：agent-plan の authorView だけを除き、ほかの欄と本文の前後は残す', () => {
  const plan = planOf();
  const body = planBody({ ...plan, authorView: VIEW });
  const out = planBodyWithoutView(body);
  assert.ok(!out.includes('authorView'), out);
  assert.ok(!out.includes(VIEW), '見解の文が残っている');
  assert.ok(out.startsWith('計画です。'), '前の本文が消えた');
  assert.ok(out.trimEnd().endsWith('以上。'), '後ろの本文が消えた');
  const block = extractBlock(out, 'agent-plan');
  assert.ok(block.found && block.ok, '書き直した agent-plan を読めない');
  assert.deepEqual(block.value, plan);
});

test('planBodyWithoutView：authorView が無い・ブロックが無い・読めないときは同じ文字列を返す', () => {
  const cases: [string, string][] = [
    ['authorView が無い', planBody(planOf())],
    ['ブロックが無い', '計画です。ブロックはありません。'],
    ['読めない', '計画です。\n\n```agent-plan\n{ "authorView": "x", \n```\n'],
  ];
  for (const [name, body] of cases) assert.equal(planBodyWithoutView(body), body, name);
});
