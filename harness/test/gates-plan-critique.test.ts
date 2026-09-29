// Issue #204：批評を飛ばした計画を計画ゲートで止める（critique が無い／計画より前に段階 plan-critique の着手宣言が無い計画は
// agent:plan-review で止め、理由コード no-critique。go と、人が進めると決めた revise は通し、revise は記録に残す。split の計画も同じ）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractBlock, renderBlock } from '../lib/blocks.ts';
import type { SplitChild } from '../lib/epic.ts';
import { critiqueClaimedBefore } from '../lib/facts.ts';
import type { IssueComment } from '../lib/github.ts';
import { evaluateCritiqueGate, expectedPlanGate, type Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, claimComment, config, CRITIQUE, critiqueClaim, ctxFor, pr, type FakeGitHub } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');
const PLAN_ID = 80;

/** ガードレールに触れず、批評を通していれば通る計画 */
const passPlan: Plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'], critique: CRITIQUE };
const { critique: _omit, ...noCritiquePlan } = passPlan;

function planEvent(plan: unknown, labels: string[] = ['agent:ready'], id = PLAN_ID) {
  return {
    action: 'created',
    issue: { number: 3, labels: labels.map((name) => ({ name })), state: 'open' },
    comment: { id, body: renderBlock('agent-plan', plan), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
  };
}

/**
 * Issue #3 のコメントと events を持ち、App の投稿・ラベルの付け外しを反映する偽の GitHub
 * （続けて別の計画を渡すと、その前の記録と印を読む）
 */
function worldFake(initial: unknown[]) {
  const comments: unknown[] = [...initial];
  const events: unknown[] = [];
  const fake = acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => comments)
    .on('GET', /\/issues\/3\/events/, () => events)
    .on('POST', /\/issues\/3\/comments$/, (_m, body) => {
      const c = { id: 500 + comments.length, body: String(body.body), html_url: 'u', created_at: '', updated_at: '', author_association: 'NONE', user: { login: APP, type: 'Bot' } };
      comments.push(c);
      return c;
    })
    .on('POST', /\/issues\/3\/labels$/, (_m, body) => {
      for (const name of body.labels as string[]) events.push({ event: 'labeled', created_at: '2026-09-26T00:00:00Z', label: { name }, actor: { login: APP } });
      return [];
    });
  return { fake, comments };
}

const gatePosts = (fake: FakeGitHub) =>
  fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments')).map((c) => String(c.body.body)).filter((b) => b.includes('kind=plan-gate '));

/** 最後に投稿した plan-gate の本文と記録 */
function gateRecord(fake: FakeGitHub): { body: string; value: Record<string, any> } {
  const body = gatePosts(fake).at(-1);
  assert.ok(body, 'plan-gate の記録を投稿する');
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok, '記録の agent-app ブロックを読める');
  return { body, value: block.value as Record<string, any> };
}

async function runPlan(plan: unknown, comments: unknown[], labels?: string[]) {
  const { fake } = worldFake(comments);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(plan, labels)));
  return fake;
}

const CRITIQUE_REASON = /批評（plan-critic）の記録（`critique`）がありません/;
const CLAIM_REASON = /計画より前に段階 `plan-critique` の着手宣言がありません/;

// ---- 純粋関数 ----

test('evaluateCritiqueGate：critique が無ければ理由、宣言が無ければ理由（両方なら2つ）', () => {
  assert.deepEqual(evaluateCritiqueGate(passPlan, true), { reasons: [] });
  const noCritique = evaluateCritiqueGate(noCritiquePlan as Plan, true);
  assert.equal(noCritique.reasons.length, 1);
  assert.match(noCritique.reasons[0]!, CRITIQUE_REASON);
  const noClaim = evaluateCritiqueGate(passPlan, false);
  assert.equal(noClaim.reasons.length, 1);
  assert.match(noClaim.reasons[0]!, CLAIM_REASON);
  const both = evaluateCritiqueGate(noCritiquePlan as Plan, false);
  assert.equal(both.reasons.length, 2);
  assert.equal(both.proceeded, undefined);
});

test('evaluateCritiqueGate：null なら宣言を見ない（critique だけ確かめる）', () => {
  assert.deepEqual(evaluateCritiqueGate(passPlan, null), { reasons: [] });
  const r = evaluateCritiqueGate(noCritiquePlan as Plan, null);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0]!, CRITIQUE_REASON);
});

test('evaluateCritiqueGate：verdict の値では止めない。revise で mustRemaining が1以上なら proceeded', () => {
  for (const verdict of ['go', 'revise', 'split'] as const) {
    assert.deepEqual(evaluateCritiqueGate({ ...passPlan, critique: { verdict, rounds: 2 } }, true).reasons, [], verdict);
  }
  assert.deepEqual(evaluateCritiqueGate({ ...passPlan, critique: { verdict: 'revise', rounds: 3, mustRemaining: 2 } }, true), { reasons: [], proceeded: { verdict: 'revise', mustRemaining: 2 } });
  assert.equal(evaluateCritiqueGate({ ...passPlan, critique: { verdict: 'revise', rounds: 1, mustRemaining: 0 } }, true).proceeded, undefined, 'mustRemaining 0 は記録しない');
  assert.equal(evaluateCritiqueGate({ ...passPlan, critique: { verdict: 'revise', rounds: 1 } }, true).proceeded, undefined, 'mustRemaining が無ければ記録しない');
  assert.equal(evaluateCritiqueGate({ ...passPlan, critique: { verdict: 'go', rounds: 1, mustRemaining: 1 } }, true).proceeded, undefined, 'go は記録しない');
});

test('expectedPlanGate：critique が無ければ pass: false（null でも）。通る計画は pass: true', () => {
  assert.equal(expectedPlanGate(passPlan, 3, config, null).pass, true);
  assert.equal(expectedPlanGate(passPlan, 3, config, true).pass, true);
  assert.equal(expectedPlanGate(passPlan, 3, config, false).pass, false);
  const r = expectedPlanGate(noCritiquePlan as Plan, 3, config, null);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join('\n'), CRITIQUE_REASON);
  assert.equal(r.critiqueOnly, true);
  const guard = expectedPlanGate({ ...(noCritiquePlan as Plan), files: ['harness/lib/plan.ts'] }, 3, config, null);
  assert.equal(guard.pass, false);
  assert.notEqual(guard.critiqueOnly, true, 'ほかの理由と重なれば critiqueOnly にしない');
  assert.match(guard.reasons.join('\n'), /ガードレールに触れます/);
  assert.match(guard.reasons.join('\n'), CRITIQUE_REASON);
});

/** Claude の目印の無い、段階 plan-critique の宣言 */
function unmarkedClaim(id: number): IssueComment {
  const value = { by: 'manual', at: new Date().toISOString(), stage: 'plan-critique' };
  return { id, created_at: '', updated_at: '', html_url: `c${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: ['着手しました。', '', renderBlock('agent-claim', value)].join('\n') };
}

const notCounted: [string, () => IssueComment][] = [
  ['計画より後の宣言', () => critiqueClaim({ id: 90 })],
  ['計画と同じ id', () => critiqueClaim({ id: PLAN_ID })],
  ['段階が plan だけ', () => claimComment({ stage: 'plan', id: 10 })],
  ['段階の無い宣言', () => claimComment({ id: 10 })],
  ['解除の宣言', () => claimComment({ stage: 'plan-critique', released: true, id: 10 })],
  ['コラボレーターでない作成者（NONE）', () => critiqueClaim({ association: 'NONE' })],
  ['コラボレーターでない作成者（CONTRIBUTOR）', () => critiqueClaim({ association: 'CONTRIBUTOR' })],
  ['Claude の目印の無い宣言', () => unmarkedClaim(10)],
];

test('critiqueClaimedBefore：計画より前の、信頼できる作成者の段階 plan-critique の宣言だけ数える', () => {
  assert.equal(critiqueClaimedBefore([], PLAN_ID), false);
  assert.equal(critiqueClaimedBefore([critiqueClaim() as IssueComment], PLAN_ID), true);
  assert.equal(critiqueClaimedBefore([critiqueClaim({ by: 'routine' }) as IssueComment], PLAN_ID), true, 'Routine の宣言も数える');
  assert.equal(critiqueClaimedBefore([critiqueClaim({ association: 'MEMBER' }) as IssueComment], PLAN_ID), true);
  for (const [name, make] of notCounted) {
    assert.equal(critiqueClaimedBefore([make()], PLAN_ID), false, name);
  }
  // 後で段階が変わっても、計画より前に plan-critique の宣言があれば数える
  assert.equal(critiqueClaimedBefore([critiqueClaim({ id: 10 }), claimComment({ stage: 'plan-gate', id: 20 })] as IssueComment[], PLAN_ID), true);
});

// ---- App（onComment）：止まる ----

test('計画ゲート（App）：critique の無い計画は宣言があっても agent:plan-review で止め、理由コード no-critique', async () => {
  const fake = await runPlan(noCritiquePlan, [critiqueClaim()]);
  assert.deepEqual(fake.writes().slice(0, 3), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate']);
  assert.ok(!fake.writes().includes('label+agent:plan-ok'));
  const { body, value } = gateRecord(fake);
  assert.match(body, /<!-- agent-harness:reason code=no-critique -->/);
  assert.match(body, /- 批評（plan-critic）の記録（`critique`）がありません/, '停止のコメントに理由の箇条');
  assert.equal(value.pass, false);
  assert.ok(value.reasons.some((r: string) => CRITIQUE_REASON.test(r)));
  assert.ok(!value.reasons.some((r: string) => CLAIM_REASON.test(r)), '宣言はあるので宣言の理由は無い');
});

test('計画ゲート（App）：critique はあるが、計画より前に段階 plan-critique の宣言が無ければ止める（no-critique）', async () => {
  const fake = await runPlan(passPlan, []);
  assert.ok(fake.writes().includes('label+agent:plan-review'));
  assert.ok(!fake.writes().includes('label+agent:plan-ok'));
  const { body, value } = gateRecord(fake);
  assert.match(body, /<!-- agent-harness:reason code=no-critique -->/);
  assert.match(body, /- 計画より前に段階 `plan-critique` の着手宣言がありません/);
  assert.equal(value.pass, false);
});

for (const [name, make] of notCounted) {
  test(`計画ゲート（App）：宣言が数えられない（${name}）なら止める`, async () => {
    const fake = await runPlan(passPlan, [make()]);
    assert.ok(fake.writes().includes('label+agent:plan-review'), name);
    assert.ok(!fake.writes().includes('label+agent:plan-ok'), name);
    const { body, value } = gateRecord(fake);
    assert.match(body, /reason code=no-critique/, name);
    assert.ok(value.reasons.some((r: string) => CLAIM_REASON.test(r)), name);
  });
}

test('計画ゲート（App）：ガードレールと重なるときは今までの理由コード（high-risk）、理由の箇条に批評の理由も並ぶ', async () => {
  const fake = await runPlan({ ...noCritiquePlan, files: ['harness/lib/plan.ts'] }, []);
  assert.ok(fake.writes().includes('label+agent:plan-review'));
  const { body, value } = gateRecord(fake);
  assert.match(body, /<!-- agent-harness:reason code=high-risk -->/);
  assert.doesNotMatch(body, /reason code=no-critique/);
  assert.match(body, /- .*ガードレールに触れます/);
  assert.match(body, /- 批評（plan-critic）の記録（`critique`）がありません/);
  assert.match(body, /- 計画より前に段階 `plan-critique` の着手宣言がありません/);
  assert.equal(value.planReviewOrigin, 'gate');
});

test('計画ゲート（App）：Planner の申告（needsHuman）と重なるときは needs-decision のまま', async () => {
  const fake = await runPlan({ ...noCritiquePlan, needsHuman: true, needsHumanReasons: ['x'] }, [critiqueClaim()]);
  const { body, value } = gateRecord(fake);
  assert.match(body, /reason code=needs-decision/);
  assert.match(body, CRITIQUE_REASON);
  assert.equal(value.planReviewOrigin, 'planner');
});

// ---- App（onComment）：通る ----

test('計画ゲート（App）：go ＋ 計画より前の宣言なら今までどおり通る（記録に critiqueProceeded は無い）', async () => {
  const fake = await runPlan(passPlan, [critiqueClaim()]);
  assert.deepEqual(fake.writes(), ['label+agent:plan-ok', 'label+area:docs', 'comment:plan-gate', 'check:agent/plan-link=success']);
  const { body, value } = gateRecord(fake);
  assert.equal(value.pass, true);
  assert.deepEqual(value.reasons, []);
  assert.ok(!('critiqueProceeded' in value));
  assert.doesNotMatch(body, /人が進めると決めた/);
});

test('計画ゲート（App）：Routine の宣言（by: routine、段階 plan-critique）でも通る', async () => {
  const fake = await runPlan(passPlan, [critiqueClaim({ by: 'routine' })]);
  assert.ok(fake.writes().includes('label+agent:plan-ok'));
  assert.ok(!fake.writes().includes('label+agent:plan-review'));
  assert.equal(gateRecord(fake).value.pass, true);
});

test('計画ゲート（App）：宣言の後に段階が変わっていても（plan-gate など）通る', async () => {
  const fake = await runPlan(passPlan, [critiqueClaim({ id: 10 }), claimComment({ stage: 'plan', id: 5 }), claimComment({ stage: 'plan-gate', id: 20 })]);
  assert.ok(fake.writes().includes('label+agent:plan-ok'));
});

test('計画ゲート（App）：revise で mustRemaining 1（人が進めると決めた）＋ 宣言なら通り、記録と通過のコメントに残す', async () => {
  const fake = await runPlan({ ...passPlan, critique: { verdict: 'revise', rounds: 3, mustRemaining: 1 } }, [critiqueClaim()]);
  assert.ok(fake.writes().includes('label+agent:plan-ok'));
  assert.ok(!fake.writes().includes('label+agent:plan-review'));
  const { body, value } = gateRecord(fake);
  assert.equal(value.pass, true);
  assert.deepEqual(value.critiqueProceeded, { verdict: 'revise', mustRemaining: 1 });
  assert.ok(body.includes('批評で必須の指摘が 1 件残ったまま、人が進めると決めた計画です。'), body);
});

test('計画ゲート（App）：revise でも宣言が無ければ止め、critiqueProceeded は記録しない', async () => {
  const fake = await runPlan({ ...passPlan, critique: { verdict: 'revise', rounds: 3, mustRemaining: 1 } }, []);
  assert.ok(fake.writes().includes('label+agent:plan-review'));
  const { body, value } = gateRecord(fake);
  assert.equal(value.pass, false);
  assert.ok(!('critiqueProceeded' in value));
  assert.doesNotMatch(body, /人が進めると決めた/);
});

// ---- 出し直し ----

test('出し直し：批評の関所だけで止めた記録は planReviewOrigin: gate。批評を足して出し直すと agent:plan-review を外して通す', async () => {
  const { fake, comments } = worldFake([critiqueClaim()]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(noCritiquePlan, ['agent:ready'], PLAN_ID)));
  const first = gateRecord(fake);
  assert.equal(first.value.pass, false);
  assert.equal(first.value.planReviewOrigin, 'gate');
  assert.match(first.body, /reason code=no-critique/);

  // 2回目：同じ世界（前の記録・App が付けた印）に、critique を足した計画を出し直す（id は前の記録より後）
  const nextId = 600 + comments.length;
  fake.calls.length = 0;
  await onComment(ctxFor(fake, 'issue_comment', planEvent(passPlan, ['agent:ready', 'agent:plan-review'], nextId)));
  const w = fake.writes();
  assert.ok(w.includes('label-agent:plan-review'), `前の印を外す: ${w.join(' ')}`);
  assert.ok(w.includes('label+agent:plan-ok'), w.join(' '));
  const second = gateRecord(fake);
  assert.equal(second.value.pass, true);
  assert.ok(second.body.includes('前の計画ゲートの停止（`agent:plan-review`）を外しました'));
});

// ---- split（Epic に分ける計画）----

const child = (title: string, files: string[], dependsOn: number[] = []): SplitChild => ({ title, goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files, dependsOn });
const split: SplitChild[] = [child('feat(x): 一つ目', ['src/a.ts']), child('docs: 二つ目', ['docs/guide/**'], [0])];
const splitPlan: Plan = { ...passPlan, risk: 'critical', files: [], split, critique: { verdict: 'split', rounds: 1 } };
const { critique: _omitSplit, ...splitNoCritique } = splitPlan;

/** 子 Issue を作れる偽の GitHub（harness/test/split-guardrail.test.ts の epicFake を必要な分だけ） */
function epicFake(initial: unknown[]) {
  const comments: unknown[] = [...initial];
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
const createdIssues = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && /\/repos\/o\/r\/issues$/.test(c.path));

test('split の計画：critique が無ければ子 Issue を作らずに agent:plan-review（no-critique）', async () => {
  const fake = epicFake([critiqueClaim()]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(splitNoCritique)));
  const w = fake.writes();
  assert.ok(w.includes('label+agent:plan-review'), w.join(' '));
  assert.ok(!w.includes('label+epic'));
  assert.equal(createdIssues(fake).length, 0);
  const { body, value } = gateRecord(fake);
  assert.match(body, /reason code=no-critique/);
  assert.match(body, CRITIQUE_REASON);
  assert.equal(value.pass, false);
});

test('split の計画：計画より前の宣言が無ければ子 Issue を作らずに止める', async () => {
  const fake = epicFake([]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(splitPlan)));
  assert.ok(fake.writes().includes('label+agent:plan-review'));
  assert.equal(createdIssues(fake).length, 0);
  assert.match(gateRecord(fake).body, /reason code=no-critique/);
});

test('split の計画：critique（split）＋ 宣言なら今までどおり Epic に分ける', async () => {
  const fake = epicFake([critiqueClaim()]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(splitPlan)));
  const w = fake.writes();
  assert.deepEqual(w.slice(0, 3), ['label-agent:plan-ok', 'label+epic', 'comment:plan-gate']);
  assert.ok(!w.includes('label+agent:plan-review'));
  assert.deepEqual(createdIssues(fake).map((c) => c.body.title), split.map((c) => c.title));
  assert.equal(gateRecord(fake).value.pass, true);
});

// ---- agent.ts（子プロセス）----

function agentEnv(remote: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (remote !== null) env.CLAUDE_CODE_REMOTE_SESSION_ID = remote;
  return env;
}

function renderPlan(plan: unknown): { addLabels: string[]; expectedGate: { pass: boolean; reasons: string[] } } {
  const dir = mkdtempSync(join(tmpdir(), 'plan-critique-gate-'));
  try {
    const file = join(dir, 'plan.md');
    writeFileSync(file, `## 計画\n\n${renderBlock('agent-plan', plan)}\n`);
    const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'render-plan', '3', file], { cwd: root, encoding: 'utf8', env: agentEnv(null) });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('render-plan：critique の無い計画は expectedGate.pass が false（理由に批評）、ある計画は true（宣言は見ない）', () => {
  const none = renderPlan(noCritiquePlan);
  assert.equal(none.expectedGate.pass, false);
  assert.match(none.expectedGate.reasons.join('\n'), CRITIQUE_REASON);
  assert.ok(!none.addLabels.includes('agent:plan-review'), 'ゲートだけで止まる見込みには印を付けない（App が付ける）');
  const ok = renderPlan(passPlan);
  assert.equal(ok.expectedGate.pass, true, 'GitHub を読まないので宣言では止めない');
  assert.deepEqual(ok.expectedGate.reasons, []);
});

test('render-claim --stage plan-critique：Routine（CLAUDE_CODE_REMOTE_SESSION_ID）でも by: routine と stage を書き、ゲートが数える', () => {
  const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'render-claim', '--stage', 'plan-critique'], { cwd: root, encoding: 'utf8', env: agentEnv('session_01ABCDEFGHxyz') });
  assert.equal(r.status, 0, r.stderr);
  const b = extractBlock(r.stdout, 'agent-claim');
  assert.ok(b.found && b.ok, r.stdout);
  const v = b.value as Record<string, unknown>;
  assert.equal(v.by, 'routine');
  assert.equal(v.stage, 'plan-critique');
  assert.equal(v.session, 'https://claude.ai/code/session_01ABCDEFGHxyz');
  const posted: IssueComment = { id: 10, body: r.stdout, html_url: 'c', created_at: '', updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } };
  assert.equal(critiqueClaimedBefore([posted], PLAN_ID), true, '出力をそのまま投稿した宣言を計画ゲートが数える');
});

test('render-claim：Routine で --stage なしは今までどおり段階を入れない', () => {
  const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'render-claim'], { cwd: root, encoding: 'utf8', env: agentEnv('session_01ABCDEFGHxyz') });
  assert.equal(r.status, 0, r.stderr);
  const b = extractBlock(r.stdout, 'agent-claim');
  assert.ok(b.found && b.ok, r.stdout);
  assert.equal((b.value as Record<string, unknown>).by, 'routine');
  assert.ok(!('stage' in (b.value as Record<string, unknown>)));
});
