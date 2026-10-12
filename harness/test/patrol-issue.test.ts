// Issue #703：patrol のまとめの Issue の本文に置く状態（patrol-state）の往復・初回の扱い・縮め方・題名の照らし・pull の後に増えた下書きと回のコメントを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark } from '../lib/blocks.ts';
import type { PatrolRound, PatrolState } from '../lib/patrol.ts';
import {
  compactPatrolIssueState, dedupeDrafts, newDraftsSince, parsePatrolIssueBody, renderPatrolIssueBody, renderPatrolRoundComment,
  type PatrolIssueState,
} from '../lib/patrol-issue.ts';
import type { LoopDraft, LoopState } from '../lib/qa-retro-loop.ts';
import type { TestPruneLoopState } from '../lib/test-prune-loop.ts';

const AT = '2026-10-01T00:00:00.000Z';
const d = (title: string, created: number | null = null, body = `${title} の本文`): LoopDraft => ({ title, body, created });

/** parsePatrolState が通る最小の形 */
const patrolRound = (i: number): PatrolRound => ({ at: new Date(Date.parse(AT) + i * 3600_000).toISOString(), ran: ['qa-retro'], suggested: ['arch-review'] });
const patrol = (rounds = 1): PatrolState => ({ version: 1, reviews: {}, observe: null, rounds: Array.from({ length: rounds }, (_, i) => patrolRound(i)) });
/** parseLoopState が通る最小の形（回ごとの下書き） */
const qaRetro = (...drafts: LoopDraft[][]): LoopState => ({
  version: 1, until: AT, rounds: drafts.map((ds) => ({ since: AT, until: AT, advancedAt: AT, prs: 0, drafts: ds })),
});
/** parseTestPruneLoopState が通る最小の形（回ごとの下書き） */
const testPrune = (...drafts: LoopDraft[][]): TestPruneLoopState => ({
  version: 1, rounds: drafts.map((ds) => ({ at: AT, generatedAt: AT, headSha: null, candidates: 0, drafts: ds, duplicates: [] })),
});
const block = (json: string) => ['説明', '', '```patrol-state', json, '```'].join('\n');

// --- AC1：render → parse の往復 ---

test('renderPatrolIssueBody → parsePatrolIssueBody：3つとも有・一部 null・全部 null の状態がそのまま戻る', () => {
  const cases: PatrolIssueState[] = [
    { version: 1, patrol: patrol(2), qaRetro: qaRetro([d('qa の下書き', null, '本文に ```フェンス``` を含む\n2行目')]), testPrune: testPrune([d('prune の下書き', 12)]) },
    { version: 1, patrol: patrol(), qaRetro: null, testPrune: testPrune([]) },
    { version: 1, patrol: null, qaRetro: null, testPrune: null },
  ];
  for (const state of cases) {
    assert.deepEqual(parsePatrolIssueBody(renderPatrolIssueBody(state)), { first: false, state });
  }
  assert.deepEqual(parsePatrolIssueBody(renderPatrolIssueBody(null)), { first: false, state: { version: 1, patrol: null, qaRetro: null, testPrune: null } });
});

// --- AC2：初回の扱い ---

test('parsePatrolIssueBody：ブロックが無い・JSON が壊れている・version が違う・部分の状態が壊れている本文は first: true と理由になる', () => {
  const ok = { version: 1, patrol: null, qaRetro: null, testPrune: null };
  const cases: [string, string | null][] = [
    ['本文が null', null],
    ['本文が空', ''],
    ['ブロックが無い', '説明だけの本文'],
    ['ブロックが2つ', `${block(JSON.stringify(ok))}\n\n${block(JSON.stringify(ok))}`],
    ['JSON が壊れている', block('{ "version": 1, ')],
    ['オブジェクトでない', block('[1]')],
    ['version が 2', block(JSON.stringify({ ...ok, version: 2 }))],
    ['patrol が壊れている', block(JSON.stringify({ ...ok, patrol: { version: 1, reviews: 1, observe: null, rounds: [] } }))],
    ['qaRetro が壊れている', block(JSON.stringify({ ...ok, qaRetro: { version: 1, until: 'x', rounds: [] } }))],
    ['testPrune が壊れている', block(JSON.stringify({ ...ok, testPrune: { version: 1, rounds: 'x' } }))],
    ['testPrune のキーが無い', block(JSON.stringify({ version: 1, patrol: null, qaRetro: null }))],
  ];
  for (const [name, body] of cases) {
    const r = parsePatrolIssueBody(body);
    assert.equal(r.first, true, name);
    if (r.first) assert.ok(typeof r.reason === 'string' && r.reason.length > 0, name);
  }
});

// --- AC3：縮め方 ---

test('compactPatrolIssueState：採用済みの下書きの body を空にして題名と created を残し、未採用の下書きと回の数を変えない（元の状態は変えない）', () => {
  const state: PatrolIssueState = {
    version: 1,
    patrol: patrol(12),
    qaRetro: qaRetro([d('qa 採用済み', 21), d('qa 未採用')], []),
    testPrune: testPrune([d('prune 採用済み', 22)], [d('prune 未採用')]),
  };
  const before = structuredClone(state);
  const c = compactPatrolIssueState(state);
  assert.deepEqual(state, before);
  assert.deepEqual(c.qaRetro!.rounds.map((r) => r.drafts), [[{ title: 'qa 採用済み', body: '', created: 21 }, d('qa 未採用')], []]);
  assert.deepEqual(c.testPrune!.rounds.map((r) => r.drafts), [[{ title: 'prune 採用済み', body: '', created: 22 }], [d('prune 未採用')]]);
  // patrol の rounds だけ直近 10 件にする
  assert.deepEqual(c.patrol!.rounds, state.patrol!.rounds.slice(-10));
});

// --- AC4：題名の照らし ---

test('dedupeDrafts：開いた Issue と同じ題名（空白・大文字小文字の違いを含む）を removed に Issue 番号つきで除き、先頭から max 件を残す', () => {
  const drafts = [{ title: '  Fix   Patrol  ' }, { title: 'A' }, { title: 'fix(harness): QA' }, { title: 'B' }, { title: 'C' }];
  const openIssues = [{ number: 9, title: 'fix patrol' }, { number: 5, title: 'Fix Patrol' }, { number: 7, title: 'FIX(harness):  qa' }];
  assert.deepEqual(dedupeDrafts(drafts, openIssues, 2), {
    kept: [{ title: 'A' }, { title: 'B' }],
    removed: [{ title: '  Fix   Patrol  ', issue: 5 }, { title: 'fix(harness): QA', issue: 7 }],
  });
  assert.deepEqual(dedupeDrafts(drafts, [], 0).kept, []);
});

// --- AC5：pull の後に増えた下書きと回のコメント ---

test('newDraftsSince：pull 時の回数より後の回の下書きだけを qa-retro → test-prune の順に返す', () => {
  const state: PatrolIssueState = {
    version: 1,
    patrol: null,
    qaRetro: qaRetro([d('qa 古い')], [d('qa 新しい')]),
    testPrune: testPrune([d('prune 古い')], [d('prune 新しい')]),
  };
  assert.deepEqual(newDraftsSince(state, { qaRetro: 1, testPrune: 1 }), [
    { source: 'qa-retro', title: 'qa 新しい', body: 'qa 新しい の本文' },
    { source: 'test-prune', title: 'prune 新しい', body: 'prune 新しい の本文' },
  ]);
  assert.deepEqual(newDraftsSince(state, { qaRetro: 2, testPrune: 2 }), []);
});

test('renderPatrolRoundComment：Claude の目印・ran・下書きの題名・arch-review の URL が入る', () => {
  const url = 'https://github.com/o/r/issues/1#issuecomment-123';
  const body = renderPatrolRoundComment({
    session: 'sess-1',
    patrolRound: { at: AT, ran: ['test-prune'], suggested: [] },
    drafts: [{ source: 'qa-retro', title: 'qa の新しい下書き', body: '本文' }],
    summary: null,
    archReviewUrl: url,
  });
  for (const s of [claudeMark('sess-1'), 'test-prune', 'qa の新しい下書き', url]) assert.ok(body.includes(s), s);
});
