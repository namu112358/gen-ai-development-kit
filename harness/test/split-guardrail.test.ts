import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlock, renderBlock } from '../lib/blocks.ts';
import type { SplitChild } from '../lib/epic.ts';
import { evaluatePlanGate, type Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config, ctxFor, pr } from './support/gate-fixtures.ts';

// Issue #94：split の計画は、子の files がガードレールに触れても計画ゲートでは止めない（子課題の計画で止まる）

const child = (title: string, files: string[], dependsOn: number[] = []): SplitChild => ({ title, goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files, dependsOn });
const guardedSplit: SplitChild[] = [child('fix(harness): ゲート', ['harness/gates/x.ts']), child('docs: 説明', ['docs/guide/**'], [0])];
const base: Plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/plan.md'] };
const splitPlan: Plan = { ...base, risk: 'critical', files: [], split: guardedSplit };

test('計画ゲート：split の子の files がガードレールに触れても止めない（guardrail は付かない）', () => {
  const r = evaluatePlanGate(splitPlan, 3, config);
  assert.equal(r.pass, true);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.guardrail, undefined);
  assert.equal(r.splitInvalid, undefined);
  const all = evaluatePlanGate({ ...splitPlan, split: [child('ci: a', ['.github/**']), child('chore: b', ['harness.config.json'])] }, 3, config);
  assert.equal(all.pass, true, '全部の子がガードレールに触れても通す');
  assert.equal(all.guardrail, undefined);
});

test('計画ゲート：split の無い計画（子課題の計画を含む）は、ガードレールに触れれば今までどおり止める', () => {
  for (const files of [['harness/gates/x.ts'], ['docs/plan.md', 'harness/lib/**'], ['harness.config.json']]) {
    const r = evaluatePlanGate({ ...base, files }, 3, config);
    assert.equal(r.pass, false, files.join(','));
    assert.ok(r.guardrail && r.guardrail.length > 0, files.join(','));
    assert.match(r.reasons.join('\n'), /ガードレールに触れます/);
  }
  assert.deepEqual(evaluatePlanGate(base, 3, config), { pass: true, reasons: [] }, '触れなければ通す');
});

test('計画ゲート：split の計画自身の files がガードレールに触れれば止める', () => {
  const r = evaluatePlanGate({ ...splitPlan, files: ['harness/lib/**'] }, 3, config);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join('\n'), /ガードレールに触れます.*harness\/lib\/\*\*/);
  assert.deepEqual(r.guardrail, ['harness/lib/**']);
});

test('計画ゲート：split の計画でも、ほかの理由では止める（ガードレールは理由に入れない）', () => {
  const cases: [string, Partial<Plan>, RegExp][] = [
    ['needsHuman', { needsHuman: true, needsHumanReasons: ['x'] }, /人間の判断/],
    ['acChangeProposed', { acChangeProposed: true }, /AC の変更提案/],
    ['openQuestions', { openQuestions: ['q'] }, /未解決の質問/],
    ['issue 番号', { issue: 4 }, /issue 番号/],
  ];
  for (const [name, patch, re] of cases) {
    const r = evaluatePlanGate({ ...splitPlan, ...patch }, 3, config);
    assert.equal(r.pass, false, name);
    assert.equal(r.reasons.length, 1, name);
    assert.match(r.reasons[0]!, re, name);
    assert.equal(r.guardrail, undefined, name);
    assert.equal(r.splitInvalid, undefined, name);
  }
  const overlap = evaluatePlanGate({ ...splitPlan, split: [child('a', ['harness/gates/**']), child('b', ['harness/gates/x.ts'])] }, 3, config);
  assert.equal(overlap.pass, false, 'split の検査');
  assert.equal(overlap.splitInvalid, true);
  assert.equal(overlap.guardrail, undefined);
  assert.ok(overlap.reasons.some((r) => r.includes('重なります')));
  assert.ok(!overlap.reasons.some((r) => r.includes('ガードレール')));
});

// ---- App（onComment）経由 ----

const event = (p: unknown) => ({
  action: 'created',
  issue: { number: 3, labels: [{ name: 'agent:ready' }, { name: 'priority:high' }], state: 'open' },
  comment: { id: 80, body: renderBlock('agent-plan', p), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
});

/** 子 Issue を作れる偽の GitHub（harness/test/gates-epic.test.ts の epicFake を必要な分だけ） */
function epicFake() {
  const comments: unknown[] = [];
  let next = 100;
  return acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => comments)
    .on('POST', /\/issues\/3\/comments$/, (_m, body) => {
      const c = { id: 500 + comments.length, body: body.body, html_url: 'u', created_at: '', updated_at: '', author_association: 'NONE', user: { login: APP, type: 'Bot' } };
      comments.push(c);
      return c;
    })
    .on('GET', /\/issues\/3\/sub_issues/, () => [])
    .on('GET', /\/issues\?state=all&creator=/, () => [])
    .on('POST', /\/repos\/o\/r\/issues$/, (_m, body) => ({ id: 9000 + next, number: next++, body: body.body, labels: [], user: { login: APP } }))
    .on('POST', /\/issues\/3\/sub_issues$/, () => ({}))
    .on('GET', /\/issues\/\d+\/dependencies\/blocked_by/, () => [])
    .on('POST', /\/issues\/\d+\/dependencies\/blocked_by$/, () => ({}));
}

const gateRecord = (fake: ReturnType<typeof epicFake>) => {
  const body = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments')).map((c) => String(c.body.body)).find((b) => b.includes('kind=plan-gate '))!;
  const block = extractBlock(body, 'agent-app');
  return { body, value: block.found && block.ok ? (block.value as any) : null };
};
const createdIssues = (fake: ReturnType<typeof epicFake>) => fake.calls.filter((c) => c.method === 'POST' && /\/repos\/o\/r\/issues$/.test(c.path));

test('計画ゲート（App）：子の files がガードレールに触れる split も通し、子 Issue を作る', async () => {
  const fake = epicFake();
  await onComment(ctxFor(fake, 'issue_comment', event(splitPlan)));
  const w = fake.writes();
  assert.deepEqual(w.slice(0, 3), ['label-agent:plan-ok', 'label+epic', 'comment:plan-gate']);
  assert.ok(!w.includes('label+agent:plan-review'));
  assert.deepEqual(createdIssues(fake).map((c) => c.body.title), guardedSplit.map((c) => c.title));
  assert.ok(w.includes('comment:epic-split'));
  const gate = gateRecord(fake);
  assert.equal(gate.value.pass, true);
  assert.equal(gate.value.guardrail, undefined);
  assert.doesNotMatch(gate.body, /ガードレールに触れます/);
});

test('計画ゲート（App）：子がガードレールに触れる split でも、needsHuman なら needs-decision で止める（子 Issue は作らない）', async () => {
  const fake = epicFake();
  await onComment(ctxFor(fake, 'issue_comment', event({ ...splitPlan, needsHuman: true, needsHumanReasons: ['x'] })));
  assert.ok(fake.writes().includes('label+agent:plan-review'));
  assert.equal(createdIssues(fake).length, 0);
  const gate = gateRecord(fake);
  assert.match(gate.body, /reason code=needs-decision/);
  assert.equal(gate.value.pass, false);
  assert.equal(gate.value.reasons.length, 1);
  assert.equal(gate.value.guardrail, undefined);
});

test('計画ゲート（App）：子がガードレールに触れる split の分け方が不正なら split-invalid で止める', async () => {
  const fake = epicFake();
  await onComment(ctxFor(fake, 'issue_comment', event({ ...splitPlan, split: [child('a', ['harness/gates/**']), child('b', ['harness/gates/x.ts'])] })));
  assert.ok(fake.writes().includes('label+agent:plan-review'));
  assert.equal(createdIssues(fake).length, 0);
  const gate = gateRecord(fake);
  assert.match(gate.body, /reason code=split-invalid/);
  assert.equal(gate.value.guardrail, undefined);
});

test('計画ゲート（App）：split の無い計画はガードレールに触れれば今までどおり high-risk で止める', async () => {
  const fake = epicFake();
  await onComment(ctxFor(fake, 'issue_comment', event({ ...base, files: ['harness/gates/x.ts'] })));
  assert.deepEqual(fake.writes().slice(0, 3), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate']);
  const gate = gateRecord(fake);
  assert.match(gate.body, /reason code=high-risk/);
  assert.match(gate.body, /ガードレールに触れます.*harness\/gates\/x\.ts/);
});
