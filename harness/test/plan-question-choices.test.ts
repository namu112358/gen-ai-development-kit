// 計画の質問（openQuestions）の任意の選択肢を確かめる：文字列だけ・選択肢つき・混在の質問が書式の検査を通り、
// openQuestionChoices が同じ並びになる。選択肢つきでも計画ゲートは今までどおり止める。選択肢の形の誤り（件数・空・型・重複）は
// plan.openQuestions[i] の誤りで止まる（Issue #818）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUESTION_CHOICES_MAX, QUESTION_CHOICES_MIN, evaluatePlanGate, parsePlan, type Plan } from '../lib/plan.ts';

type WithChoices = Plan & { openQuestionChoices?: string[][] };

const noGuardrail = { guardrailPaths: [] };

const base: Plan = { version: 1, issue: 818, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['harness/lib/plan.ts', 'harness/test/**'] };

const withQuestions = (openQuestions: unknown) => parsePlan({ ...base, openQuestions });

const choices = (n: number) => Array.from({ length: n }, (_, i) => `案${i + 1}`);

test('選択肢の件数の上下限は 2〜4', () => {
  assert.equal(QUESTION_CHOICES_MIN, 2);
  assert.equal(QUESTION_CHOICES_MAX, 4);
});

test('parsePlan：文字列だけ・選択肢つきだけ・混在の質問を読み、openQuestions は文、openQuestionChoices は同じ並び（選択肢の無い質問は []）', () => {
  const cases: [string, unknown[], string[], string[][] | undefined][] = [
    ['文字列だけ', ['A にするか', 'B にするか'], ['A にするか', 'B にするか'], undefined],
    [
      '選択肢つきだけ',
      [{ text: 'どちらにするか', choices: ['A（おすすめ）', 'B'] }, { text: '期限は', choices: ['今週', '来週', '未定'] }],
      ['どちらにするか', '期限は'],
      [['A（おすすめ）', 'B'], ['今週', '来週', '未定']],
    ],
    [
      '混在',
      ['自由に答える質問', { text: 'どちらにするか', choices: ['A', 'B'] }, '最後の質問'],
      ['自由に答える質問', 'どちらにするか', '最後の質問'],
      [[], ['A', 'B'], []],
    ],
    ['オブジェクトの未知のキーは読まない', [{ text: '質問', choices: ['A', 'B'], note: 'x' }], ['質問'], [['A', 'B']]],
  ];
  for (const [name, raw, questions, expectedChoices] of cases) {
    const r = withQuestions(raw);
    assert.ok(r.ok, `${name}: ${r.ok ? '' : r.errors.join(' / ')}`);
    const value = r.value as WithChoices;
    assert.deepEqual(value.openQuestions, questions, name);
    if (expectedChoices === undefined) {
      assert.ok(!('openQuestionChoices' in value), `${name}: 選択肢の無い計画に openQuestionChoices の欄がある`);
    } else {
      assert.deepEqual(value.openQuestionChoices, expectedChoices, name);
    }
  }
});

test('parsePlan：空の openQuestions の計画に openQuestionChoices の欄が無い', () => {
  const r = withQuestions([]);
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' / '));
  assert.deepEqual(r.value.openQuestions, []);
  assert.ok(!('openQuestionChoices' in r.value), '空の openQuestions の計画に openQuestionChoices の欄がある');
});

test('parsePlan：選択肢の上下限ちょうど（2 個・4 個）と、前後の空白だけが違う選択肢は通る', () => {
  const cases: [string, string[]][] = [
    ['下限ちょうど', choices(QUESTION_CHOICES_MIN)],
    ['上限ちょうど', choices(QUESTION_CHOICES_MAX)],
    ['前後の空白だけが違う（そのままの文字列で比べる）', ['A', ' A']],
  ];
  for (const [name, list] of cases) {
    const r = withQuestions([{ text: '質問', choices: list }]);
    assert.ok(r.ok, `${name}: ${r.ok ? '' : r.errors.join(' / ')}`);
    assert.deepEqual((r.value as WithChoices).openQuestionChoices, [list], name);
  }
});

test('evaluatePlanGate：選択肢つきの質問も未解決の質問として数え、ゲートを止める', () => {
  const r = withQuestions(['自由に答える質問', { text: 'どちらにするか', choices: ['A', 'B'] }, { text: '期限は', choices: ['今週', '来週'] }]);
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' / '));
  const gate = evaluatePlanGate(r.value, 818, noGuardrail);
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.includes('未解決の質問が 3 件あります'), gate.reasons.join(' / '));

  const onlyChoices = withQuestions([{ text: 'どちらにするか', choices: ['A', 'B'] }]);
  assert.ok(onlyChoices.ok, onlyChoices.ok ? '' : onlyChoices.errors.join(' / '));
  const gate2 = evaluatePlanGate(onlyChoices.value, 818, noGuardrail);
  assert.equal(gate2.pass, false);
  assert.ok(gate2.reasons.includes('未解決の質問が 1 件あります'), gate2.reasons.join(' / '));
});

test('parsePlan：質問の形の誤りは plan.openQuestions[i] の誤りで止まる', () => {
  // 誤りの項目は 2 番目（添字 1）に置き、添字つきのパスで止まることを確かめる
  const cases: [string, unknown, string][] = [
    ['text が無い', { choices: ['A', 'B'] }, 'plan.openQuestions[1]'],
    ['text が空', { text: '', choices: ['A', 'B'] }, 'plan.openQuestions[1]'],
    ['text が空白だけ', { text: '  ', choices: ['A', 'B'] }, 'plan.openQuestions[1]'],
    ['text が文字列でない', { text: 1, choices: ['A', 'B'] }, 'plan.openQuestions[1]'],
    ['choices が無い', { text: '質問' }, 'plan.openQuestions[1].choices'],
    ['choices が配列でない', { text: '質問', choices: 'A,B' }, 'plan.openQuestions[1].choices'],
    ['choices が 1 個', { text: '質問', choices: choices(QUESTION_CHOICES_MIN - 1) }, 'plan.openQuestions[1].choices'],
    ['choices が 5 個', { text: '質問', choices: choices(QUESTION_CHOICES_MAX + 1) }, 'plan.openQuestions[1].choices'],
    ['choices が空配列', { text: '質問', choices: [] }, 'plan.openQuestions[1].choices'],
    ['choices に空文字', { text: '質問', choices: ['A', ''] }, 'plan.openQuestions[1].choices'],
    ['choices に空白だけ', { text: '質問', choices: ['A', '   '] }, 'plan.openQuestions[1].choices'],
    ['choices に数値', { text: '質問', choices: ['A', 2] }, 'plan.openQuestions[1].choices'],
    ['choices に null', { text: '質問', choices: ['A', null] }, 'plan.openQuestions[1].choices'],
    ['choices が重複', { text: '質問', choices: ['A', 'B', 'A'] }, 'plan.openQuestions[1].choices'],
    ['項目が数値', 1, 'plan.openQuestions[1]'],
    ['項目が null', null, 'plan.openQuestions[1]'],
    ['項目が配列', ['A', 'B'], 'plan.openQuestions[1]'],
    ['項目が真偽値', true, 'plan.openQuestions[1]'],
  ];
  for (const [name, item, path] of cases) {
    const r = withQuestions(['正しい質問', item]);
    assert.equal(r.ok, false, name);
    const errors = r.ok ? [] : r.errors;
    assert.ok(errors.some((e) => e.startsWith(path)), `${name}: ${errors.join(' / ')}`);
  }
});

test('parsePlan：文字列でもオブジェクトでもない項目は決まった文で止まる', () => {
  for (const item of [1, null, true]) {
    const r = withQuestions([item]);
    assert.equal(r.ok, false, String(item));
    const errors = r.ok ? [] : r.errors;
    assert.ok(errors.includes('plan.openQuestions[0]: 文字列か、text と choices のオブジェクトではありません'), `${String(item)}: ${errors.join(' / ')}`);
  }
});

test('parsePlan：openQuestions が配列でなければ今までどおり止まる', () => {
  const r = withQuestions({ text: '質問', choices: ['A', 'B'] });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.includes('plan.openQuestions: 配列ではありません'), r.ok ? '' : r.errors.join(' / '));
});
