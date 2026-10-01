// 計画の任意の手順（steps）の書式検査を確かめる：file が files に当たる・change が要る・件数と長さの上限・split とは併せない、
// steps の無い計画は今までどおり通る（Issue #470）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan, type Plan } from '../lib/plan.ts';

const base: Plan = { version: 1, issue: 470, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['harness/lib/plan.ts', 'harness/test/**'] };

const step = (patch: Record<string, unknown> = {}) => ({ file: 'harness/lib/plan.ts', change: 'parsePlan で steps を読む', ...patch });

const withSteps = (steps: unknown, patch: Record<string, unknown> = {}) => parsePlan({ ...base, ...patch, steps });

test('parsePlan：steps の無い計画は今までどおり通り、steps の欄が無い', () => {
  const r = parsePlan(base);
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' / '));
  assert.ok(!('steps' in r.value), 'steps の無い計画に steps の欄がある');
});

test('parsePlan：steps を読む（file は files と同じ文字列か glob に当たる、任意の欄は書いたものだけ）', () => {
  const full = step({ symbols: 'parsePlan', follow: 'parseAuthorView に倣う', edgeCases: '0件', dontTouch: 'evaluatePlanGate' });
  const minimal = step({ file: 'harness/test/plan-steps.test.ts', change: 'テストを足す' });
  const r = withSteps([full, minimal]);
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' / '));
  const steps = (r.value as Plan & { steps?: Record<string, unknown>[] }).steps;
  assert.deepEqual(steps, [full, minimal]);
  for (const key of ['symbols', 'follow', 'edgeCases', 'dontTouch']) {
    assert.ok(!(key in steps![1]!), `書いていない ${key} の欄がある`);
  }
});

test('parsePlan：steps の上限ちょうど（50 件・各欄 2000 文字）は通る', () => {
  const long = 'あ'.repeat(2000);
  const cases: [string, unknown][] = [
    ['50 件', Array.from({ length: 50 }, () => step())],
    ['2000 文字', [step({ change: long, symbols: long, follow: long, edgeCases: long, dontTouch: long })]],
  ];
  for (const [name, steps] of cases) {
    const r = withSteps(steps);
    assert.ok(r.ok, `${name}: ${r.ok ? '' : r.errors.join(' / ')}`);
  }
});

test('parsePlan：steps の書式の誤りは plan.steps の誤りになる', () => {
  const over = 'あ'.repeat(2001);
  const cases: [string, unknown, Record<string, unknown>?][] = [
    ['配列でない', { file: 'harness/lib/plan.ts', change: 'x' }],
    ['0 件', []],
    ['51 件', Array.from({ length: 51 }, () => step())],
    ['件がオブジェクトでない', ['harness/lib/plan.ts']],
    ['件が null', [null]],
    ['file が無い', [{ change: 'x' }]],
    ['change が無い', [{ file: 'harness/lib/plan.ts' }]],
    ['change が空', [step({ change: '' })]],
    ['change が空白だけ', [step({ change: '  \n' })]],
    ['change が文字列でない', [step({ change: 1 })]],
    ['file が空', [step({ file: '' })]],
    ['file が files に無い', [step({ file: 'harness/lib/scope.ts' })]],
    ['file が glob の外', [step({ file: 'harness/tests/a.ts' })]],
    ['change が 2001 文字', [step({ change: over })]],
    ['file が 2001 文字', [step({ file: `harness/test/${'a'.repeat(1990)}` })]],
    ...(['symbols', 'follow', 'edgeCases', 'dontTouch'] as const).flatMap((key): [string, unknown][] => [
      [`${key} が空`, [step({ [key]: '' })]],
      [`${key} が空白だけ`, [step({ [key]: '   ' })]],
      [`${key} が文字列でない`, [step({ [key]: 1 })]],
      [`${key} が 2001 文字`, [step({ [key]: over })]],
    ]),
    ['split の計画に steps', [step()], {
      split: [
        { title: 'feat(x): 一つ目', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['harness/lib/plan.ts'], dependsOn: [] },
        { title: 'docs: 二つ目', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['docs/**'], dependsOn: [0] },
      ],
    }],
  ];
  for (const [name, steps, patch] of cases) {
    const r = withSteps(steps, patch);
    assert.equal(r.ok, false, name);
    const errors = r.ok ? [] : r.errors;
    assert.ok(errors.some((e) => e.includes('plan.steps')), `${name}: ${errors.join(' / ')}`);
  }
});
