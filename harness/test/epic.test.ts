import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChildMarker, patternsOverlap, renderChildBody, validateSplit, type SplitChild } from '../lib/epic.ts';
import { parseIssueBody, acceptanceItems } from '../lib/issue-form.ts';
import { evaluatePlanGate, parsePlan, type Plan } from '../lib/plan.ts';
import { decideIssue, type IssueFacts } from '../lib/queue.ts';

/** ガードレールを問わないテスト用（一覧自身だけが当たる） */
const noGuardrail = { guardrailPaths: [] };

const child = (patch: Partial<SplitChild> = {}): SplitChild => ({
  title: 'feat(x): 子', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['src/a.ts'], dependsOn: [], ...patch,
});
const split = [child({ title: 'feat(x): 一つ目', files: ['src/a.ts', 'test/a.test.ts'] }), child({ title: 'docs: 二つ目', files: ['docs/**'], dependsOn: [0] })];
const plan: Plan = { version: 1, issue: 7, risk: 'critical', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [], split };

test('split の書式：型が違えば読めない、dependsOn は省略できる', () => {
  const raw = JSON.parse(JSON.stringify(plan));
  delete raw.split[0].dependsOn;
  const ok = parsePlan(raw);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.value.split?.[0]?.dependsOn, []);
  const bad = parsePlan({ ...raw, split: [{ title: 1, goal: '', requirements: 'r', acceptanceCriteria: [], files: [], dependsOn: ['0'] }] });
  assert.equal(bad.ok, false);
  const errors = bad.ok ? [] : bad.errors;
  for (const needle of ['split[0].title', 'split[0].goal', 'split[0].requirements', 'split[0].dependsOn[0]']) {
    assert.ok(errors.some((e) => e.includes(needle)), `${needle}: ${errors.join('/')}`);
  }
  assert.equal(parsePlan({ ...raw, split: {} }).ok, false);
});

test('split の検査：件数・タイトル・空の項目・ファイルの規則・依存', () => {
  assert.deepEqual(validateSplit(split), []);
  const cases: [SplitChild[], string][] = [
    [[split[0]!], '2件以上'],
    [[split[0]!, child({ title: 'Add docs', files: ['docs/x.md'] })], 'split[1].title'],
    [[split[0]!, child({ title: 'wip: x', files: ['docs/x.md'] })], 'type'],
    [[split[0]!, child({ requirements: [], files: ['docs/x.md'] })], 'requirements が空'],
    [[split[0]!, child({ acceptanceCriteria: [' '], files: ['docs/x.md'] })], 'acceptanceCriteria が空'],
    [[split[0]!, child({ files: [] })], 'files が空'],
    [[split[0]!, child({ files: ['**'] })], '広すぎ'],
    [[split[0]!, child({ files: ['docs/x.md'], dependsOn: [1] })], 'dependsOn の 1'],
    [[child({ dependsOn: [1] }), child({ files: ['docs/x.md'] })], 'dependsOn の 1'],
    [[split[0]!, child({ files: ['docs/x.md'], dependsOn: [-1] })], 'dependsOn の -1'],
    [[split[0]!, child({ files: ['docs/x.md'], dependsOn: [0, 0] })], '重複'],
  ];
  for (const [s, needle] of cases) {
    const reasons = validateSplit(s);
    assert.ok(reasons.some((r) => r.includes(needle)), `${needle}: ${reasons.join('/')}`);
  }
});

test('兄弟のファイルの重なり：同じパス、片方のパターンがもう片方に一致する、またはパターンどうしの固定部分の先頭が一致する', () => {
  assert.ok(patternsOverlap('src/a.ts', 'src/a.ts'));
  assert.ok(patternsOverlap('src/**', 'src/lib/a.ts'));
  assert.ok(patternsOverlap('src/lib/a.ts', 'src/*/a.ts'), '順序によらない');
  assert.ok(patternsOverlap('src/**', 'src/lib/*.ts'), 'パターンどうしでも、片方がもう片方に一致すれば重なる');
  assert.equal(patternsOverlap('src/a.ts', 'src/b.ts'), false);
  assert.equal(patternsOverlap('src/*.ts', 'src/lib/a.ts'), false, '* は1階層');
  assert.ok(patternsOverlap('src/**/a.ts', 'src/x/**'), 'パターンどうしは固定部分の先頭が一致すれば重なるとみなす');
  assert.ok(patternsOverlap('src/*.ts', 'src/a*'));
  assert.ok(patternsOverlap('src/x/*.ts', 'src/*'), '順序によらない');
  assert.equal(patternsOverlap('docs/**', 'harness/**'), false);
  assert.equal(patternsOverlap('src/a/**', 'src/b/*.ts'), false);
  assert.equal(patternsOverlap('src/x/**', 'src/a.ts'), false, '片方がパスなら一致だけで判断する');
  const reasons = validateSplit([child({ files: ['src/a.ts'] }), child({ files: ['docs/x.md'] }), child({ files: ['src/**'] })]);
  assert.deepEqual(reasons, ['split[0] と split[2] の files が重なります（「src/a.ts」と「src/**」）']);
});

test('計画ゲート：split の計画は Risk と空の files では止めず、分け方の検査で止める', () => {
  assert.deepEqual(evaluatePlanGate(plan, 7, noGuardrail), { pass: true, reasons: [] }, 'critical でも files が空でも通る');
  const overlap = evaluatePlanGate({ ...plan, split: [split[0]!, child({ files: ['src/**'] })] }, 7, noGuardrail);
  assert.equal(overlap.pass, false);
  assert.equal(overlap.splitInvalid, true);
  const human = evaluatePlanGate({ ...plan, needsHuman: true, openQuestions: ['?'] }, 7, noGuardrail);
  assert.equal(human.pass, false, '人の判断・未解決の質問は通常どおり止める');
  assert.equal(human.splitInvalid, undefined);
  assert.equal(evaluatePlanGate({ ...plan, issue: 8 }, 7, noGuardrail).pass, false);
  assert.equal(evaluatePlanGate({ ...plan, files: ['../x'] }, 7, noGuardrail).pass, false, 'files があれば規則は検査する');
  assert.equal(evaluatePlanGate({ ...plan, split: undefined }, 7, noGuardrail).pass, false, 'split が無ければ従来どおり');
});

test('子 Issue の本文：Issue Form の見出しで読め、目印を持つ', () => {
  const body = renderChildBody(12, 1, split, [13]);
  const parsed = parseIssueBody(body);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.contract.goal, 'g');
  assert.match(parsed.contract.background, /Epic #12 の子課題（2\/2）/);
  assert.match(parsed.contract.background, /`docs\/\*\*`/);
  assert.equal(parsed.contract.requirements, '- r');
  assert.deepEqual(acceptanceItems(parsed.contract), ['a']);
  assert.match(parsed.contract.dependencies, /#13 の後/);
  assert.deepEqual(parseChildMarker(body), { parent: 12, index: 1 });
  assert.ok(parseIssueBody(renderChildBody(12, 0, split, [])).ok, '依存なし');
  assert.equal(parseChildMarker('本文'), null);
});

test('queue：epic の Issue は計画・実装の対象にしない', () => {
  const opts = { currentSession: null, now: new Date('2026-09-26T12:00:00Z'), routineClaimTakeoverMinutes: 90, humanClaimStaleHours: 6 };
  const facts: IssueFacts = {
    number: 1, title: 't', labels: ['agent:ready', 'epic'], readyAt: null, claim: null, openBlockers: [],
    gate: { pass: true, planCommentId: 5, at: '2026-09-26T01:00:00Z' }, latestPlanAt: '2026-09-26T02:00:00Z', planOkByApp: false, openPr: null,
  };
  assert.deepEqual(decideIssue(facts, opts), { kind: 'skip', target: '#1', reason: 'Epic（子課題で進める）' }, '計画待ちより先に飛ばす');
  assert.equal(decideIssue({ ...facts, gate: null, latestPlanAt: null }, opts).kind, 'skip', '計画前でも飛ばす');
  assert.equal(decideIssue({ ...facts, labels: ['agent:ready'], gate: null, latestPlanAt: null }, opts).kind, 'plan');
});
