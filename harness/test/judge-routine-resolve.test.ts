// Issue #1097：判定の Routine が入力無しで PR を引き当てる（harness/lib/judge-routine.ts の selectRoutineCandidate と、runJudgeRoutineCheck(gh, null, deps)）。
// (1) selectRoutineCandidate：候補（Draft・claude/ の head・判定なし・宣言なし）が 2 件なら updatedAt の古いほう。有効な judge の宣言がある PR、
//     Draft でない PR、claude/ でない head、判定済み（samePatchAsVerdict）は候補から外れる。期限切れの judge の宣言・judge 以外の段階の宣言は有効でない。全部外れたら null。
// (2) runJudgeRoutineCheck を偽の GitHub（GET /pulls?state=open・/issues/{n}/comments）で通す：候補があれば古いほうが judge（inputHead は今の head、dryRun は false）、
//     全部が判定済み（同じ patch-id）なら skip（no-candidate）。どの場合も GitHub に書き込まない。git の確かめ（deps.git）は偽物。
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ClaimAge } from '../lib/fleet.ts';
import { GitHub } from '../lib/github.ts';
import { type RoutineCandidate, selectRoutineCandidate } from '../lib/judge-routine.ts';
import type { Claim } from '../lib/queue.ts';
import { claimComment, FakeGitHub, HEAD, hoursAgo, pr, verdictComment } from './support/gate-fixtures.ts';

const OTHER = 'c'.repeat(40);
const CHECKOUT = 'd'.repeat(40);
const AGE: ClaimAge = { now: new Date(), humanClaimStaleHours: 24, routineClaimTakeoverMinutes: 60 };
const claim = (patch: Partial<Claim> & { at?: string } = {}): Claim => ({ by: 'manual', at: new Date().toISOString(), stage: 'judge', ...patch } as Claim);
const cand = (patch: Partial<RoutineCandidate> = {}): RoutineCandidate => ({
  number: 5, headSha: HEAD, headRef: 'claude/issue-3', draft: true, updatedAt: '2026-09-26T00:00:00Z', claim: null, latestVerdictHead: null, samePatchAsVerdict: false, ...patch,
});
const older = (patch: Partial<RoutineCandidate> = {}) => cand({ number: 7, headSha: OTHER, updatedAt: '2026-09-20T00:00:00Z', ...patch });

// --- (1) 候補の選び方 ---

test('selectRoutineCandidate：候補が 2 件なら updatedAt の古いほう。有効な judge の宣言・Draft でない・claude/ でない head・判定済みは外れ、全部外れたら null', () => {
  const cases: { name: string; prs: RoutineCandidate[]; want: number | null }[] = [
    { name: '2 件なら古いほう（並びに関わらず）', prs: [cand(), older()], want: 7 },
    { name: '2 件なら古いほう（古いほうが後ろ）', prs: [older(), cand()], want: 7 },
    { name: '有効な judge の宣言がある PR は外れる', prs: [cand(), older({ claim: claim() })], want: 5 },
    { name: '期限切れの judge の宣言は有効でない', prs: [cand(), older({ claim: claim({ at: hoursAgo(25) }) })], want: 7 },
    { name: 'judge 以外の段階の宣言は候補を外さない', prs: [cand(), older({ claim: claim({ stage: 'implement' }) })], want: 7 },
    { name: 'Draft でない PR は外れる', prs: [cand(), older({ draft: false })], want: 5 },
    { name: 'claude/ でない head は外れる', prs: [cand(), older({ headRef: 'feature/x' })], want: 5 },
    { name: '判定済み（同じ patch-id）は外れる', prs: [cand(), older({ latestVerdictHead: 'e'.repeat(40), samePatchAsVerdict: true })], want: 5 },
    { name: '判定があっても patch-id が違えば候補', prs: [cand(), older({ latestVerdictHead: 'e'.repeat(40), samePatchAsVerdict: false })], want: 7 },
    { name: '全部外れたら null', prs: [cand({ draft: false }), older({ claim: claim() })], want: null },
    { name: '0 件なら null', prs: [], want: null },
  ];
  for (const c of cases) assert.equal(selectRoutineCandidate(c.prs, AGE)?.number ?? null, c.want, c.name);
});

// --- (2) コマンドの中身を偽の GitHub で（入力無し） ---

/** commands のファイルは cli.ts を import し、cli.ts は読み込み時に harness.config.json を読むので、使うときだけ読み込む */
const loadRun = async () => (await import('../scripts/agent/commands/judge-routine.ts')).runJudgeRoutineCheck;

function world(prs: ReturnType<typeof pr>[], comments: Record<number, unknown[]> = {}) {
  return new FakeGitHub()
    .on('GET', /\/pulls\?state=open/, () => prs)
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => comments[Number(m[1])] ?? []);
}

async function resolve(t: TestContext, fake: FakeGitHub, samePatch: boolean) {
  const run = await loadRun();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  try {
    const git = { fetchUnshallow: () => {}, headSha: () => CHECKOUT, isAncestorOfDefault: () => true };
    return await run(new GitHub(fake, 'o/r'), null, { samePatch: () => samePatch, git, age: AGE, defaultBranch: 'main' });
  } finally {
    t.mock.restoreAll();
  }
}

test('runJudgeRoutineCheck：入力無しで候補の Draft PR が 2 件あれば、更新の古いほうが judge（inputHead は今の head、dryRun は false）', async (t) => {
  const fake = world([pr(), pr({ number: 7, updated_at: '2026-09-20T00:00:00Z', head: { ref: 'claude/issue-4', sha: OTHER, repo: { full_name: 'o/r' } } })]);
  const r = await resolve(t, fake, false);
  assert.deepEqual(r, { action: 'judge', pr: 7, head: OTHER, inputHead: OTHER, dryRun: false });
  assert.deepEqual(fake.writes(), []);
});

test('runJudgeRoutineCheck：入力無しで全部が判定済み（同じ patch-id）・有効な judge の宣言あり・Draft でない、なら skip（no-candidate）で書き込まない', async (t) => {
  const prs = [pr(), pr({ number: 7, head: { ref: 'claude/issue-4', sha: OTHER, repo: { full_name: 'o/r' } } }), pr({ number: 8, draft: false })];
  const fake = world(prs, { 5: [verdictComment({ headSha: 'e'.repeat(40) })], 7: [claimComment({ stage: 'judge' })] });
  const r = await resolve(t, fake, true);
  assert.equal(r.action, 'skip');
  if (r.action === 'skip') assert.ok(r.reason.startsWith('no-candidate: '), r.reason);
  assert.deepEqual(fake.writes(), []);
});
