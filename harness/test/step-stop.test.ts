// Issue #306：agent.ts step（decideStep）が、止まるときに理由コード付きの stop を返すこと。セッションの ID・止まる印（hold・blocked・waiting・Epic・依存）・
// 修正の上限（fix-limit）・計画ゲートの人の判断・担当の食い違い・ほかのセッションの宣言・sync の上限・同じ指摘の繰り返し（修正と批評）・批評の上限・drop。
// stop で解除するのは自分の宣言だけで（ほかのセッションの宣言は解除しない）、解除しない理由では release が空になることも確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixRequestFindings } from '../lib/report.ts';
import { CRITIQUE_LIMIT, decideStep, type StepDecision, type StepStopResult } from '../lib/step.ts';
import {
  finding,
  fixRequestBody,
  fleetIssue,
  issueFacts,
  manual,
  N,
  openPr,
  OTHER,
  PR,
  planOkFacts,
  SESSION,
  stepInput,
} from './support/step-fixtures.ts';

function asStop(d: StepDecision): StepStopResult {
  assert.equal(d.result.kind, 'stop', `stop のはず: ${JSON.stringify(d.result)}`);
  assert.equal(d.claim, null, 'stop では宣言しない');
  return d.result as StepStopResult;
}

/** stop の理由と、解除する番号（released は release が空でないとき true） */
function expectStop(d: StepDecision, reason: string, release: number[] = []): StepStopResult {
  const r = asStop(d);
  assert.equal(r.reason, reason, r.detail);
  assert.deepEqual(d.release, release, `解除する番号（${reason}）`);
  assert.equal(r.released, release.length > 0);
  assert.ok(r.detail.length > 0, 'detail がある');
  return r;
}

const failed = { acceptance: { reviewPass: false, at: '2026-09-26T03:00:00Z' } };

// ---- no-session ----

test('no-session：セッションの ID が無い → stop no-session（宣言も解除もしない）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts()), { session: null }));
  expectStop(d, 'no-session');
});

test('no-session：ID の形が違う（クラウドの URL）→ stop no-session、その ID の宣言があっても解除しない', () => {
  const cloud = 'https://claude.ai/code/session_x';
  const d = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(cloud, 'implement') })), { session: cloud }));
  expectStop(d, 'no-session');
});

// ---- 止まる印・Epic・依存 ----

for (const [label, reason] of [['agent:hold', 'hold'], ['agent:blocked', 'blocked'], ['agent:waiting', 'waiting']] as const) {
  test(`Issue に ${label} → stop ${reason}`, () => {
    const d = decideStep(stepInput(fleetIssue(planOkFacts({ labels: ['agent:plan-ok', label] }))));
    const r = expectStop(d, reason);
    assert.equal(r.node, 'stopped');
  });
}

test('Epic → stop epic', () => {
  expectStop(decideStep(stepInput(fleetIssue(issueFacts({ labels: ['epic'] })))), 'epic');
});

test('未解決の依存（openBlockers）→ stop dependency', () => {
  const r = expectStop(decideStep(stepInput(fleetIssue(issueFacts({ openBlockers: [12, 13] })))), 'dependency');
  assert.match(r.detail, /#12/);
});

test('PR に agent:blocked で理由コードが fix-limit → stop fix-limit、理由コードが無ければ blocked、PR に agent:hold → hold', () => {
  const issue = fleetIssue(planOkFacts(), { prs: [openPr({ labels: ['agent:blocked'] })] });
  expectStop(decideStep(stepInput(issue, { blockedReason: 'fix-limit' })), 'fix-limit');
  expectStop(decideStep(stepInput(issue)), 'blocked');
  expectStop(decideStep(stepInput(issue, { blockedReason: 'external' })), 'blocked');
  expectStop(decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ labels: ['agent:hold'] })] }))), 'hold');
});

// ---- plan-review ----

test('plan-review：agent:plan-review で --proceed なし → stop plan-review', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts({ labels: ['agent:plan-review'], latestPlanAt: '2026-09-26T01:00:00Z' }))));
  expectStop(d, 'plan-review');
});

// ---- assignee ----

test('assignee：担当の食い違いの文があれば stop assignee（detail はその文）', () => {
  const r = expectStop(decideStep(stepInput(fleetIssue(planOkFacts()), { assignee: 'Assignee が自分ではありません（other）' })), 'assignee');
  assert.equal(r.detail, 'Assignee が自分ではありません（other）');
  expectStop(decideStep(stepInput(fleetIssue(issueFacts()), { assignee: 'x' })), 'assignee');
  expectStop(decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr()] }), { assignee: 'x' })), 'assignee');
});

test('assignee：自分の宣言があれば解除する（released true）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(SESSION, 'plan-gate') })), { assignee: 'x' }));
  expectStop(d, 'assignee', [N]);
});

// ---- claimed ----

test('claimed：ほかのセッションの有効な手動の宣言（Issue）→ stop claimed、解除しない', () => {
  expectStop(decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(OTHER, 'implement') })))), 'claimed');
  expectStop(decideStep(stepInput(fleetIssue(issueFacts({ claim: manual(OTHER, 'plan') })))), 'claimed');
});

test('claimed：期限を過ぎたほかのセッションの宣言でも止まる', () => {
  const old = manual(OTHER, 'implement', { at: '2026-09-20T00:00:00Z' });
  expectStop(decideStep(stepInput(fleetIssue(planOkFacts({ claim: old })))), 'claimed');
});

test('claimed：PR の段階は PR の宣言で見る。Issue に自分の宣言があっても解除しない', () => {
  const issue = fleetIssue(planOkFacts({ claim: manual(SESSION, 'implement') }), { prs: [openPr({ claim: manual(OTHER, 'judge') })] });
  expectStop(decideStep(stepInput(issue)), 'claimed');
});

// ---- sync-limit ----

test('sync-limit：取り込みの数が上限ちょうどでまた衝突 → stop sync-limit、1つ少なければ node sync', () => {
  const issue = fleetIssue(planOkFacts(), { prs: [openPr({ conflicted: true })] });
  const r = expectStop(decideStep(stepInput(issue, { mergeCommits: 3, syncLimit: 3 })), 'sync-limit');
  assert.equal(r.node, 'sync');
  const under = decideStep(stepInput(issue, { mergeCommits: 2, syncLimit: 3 }));
  assert.equal(under.result.kind, 'node');
  assert.equal(under.result.node, 'sync');
  expectStop(decideStep(stepInput(issue, { mergeCommits: 1, syncLimit: 1 })), 'sync-limit');
});

test('sync-limit：衝突していなければ取り込みの数が上限を超えていても止めない', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr()] }), { mergeCommits: 10, syncLimit: 3 }));
  assert.equal(d.result.kind, 'node');
  assert.equal(d.result.node, 'judge');
});

test('sync-limit：自分の PR の宣言を解除する', () => {
  const issue = fleetIssue(planOkFacts(), { prs: [openPr({ conflicted: true, claim: manual(SESSION, 'sync') })] });
  expectStop(decideStep(stepInput(issue, { mergeCommits: 3 })), 'sync-limit', [PR]);
});

// ---- repeated-finding（修正） ----

const fixIssue = () => fleetIssue(planOkFacts(), { prs: [openPr(failed)] });

test('repeated-finding（fix）：直近2つの変更要求レビューに kind と file が同じ指摘 → stop repeated-finding', () => {
  const d = decideStep(stepInput(fixIssue(), { fixRequests: [[finding('bug', '境界の扱い', 'a.ts')], [finding('bug', '境界の扱いがまだ違う', 'a.ts')]] }));
  const r = expectStop(d, 'repeated-finding');
  assert.equal(r.node, 'fix');
  assert.match(r.detail, /a\.ts/);
});

test('repeated-finding（fix）：file の無い指摘は kind と detail が同じなら stop、detail が違えば node fix', () => {
  expectStop(decideStep(stepInput(fixIssue(), { fixRequests: [[finding('ac-unmet', 'AC 2 が未達')], [finding('ac-unmet', 'AC 2 が未達')]] })), 'repeated-finding');
  const d = decideStep(stepInput(fixIssue(), { fixRequests: [[finding('ac-unmet', 'AC 2 が未達')], [finding('ac-unmet', 'AC 3 が未達')]] }));
  assert.equal(d.result.kind, 'node');
  assert.equal(d.result.node, 'fix');
});

test('repeated-finding（fix）：kind か file が違えば node fix', () => {
  for (const [prev, latest] of [
    [finding('bug', 'x', 'a.ts'), finding('regression', 'x', 'a.ts')],
    [finding('bug', 'x', 'a.ts'), finding('bug', 'x', 'b.ts')],
    [finding('bug', 'x', 'a.ts'), finding('bug', 'x')],
  ]) {
    const d = decideStep(stepInput(fixIssue(), { fixRequests: [[prev!], [latest!]] }));
    assert.equal(d.result.kind, 'node', `${JSON.stringify(prev)} / ${JSON.stringify(latest)}`);
    assert.equal(d.result.node, 'fix');
  }
});

test('repeated-finding（fix）：変更要求レビューが1つなら node fix、比べるのは直近の2つだけ', () => {
  const one = decideStep(stepInput(fixIssue(), { fixRequests: [[finding('bug', 'x', 'a.ts')]] }));
  assert.equal(one.result.kind, 'node');
  const olderSame = decideStep(stepInput(fixIssue(), { fixRequests: [[finding('bug', 'x', 'a.ts')], [finding('regression', 'y', 'b.ts')], [finding('bug', 'x', 'a.ts')]] }));
  assert.equal(olderSame.result.kind, 'node', '1つ前（直近の2つ）に無ければ止めない');
});

test('repeated-finding（fix）：App の変更要求レビューの本文（renderBlockingReview の形）を fixRequestFindings で読んだ指摘で止まる', () => {
  const b1 = fixRequestBody([finding('typecheck-test-failure', 'npm run check が落ちる', 'harness/lib/step.ts'), finding('ac-unmet', 'AC 4 のテストが無い')], 1);
  const b2 = fixRequestBody([finding('typecheck-test-failure', 'まだ落ちる', 'harness/lib/step.ts')], 2);
  const reqs = [fixRequestFindings(b1), fixRequestFindings(b2)];
  assert.deepEqual(reqs[1], [{ kind: 'typecheck-test-failure', file: 'harness/lib/step.ts', detail: 'まだ落ちる' }], '本文の行を読める');
  assert.equal(reqs[0]!.length, 2);
  assert.equal('file' in reqs[0]![1]!, false, 'file の無い行は file を持たない');
  const r = expectStop(decideStep(stepInput(fixIssue(), { fixRequests: reqs })), 'repeated-finding');
  assert.match(r.detail, /harness\/lib\/step\.ts/);
  // file の無い指摘の繰り返しも本文から読める
  const noFile = [fixRequestFindings(fixRequestBody([finding('ac-unmet', 'AC 4 のテストが無い')], 1)), fixRequestFindings(fixRequestBody([finding('ac-unmet', 'AC 4 のテストが無い')], 2))];
  expectStop(decideStep(stepInput(fixIssue(), { fixRequests: noFile })), 'repeated-finding');
});

test('repeated-finding（fix）：自分の PR の宣言を解除する', () => {
  const issue = fleetIssue(planOkFacts(), { prs: [openPr({ ...failed, claim: manual(SESSION, 'fix') })] });
  const d = decideStep(stepInput(issue, { fixRequests: [[finding('bug', 'x', 'a.ts')], [finding('bug', 'x', 'a.ts')]] }));
  expectStop(d, 'repeated-finding', [PR]);
});

// ---- 批評：repeated-finding・critique-limit・drop ----

const critique = (verdict: 'go' | 'revise' | 'split' | 'drop', must: string[] = []) => ({ kind: 'critique' as const, round: { verdict, must } });

test('repeated-finding（批評）：前回と同じ必須の指摘が残る revise → stop repeated-finding、自分の宣言があっても解除しない', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts({ claim: manual(SESSION, 'plan-critique') })), {
    critique: [{ verdict: 'revise', must: ['AC 2 のテストが無い'] }],
    local: critique('revise', ['AC 2 のテストが無い', '別の指摘']),
  }));
  const r = expectStop(d, 'repeated-finding');
  assert.equal(r.node, 'plan-critique');
  assert.match(r.detail, /AC 2 のテストが無い/);
  assert.equal(d.critique.length, 2, '今回の回も段階のファイルに残す');
});

test('repeated-finding（批評）：前回と違う必須の指摘なら node plan', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts()), { critique: [{ verdict: 'revise', must: ['A'] }], local: critique('revise', ['B']) }));
  assert.equal(d.result.kind, 'node');
  assert.equal(d.result.node, 'plan');
});

test(`critique-limit：${CRITIQUE_LIMIT} 回目の revise で必須の指摘が残る → stop critique-limit、解除しない`, () => {
  assert.equal(CRITIQUE_LIMIT, 3);
  const d = decideStep(stepInput(fleetIssue(issueFacts({ claim: manual(SESSION, 'plan-critique') })), {
    critique: [{ verdict: 'revise', must: ['A'] }, { verdict: 'revise', must: ['B'] }],
    local: critique('revise', ['C']),
  }));
  const r = expectStop(d, 'critique-limit');
  assert.equal(r.node, 'plan-critique');
  assert.equal(d.critique.length, 3);
});

test('critique-limit：2回目の revise ではまだ止めない', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts()), { critique: [{ verdict: 'revise', must: ['A'] }], local: critique('revise', ['C']) }));
  assert.equal(d.result.kind, 'node');
});

test('drop → stop other、自分の宣言があっても解除しない', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts({ claim: manual(SESSION, 'plan-critique') })), { local: critique('drop') }));
  expectStop(d, 'other');
});

// ---- 解除するのは自分の宣言だけ ----

test('stop で自分の宣言（Issue と PR）を解除する', () => {
  const issue = fleetIssue(planOkFacts({ labels: ['agent:hold'], claim: manual(SESSION, 'implement') }), { prs: [openPr({ claim: manual(SESSION, 'fix') })] });
  expectStop(decideStep(stepInput(issue)), 'hold', [N, PR]);
});

test('stop でほかのセッションの宣言は解除しない（自分の宣言だけを release に入れる）', () => {
  const both = fleetIssue(planOkFacts({ labels: ['agent:hold'], claim: manual(SESSION, 'implement') }), { prs: [openPr({ claim: manual(OTHER, 'fix') })] });
  expectStop(decideStep(stepInput(both)), 'hold', [N]);
  const otherOnly = fleetIssue(planOkFacts({ labels: ['agent:hold'], claim: manual(OTHER, 'implement') }));
  expectStop(decideStep(stepInput(otherOnly)), 'hold');
  const released = fleetIssue(planOkFacts({ labels: ['agent:hold'], claim: manual(SESSION, 'implement', { released: true }) }));
  expectStop(decideStep(stepInput(released)), 'hold');
});
