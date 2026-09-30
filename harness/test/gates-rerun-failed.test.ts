// 失敗した gate の実行を定期実行で1回だけやり直す処理（rerun-failed.ts の選び方・やり直しの呼び方、gate.yml のジョブ rerun-failed の起動条件と権限）のテスト
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import type { Review } from '../lib/state.ts';
import {
  isRerunCandidate,
  MIN_APP_RATE_REMAINING,
  rerunFailedGateRuns,
  RUN_MATCH_WINDOW_SECONDS,
  selectRerunTargets,
  type BlockKind,
  type RepoComment,
  type TargetState,
  type WorkflowRun,
} from '../gates/rerun-failed.ts';
import { APP, config, FakeGitHub } from './support/gate-fixtures.ts';

const NOW = new Date('2026-09-30T12:00:00Z');
/** NOW から seconds 秒前の ISO 時刻 */
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

const BLOCK: Record<BlockKind, 'agent-plan' | 'agent-verdict' | 'agent-decision'> = { plan: 'agent-plan', verdict: 'agent-verdict', decision: 'agent-decision' };

function run(id: number, createdSecondsAgo: number, patch: Partial<WorkflowRun> = {}): WorkflowRun {
  return { id, created_at: ago(createdSecondsAgo), run_attempt: 1, event: 'issue_comment', status: 'completed', conclusion: 'failure', actor: { login: 'me' }, html_url: `r${id}`, ...patch };
}

function blockComment(id: number, issue: number, kind: BlockKind, createdSecondsAgo: number, patch: Partial<RepoComment> = {}): RepoComment {
  const created = ago(createdSecondsAgo);
  return {
    id, issue_url: `https://api.github.com/repos/o/r/issues/${issue}`, html_url: `c${id}`, created_at: created, updated_at: created,
    author_association: 'OWNER', user: { login: 'me', type: 'User' },
    body: [claudeMark(), 'ブロック', '', renderBlock(BLOCK[kind], { version: 1, issue })].join('\n'),
    ...patch,
  };
}

function appComment(id: number, kind: string, createdSecondsAgo: number, login = APP): IssueComment {
  const created = ago(createdSecondsAgo);
  return { id, html_url: `a${id}`, created_at: created, updated_at: created, author_association: 'NONE', user: { login, type: login === APP ? 'Bot' : 'User' }, body: `${appMark(kind)}\n応答` };
}

function review(id: number, kind: string, submittedSecondsAgo: number, login = APP): Review {
  return { id, state: 'CHANGES_REQUESTED', body: `${appMark(kind)}\n直してください`, submitted_at: ago(submittedSecondsAgo), commit_id: 'a'.repeat(40), author_association: 'NONE', user: { login } };
}

function state(number: number, patch: Partial<TargetState> = {}): TargetState {
  return { number, open: true, comments: [], reviews: [], ...patch };
}

const statesOf = (...list: TargetState[]): Map<number, TargetState> => new Map(list.map((s) => [s.number, s]));

const select = (runs: WorkflowRun[], comments: RepoComment[], states: Map<number, TargetState>) => selectRerunTargets({ config, runs, comments, states, now: NOW });

/** 飛ばした理由（runId ごと） */
const skipReason = (sel: ReturnType<typeof selectRerunTargets>, runId: number): string => {
  const found = sel.skipped.filter((s) => s.runId === runId);
  assert.equal(found.length, 1, `run ${runId} の飛ばした記録が1件ではありません: ${JSON.stringify(sel)}`);
  return found[0]!.reason;
};

// --- selectRerunTargets：選ばれる基本形 ---

test('selectRerunTargets：計画・判定・決定の記録のコメントで起動して失敗した1回目の実行は、処理されていなければ選ばれる', () => {
  const comments = [blockComment(11, 3, 'plan', 600), blockComment(12, 5, 'verdict', 400), blockComment(13, 7, 'decision', 200)];
  const runs = [run(101, 595), run(102, 395), run(103, 195)];
  const sel = select(runs, comments, statesOf(state(3, { comments: [comments[0]!] }), state(5, { comments: [comments[1]!] }), state(7, { comments: [comments[2]!] })));
  assert.deepEqual(sel.skipped, []);
  const byRun = new Map(sel.rerun.map((t) => [t.runId, t]));
  assert.equal(sel.rerun.length, 3);
  assert.deepEqual(byRun.get(101), { runId: 101, commentId: 11, issue: 3, kind: 'plan', commentUrl: 'c11' });
  assert.deepEqual(byRun.get(102), { runId: 102, commentId: 12, issue: 5, kind: 'verdict', commentUrl: 'c12' });
  assert.deepEqual(byRun.get(103), { runId: 103, commentId: 13, issue: 7, kind: 'decision', commentUrl: 'c13' });
});

test('selectRerunTargets：その Issue の App の応答がコメントより前にあるだけなら、やり直す', () => {
  const c = blockComment(11, 3, 'plan', 300);
  const sel = select([run(101, 295)], [c], statesOf(state(3, { comments: [appComment(9, 'plan-gate', 900), c] })));
  assert.deepEqual(sel.rerun.map((t) => t.runId), [101]);
});

// --- 同じ実行を2回以上やり直さない ---

test('selectRerunTargets：やり直した後の実行（同じ ID で run_attempt が 2）は選ばれない', () => {
  const c = blockComment(11, 3, 'plan', 300);
  const sel = select([run(101, 295, { run_attempt: 2 })], [c], statesOf(state(3, { comments: [c] })));
  assert.deepEqual(sel.rerun, []);
});

test('selectRerunTargets：入力に同じ実行が2回あっても、1回だけ選ぶ', () => {
  const c = blockComment(11, 3, 'plan', 300);
  const sel = select([run(101, 295), run(101, 295)], [c], statesOf(state(3, { comments: [c] })));
  assert.deepEqual(sel.rerun.map((t) => t.runId), [101]);
  assert.ok(!sel.skipped.some((s) => s.runId === 101), `同じ実行が飛ばした一覧にも入っています: ${JSON.stringify(sel.skipped)}`);
});

test('selectRerunTargets：issue_comment 以外のイベント・成功した実行・6時間より前の実行は選ばれない', () => {
  const recent = blockComment(11, 3, 'plan', 300);
  const old = blockComment(12, 4, 'plan', 6 * 3600 + 120);
  const sel = select(
    [run(101, 295, { event: 'schedule' }), run(102, 295, { event: 'workflow_dispatch' }), run(103, 295, { conclusion: 'success' }), run(104, 6 * 3600 + 60)],
    [recent, old],
    statesOf(state(3, { comments: [recent] }), state(4, { comments: [old] })),
  );
  assert.deepEqual(sel.rerun, []);
});

test('isRerunCandidate：issue_comment・failure・run_attempt 1・6時間以内だけが対象', () => {
  assert.equal(isRerunCandidate(run(1, 60), NOW), true);
  assert.equal(isRerunCandidate(run(1, 6 * 3600 - 60), NOW), true);
  assert.equal(isRerunCandidate(run(1, 6 * 3600 + 60), NOW), false);
  assert.equal(isRerunCandidate(run(1, 60, { run_attempt: 2 }), NOW), false);
  assert.equal(isRerunCandidate(run(1, 60, { run_attempt: 3 }), NOW), false);
  assert.equal(isRerunCandidate(run(1, 60, { event: 'schedule' }), NOW), false);
  assert.equal(isRerunCandidate(run(1, 60, { event: 'pull_request_target' }), NOW), false);
  assert.equal(isRerunCandidate(run(1, 60, { conclusion: 'success' }), NOW), false);
  assert.equal(isRerunCandidate(run(1, 60, { conclusion: 'cancelled' }), NOW), false);
});

// --- 処理済みなら理由つきで飛ばす ---

test('selectRerunTargets：Close 済みの Issue・PR の実行は「Close 済み」で飛ばす', () => {
  const c = blockComment(11, 3, 'plan', 300);
  const sel = select([run(101, 295)], [c], statesOf(state(3, { open: false, comments: [c] })));
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).includes('Close 済み'));
});

test('selectRerunTargets：コメントより後に App のゲートの応答（plan-gate・verdict-rejected・fix-limit・plan-decision・plan-proceed）があれば「処理済み」で飛ばす', () => {
  const kinds = ['plan-gate', 'verdict-rejected', 'fix-limit', 'plan-decision', 'plan-proceed'];
  for (const [i, kind] of kinds.entries()) {
    const c = blockComment(11, 3, 'verdict', 300);
    const sel = select([run(101, 295)], [c], statesOf(state(3, { comments: [c, appComment(50 + i, kind, 290)] })));
    assert.deepEqual(sel.rerun, [], `${kind} の後でもやり直しています`);
    const reason = skipReason(sel, 101);
    assert.ok(reason.includes('処理済み'), `${kind}: ${reason}`);
    assert.ok(!reason.includes('acceptance の後で失敗'), `${kind} の理由が acceptance と同じです: ${reason}`);
  }
});

test('selectRerunTargets：コメントより後に App の acceptance があれば「acceptance の後で失敗」で飛ばす（ほかの応答と理由を分ける）', () => {
  const c = blockComment(11, 5, 'verdict', 300);
  const sel = select([run(101, 295)], [c], statesOf(state(5, { comments: [c, appComment(60, 'acceptance', 290)] })));
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).includes('acceptance の後で失敗'));
});

test('selectRerunTargets：App 以外が App の目印を書いたコメントでは飛ばさない', () => {
  const c = blockComment(11, 3, 'plan', 300);
  const sel = select([run(101, 295)], [c], statesOf(state(3, { comments: [c, appComment(60, 'plan-gate', 290, 'someone')] })));
  assert.deepEqual(sel.rerun.map((t) => t.runId), [101]);
});

test('selectRerunTargets：コメントより後に同じ種類のブロックのコメントがあれば「後に同じ種類」で飛ばす。別の種類なら飛ばさない', () => {
  const c = blockComment(11, 3, 'plan', 300);
  const later = blockComment(12, 3, 'plan', 100);
  const sel = select([run(101, 295)], [c, later], statesOf(state(3, { comments: [c, later] })));
  assert.ok(!sel.rerun.some((t) => t.runId === 101));
  assert.ok(skipReason(sel, 101).includes('後に同じ種類'));

  const other = blockComment(13, 3, 'decision', 100, { user: { login: 'other', type: 'User' } });
  const sel2 = select([run(101, 295)], [c, other], statesOf(state(3, { comments: [c, other] })));
  assert.deepEqual(sel2.rerun.map((t) => t.runId), [101]);
});

test('selectRerunTargets：同じ作成者が120秒以内に同じ種類を2回投稿し、前の実行だけ失敗したときは「後に同じ種類」で飛ばす', () => {
  const first = blockComment(11, 3, 'plan', 300);
  const second = blockComment(12, 3, 'plan', 270);
  const sel = select([run(101, 298)], [first, second], statesOf(state(3, { comments: [first, second] })));
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).includes('後に同じ種類'));
});

test('selectRerunTargets：判定のコメントより後に App の fix-request のレビューがあれば「途中まで処理済み」で飛ばす', () => {
  const c = blockComment(11, 5, 'verdict', 300);
  const sel = select([run(101, 295)], [c], statesOf(state(5, { comments: [c], reviews: [review(70, 'fix-request', 290)] })));
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).includes('途中まで処理済み'));
});

test('selectRerunTargets：コメントより前の fix-request や App 以外のレビューでは飛ばさない', () => {
  const c = blockComment(11, 5, 'verdict', 300);
  const sel = select([run(101, 295)], [c], statesOf(state(5, {
    comments: [c],
    reviews: [review(70, 'fix-request', 900), review(71, 'fix-request', 290, 'someone'), review(72, 'other-kind', 290)],
  })));
  assert.deepEqual(sel.rerun.map((t) => t.runId), [101]);
});

test('selectRerunTargets：Issue・PR の状態が無ければ飛ばす', () => {
  const c = blockComment(11, 3, 'plan', 300);
  const sel = select([run(101, 295)], [c], statesOf());
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).length > 0);
});

// --- 実行とコメントの結び付け ---

test('selectRerunTargets：作成者が違うコメントとは結ばず「コメントを特定できない」で飛ばす', () => {
  const c = blockComment(11, 3, 'plan', 300, { user: { login: 'other', type: 'User' } });
  const sel = select([run(101, 295)], [c], statesOf(state(3, { comments: [c] })));
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).includes('コメントを特定できない'));
});

test('selectRerunTargets：時刻が120秒より離れたコメントとは結ばず、差の秒数を理由に書く', () => {
  const c = blockComment(11, 3, 'plan', 500);
  const sel = select([run(101, 500 - (RUN_MATCH_WINDOW_SECONDS + 80))], [c], statesOf(state(3, { comments: [c] })));
  assert.deepEqual(sel.rerun, []);
  const reason = skipReason(sel, 101);
  assert.ok(reason.includes('コメントを特定できない'), reason);
  assert.ok(reason.includes(String(RUN_MATCH_WINDOW_SECONDS + 80)), `差の秒数がありません: ${reason}`);
});

test('selectRerunTargets：実行より後に作られたコメントとは結ばない', () => {
  const c = blockComment(11, 3, 'plan', 290);
  const sel = select([run(101, 300)], [c], statesOf(state(3, { comments: [c] })));
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).includes('コメントを特定できない'));
});

test('selectRerunTargets：コラボレーター以外のコメントとは結ばない', () => {
  for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR']) {
    const c = blockComment(11, 3, 'plan', 300, { author_association: association });
    const sel = select([run(101, 295)], [c], statesOf(state(3, { comments: [c] })));
    assert.deepEqual(sel.rerun, [], association);
    assert.ok(skipReason(sel, 101).includes('コメントを特定できない'), association);
  }
});

test('selectRerunTargets：ブロックを含まないコメントとは結ばない', () => {
  const c = { ...blockComment(11, 3, 'plan', 300), body: `${claudeMark()}\nただのコメント` };
  const sel = select([run(101, 295)], [c], statesOf(state(3, { comments: [c] })));
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).includes('コメントを特定できない'));
});

test('selectRerunTargets：updated_at は新しいが created_at が古い（編集された）コメントとは結ばない', () => {
  const c = blockComment(11, 3, 'plan', 3 * 3600, { updated_at: ago(65) });
  const sel = select([run(101, 60)], [c], statesOf(state(3, { comments: [c] })));
  assert.deepEqual(sel.rerun, []);
  assert.ok(skipReason(sel, 101).includes('コメントを特定できない'));
});

test('selectRerunTargets：近い時刻の2つの実行と2つのコメントは1対1で結ぶ', () => {
  const c1 = blockComment(11, 3, 'plan', 300);
  const c2 = blockComment(12, 4, 'plan', 290);
  const r1 = run(101, 285);
  const r2 = run(102, 284);
  const sel = select([r1, r2], [c1, c2], statesOf(state(3, { comments: [c1] }), state(4, { comments: [c2] })));
  assert.equal(sel.rerun.length, 2, JSON.stringify(sel));
  assert.deepEqual(new Set(sel.rerun.map((t) => t.runId)), new Set([101, 102]));
  assert.deepEqual(new Set(sel.rerun.map((t) => t.commentId)), new Set([11, 12]));
});

test('selectRerunTargets：実行が2つでコメントが1つなら、1つだけ結び、残りは「コメントを特定できない」', () => {
  const c = blockComment(11, 3, 'plan', 300);
  const sel = select([run(101, 295), run(102, 290)], [c], statesOf(state(3, { comments: [c] })));
  assert.equal(sel.rerun.length, 1, JSON.stringify(sel));
  assert.equal(sel.rerun[0]!.commentId, 11);
  const other = sel.rerun[0]!.runId === 101 ? 102 : 101;
  assert.ok(skipReason(sel, other).includes('コメントを特定できない'));
});

// --- rerunFailedGateRuns（偽の GitHub を2つ） ---

interface World {
  runs: WorkflowRun[];
  comments: RepoComment[];
  issues: Record<number, { open: boolean; pr?: boolean; comments: IssueComment[]; reviews?: Review[] }>;
  failRerun?: number[];
}

function fakes(w: World): { actionsFake: FakeGitHub; appFake: FakeGitHub; actions: GitHub; app: GitHub } {
  const actionsFake = new FakeGitHub()
    .on('GET', /\/actions\/workflows\/gate\.yml\/runs/, () => ({ total_count: w.runs.length, workflow_runs: w.runs }))
    .on('POST', /\/actions\/runs\/(\d+)\/rerun-failed-jobs$/, (m) => {
      if (w.failRerun?.includes(Number(m[1]))) throw new Error(`403 rerun ${m[1]}`);
      return {};
    });
  const appFake = new FakeGitHub()
    .on('GET', /\/issues\/comments\?/, () => w.comments)
    .on('GET', /\/issues\/(\d+)$/, (m) => {
      const i = w.issues[Number(m[1])];
      if (!i) throw new Error(`404 issues/${m[1]}`);
      return { number: Number(m[1]), state: i.open ? 'open' : 'closed', ...(i.pr ? { pull_request: {} } : {}) };
    })
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => w.issues[Number(m[1])]?.comments ?? [])
    .on('GET', /\/pulls\/(\d+)\/reviews/, (m) => w.issues[Number(m[1])]?.reviews ?? []);
  return { actionsFake, appFake, actions: new GitHub(actionsFake, 'o/r'), app: new GitHub(appFake, 'o/r') };
}

const rerunPosts = (f: FakeGitHub): string[] => f.calls.filter((c) => c.method === 'POST' && c.path.includes('/rerun-failed-jobs')).map((c) => c.path);

test('rerunFailedGateRuns：選んだ実行にだけ rerun-failed-jobs を Actions のクライアントで呼び、App のクライアントでは呼ばない', async () => {
  const target = blockComment(11, 3, 'plan', 300);
  const closed = blockComment(12, 4, 'plan', 200);
  const verdictC = blockComment(13, 5, 'verdict', 100);
  const w: World = {
    runs: [run(101, 295), run(102, 195), run(103, 95)],
    comments: [target, closed, verdictC],
    issues: {
      3: { open: true, comments: [target] },
      4: { open: false, comments: [closed] },
      5: { open: true, pr: true, comments: [verdictC], reviews: [review(70, 'fix-request', 90)] },
    },
  };
  const f = fakes(w);
  const logs: string[] = [];
  const result = await rerunFailedGateRuns({ config, app: f.app, actions: f.actions, appRateRemaining: async () => 5000, log: (m) => logs.push(m), now: NOW });

  assert.deepEqual(rerunPosts(f.actionsFake), ['/repos/o/r/actions/runs/101/rerun-failed-jobs']);
  assert.deepEqual(rerunPosts(f.appFake), []);
  assert.ok(!f.appFake.calls.some((c) => c.path.includes('/actions/')), `App のクライアントで Actions の API を呼んでいます: ${JSON.stringify(f.appFake.calls)}`);
  assert.ok(f.actionsFake.calls.every((c) => c.path.includes('/actions/')), `Actions のクライアントで Actions 以外の API を呼んでいます: ${JSON.stringify(f.actionsFake.calls)}`);
  // 書き込みは rerun-failed-jobs だけ（コメント・ラベルなどを書かない）
  assert.deepEqual([...f.actionsFake.writes(), ...f.appFake.writes()], ['POST /repos/o/r/actions/runs/101/rerun-failed-jobs']);

  assert.deepEqual(result.rerun.map((t) => t.runId), [101]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(new Set(result.skipped.map((s) => s.runId)), new Set([102, 103]));

  const runsRead = f.actionsFake.calls.find((c) => c.method === 'GET' && c.path.includes('/actions/workflows/gate.yml/runs'));
  assert.ok(runsRead, '実行の一覧を読んでいません');
  assert.ok(runsRead.path.includes('event=issue_comment'), runsRead.path);
  assert.ok(runsRead.path.includes('status=failure'), runsRead.path);

  const log = logs.join('\n');
  assert.ok(log.includes('101'), `やり直した実行の id がログにありません: ${log}`);
  assert.ok(log.includes('102') && log.includes('Close 済み'), `飛ばした実行と理由がログにありません: ${log}`);
  assert.ok(log.includes('103') && log.includes('途中まで処理済み'), `飛ばした実行と理由がログにありません: ${log}`);
});

test('rerunFailedGateRuns：App の上限の残りが少ないときは、やり直しも Actions の読み取りも呼ばない', async () => {
  const c = blockComment(11, 3, 'plan', 300);
  const f = fakes({ runs: [run(101, 295)], comments: [c], issues: { 3: { open: true, comments: [c] } } });
  const logs: string[] = [];
  const result = await rerunFailedGateRuns({ config, app: f.app, actions: f.actions, appRateRemaining: async () => MIN_APP_RATE_REMAINING - 1, log: (m) => logs.push(m), now: NOW });
  assert.deepEqual(f.actionsFake.calls, []);
  assert.deepEqual(f.appFake.calls, []);
  assert.deepEqual(result, { rerun: [], skipped: [], failed: [] });
  assert.ok(logs.length > 0, '上限で止めたことがログにありません');
});

test('rerunFailedGateRuns：App の上限の残りがちょうど下限なら、やり直す', async () => {
  const c = blockComment(11, 3, 'plan', 300);
  const f = fakes({ runs: [run(101, 295)], comments: [c], issues: { 3: { open: true, comments: [c] } } });
  await rerunFailedGateRuns({ config, app: f.app, actions: f.actions, appRateRemaining: async () => MIN_APP_RATE_REMAINING, log: () => {}, now: NOW });
  assert.deepEqual(rerunPosts(f.actionsFake), ['/repos/o/r/actions/runs/101/rerun-failed-jobs']);
});

test('rerunFailedGateRuns：候補の実行が無ければ、App のクライアントでコメントを読まない', async () => {
  const c = blockComment(11, 3, 'plan', 300);
  const f = fakes({ runs: [run(101, 295, { run_attempt: 2 })], comments: [c], issues: { 3: { open: true, comments: [c] } } });
  const result = await rerunFailedGateRuns({ config, app: f.app, actions: f.actions, appRateRemaining: async () => 5000, log: () => {}, now: NOW });
  assert.deepEqual(f.appFake.calls, []);
  assert.deepEqual(rerunPosts(f.actionsFake), []);
  assert.deepEqual(result.rerun, []);
});

test('rerunFailedGateRuns：1つのやり直しが失敗しても残りをやり直し、失敗した実行は failed に入ってログに出る', async () => {
  const c1 = blockComment(11, 3, 'plan', 300);
  const c2 = blockComment(12, 4, 'decision', 200);
  const f = fakes({
    runs: [run(101, 295), run(102, 195)],
    comments: [c1, c2],
    issues: { 3: { open: true, comments: [c1] }, 4: { open: true, comments: [c2] } },
    failRerun: [101],
  });
  const logs: string[] = [];
  const result = await rerunFailedGateRuns({ config, app: f.app, actions: f.actions, appRateRemaining: async () => 5000, log: (m) => logs.push(m), now: NOW });
  assert.deepEqual(new Set(rerunPosts(f.actionsFake)), new Set(['/repos/o/r/actions/runs/101/rerun-failed-jobs', '/repos/o/r/actions/runs/102/rerun-failed-jobs']));
  assert.deepEqual(result.failed.map((x) => x.runId), [101]);
  assert.ok(result.failed[0]!.error.length > 0);
  assert.ok(result.rerun.some((t) => t.runId === 102));
  const log = logs.join('\n');
  assert.ok(log.includes('101') && log.includes('102'), log);
});

// --- gate.yml のジョブ rerun-failed ---

const root = join(import.meta.dirname, '..', '..');
const ymlLines = (): string[] => readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8').split(/\r?\n/);
const indentOf = (l: string): number => l.match(/^\s*/)![0].length;
const isBlankOrComment = (l: string): boolean => l.trim() === '' || l.trim().startsWith('#');

/** 行 start の下の、字下げの深い行（コメント・空行を除く） */
function blockBelow(lines: string[], start: number): string[] {
  const indent = indentOf(lines[start]!);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (isBlankOrComment(l)) continue;
    if (indentOf(l) <= indent) break;
    out.push(l);
  }
  return out;
}

/** jobs の直下のジョブの行番号 */
function jobLine(lines: string[], name: string): number {
  const jobs = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  assert.ok(jobs >= 0, 'jobs: がありません');
  const at = lines.findIndex((l, i) => i > jobs && new RegExp(`^  ${name}:\\s*(#.*)?$`).test(l));
  assert.ok(at >= 0, `ジョブ ${name} がありません`);
  return at;
}

/** ジョブの直下のキー（key:）の行と、その下のブロック */
function jobKey(lines: string[], job: number, key: string): { line: string; block: string[] } | null {
  const body = blockBelow(lines, job);
  const childIndent = Math.min(...body.map(indentOf));
  const idx = body.findIndex((l) => indentOf(l) === childIndent && new RegExp(`^\\s*${key}:`).test(l));
  if (idx < 0) return null;
  const out: string[] = [];
  for (const l of body.slice(idx + 1)) {
    if (indentOf(l) <= childIndent) break;
    out.push(l);
  }
  return { line: body[idx]!, block: out };
}

test('gate.yml：ジョブ rerun-failed の if は schedule と workflow_dispatch だけ', () => {
  const lines = ymlLines();
  const job = jobLine(lines, 'rerun-failed');
  const cond = jobKey(lines, job, 'if');
  assert.ok(cond, 'rerun-failed に if がありません');
  const text = [cond.line, ...cond.block].join(' ');
  const events = [...text.matchAll(/github\.event_name\s*==\s*'([\w-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(new Set(events), new Set(['schedule', 'workflow_dispatch']), text);
  assert.ok(!text.includes('!='), `否定の条件があります: ${text}`);
  assert.ok(!text.includes('&&'), `ほかの条件と組み合わせています: ${text}`);
});

test('gate.yml：ジョブ rerun-failed の permissions に actions: write と contents: read がある', () => {
  const lines = ymlLines();
  const perms = jobKey(lines, jobLine(lines, 'rerun-failed'), 'permissions');
  assert.ok(perms, 'rerun-failed に permissions がありません');
  const entries = perms.block.map((l) => l.trim());
  assert.ok(entries.includes('actions: write'), entries.join(', '));
  assert.ok(entries.includes('contents: read'), entries.join(', '));
});

test('gate.yml：ジョブ rerun-failed は concurrency で同時に動かず、既定ブランチのコードで rerun.ts を GH_ACTIONS_TOKEN 付きで動かす', () => {
  const lines = ymlLines();
  const job = jobLine(lines, 'rerun-failed');
  const body = blockBelow(lines, job).map((l) => l.trim());
  const text = body.join('\n');
  assert.ok(text.includes('gate-rerun-failed'), `concurrency の group がありません: ${text}`);
  assert.ok(body.includes('cancel-in-progress: false'), text);
  assert.ok(text.includes('node harness/gates/rerun.ts'), text);
  assert.ok(/GH_ACTIONS_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/.test(text), text);
  assert.ok(body.includes('persist-credentials: false'), text);
  assert.ok(!text.includes('github.event.comment'), `イベントの中身を埋め込んでいます: ${text}`);
  assert.ok(!text.includes('github.event.pull_request.head'), `PR の head を使っています: ${text}`);
});

test('gate.yml：ジョブ gate とファイル先頭の permissions に actions: write が無い', () => {
  const lines = ymlLines();
  const gate = jobLine(lines, 'gate');
  const gateBody = blockBelow(lines, gate).map((l) => l.trim());
  assert.ok(!gateBody.some((l) => l.startsWith('actions:')), `gate ジョブに actions の権限があります`);

  const top = lines.findIndex((l) => /^permissions:\s*(#.*)?$/.test(l));
  assert.ok(top >= 0, 'ファイル先頭の permissions がありません');
  const topEntries = blockBelow(lines, top).map((l) => l.trim());
  assert.deepEqual(topEntries, ['contents: read']);
});

test('gate.yml：最初の `if: >-` は gate ジョブのもので、rerun-failed は gate ジョブの後にある', () => {
  const lines = ymlLines();
  const gate = jobLine(lines, 'gate');
  const rerun = jobLine(lines, 'rerun-failed');
  assert.ok(gate < rerun, 'rerun-failed が gate より前にあります');
  const firstIf = lines.findIndex((l) => /^\s+if: >-\s*$/.test(l));
  assert.ok(firstIf > gate && firstIf < rerun, `最初の if: >- が gate ジョブの中にありません（行 ${firstIf + 1}）`);
});
