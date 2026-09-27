import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue, type FleetPr } from '../lib/fleet.ts';
import type { IssueFacts, PrFacts } from '../lib/queue.ts';

const root = join(import.meta.dirname, '..', '..');
const config = { ...loadConfig(), areaConcurrency: { harness: 2 } };

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const issueFacts = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null, ...patch,
});
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  issueFacts(n, { labels: ['agent:ready', 'agent:plan-ok'], gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, ...patch });
const prFacts = (n: number, patch: Partial<PrFacts> = {}): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue: 1, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0, ...patch,
});
const openPr = (n: number, patch: Partial<FleetPr> = {}, facts: Partial<PrFacts> = {}): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, facts), ...patch,
});
const mergedPr = (n: number): FleetPr => ({ number: n, merged: true, draft: false, autoMerge: false, humanReview: false, behindMain: false, facts: null });
const fi = (facts: IssueFacts, planFiles: string[] | null = null, prs: FleetPr[] = [], closed = false): FleetIssue => ({ facts, closed, planFiles, prs });
const facts = (issues: FleetIssue[], prConflicts: FleetFacts['prConflicts'] = []): FleetFacts => ({ issues, prConflicts });
const one = (i: FleetIssue, extra: FleetIssue[] = []) => fleetStatus(facts([i, ...extra]))[0]!;
const select = (f: FleetFacts, max: number | null = null) => selectFleet(config, f, fleetStatus(f), max);

test('段階：計画なし → 計画ゲート待ち → plan-review / plan-ok（実装待ち）', () => {
  assert.deepEqual([one(fi(issueFacts(1))).stage, one(fi(issueFacts(1))).next], ['no-plan', 'plan']);
  assert.deepEqual([one(fi(issueFacts(1, { latestPlanAt: '2026-09-26T01:00:00Z' }))).stage, one(fi(issueFacts(1, { latestPlanAt: '2026-09-26T01:00:00Z' }))).next], ['plan-gate', 'none']);
  assert.equal(one(fi(issueFacts(1, { labels: ['agent:ready', 'agent:plan-review'], gate: { ...gatePass, pass: false }, latestPlanAt: '2026-09-26T01:00:00Z' }))).stage, 'plan-review');
  assert.equal(one(fi(issueFacts(1, { gate: { ...gatePass, pass: false }, latestPlanAt: '2026-09-26T01:00:00Z' }))).stage, 'plan-review');
  const ok = one(fi(planOk(1)));
  assert.deepEqual([ok.stage, ok.next], ['plan-ok', 'implement']);
  assert.equal(one(fi(planOk(1, { planOkByApp: false }))).next, 'none', '本人名義で付けた plan-ok は信頼しない');
});

test('段階：判定待ち → 修正待ち → Ready・人の Merge 待ち / 自動 Merge 待ち', () => {
  const judge = one(fi(planOk(1), ['a'], [openPr(10)]));
  assert.deepEqual([judge.stage, judge.next, judge.pr], ['judge', 'judge', 10]);
  assert.deepEqual([one(fi(planOk(1), null, [openPr(10, {}, { verdictAwaitingGate: true })])).next], ['none'], '受け付け待ち');
  const fix = one(fi(planOk(1), null, [openPr(10, {}, { acceptance: { reviewPass: false, at: 'x' } })]));
  assert.deepEqual([fix.stage, fix.next], ['fix', 'fix']);
  assert.equal(one(fi(planOk(1), null, [openPr(10, {}, { humanFeedbackSincePush: 1 })])).next, 'fix', '人のレビュー');
  const pass = { acceptance: { reviewPass: true, at: 'x' } };
  assert.equal(one(fi(planOk(1), null, [openPr(10, { draft: false, humanReview: true }, pass)])).stage, 'human-merge');
  assert.equal(one(fi(planOk(1), null, [openPr(10, { draft: false, autoMerge: true }, pass)])).stage, 'auto-merge');
  const waiting = one(fi(planOk(1), null, [openPr(10, { draft: false }, pass)]));
  assert.deepEqual([waiting.stage, waiting.next], ['judge', 'none'], '合格したが App の Merge 経路がまだ');
  assert.equal(one(fi(planOk(1), null, [openPr(10, {}, { conflicted: true })])).next, 'sync', '衝突');
  assert.equal(one(fi(planOk(1), null, [openPr(10, {}, { acceptance: { reviewPass: false, at: 'x' }, agent: false })])).next, 'none', '人の PR は人が直す');
});

test('段階：Merge 済みと止まる印', () => {
  assert.equal(one(fi(planOk(1), null, [mergedPr(10)], true)).stage, 'merged');
  assert.equal(one(fi(planOk(1), null, [], true)).stage, 'merged');
  for (const l of ['agent:hold', 'agent:blocked', 'agent:waiting']) assert.equal(one(fi(planOk(1, { labels: ['agent:ready', 'agent:plan-ok', l] }))).stage, 'stopped', l);
  assert.equal(one(fi(planOk(1), null, [openPr(10, {}, { labels: ['agent:hold'] })])).stage, 'stopped', 'PR の hold');
  assert.equal(one(fi(planOk(1, { openBlockers: [7] }))).stage, 'stopped', '依存');
  assert.equal(one(fi(issueFacts(1, { labels: ['epic'] }))).stage, 'stopped', 'Epic');
});

test('Merge 済みの Issue があれば、main に追従していない残りの PR の次にやることは sync', () => {
  const rest = fi(planOk(2), null, [openPr(20, { draft: false, humanReview: true, behindMain: true }, { acceptance: { reviewPass: true, at: 'x' } })]);
  const current = fi(planOk(3), null, [openPr(30, { behindMain: false })]);
  const rows = fleetStatus(facts([fi(planOk(1), null, [mergedPr(10)], true), rest, current]));
  assert.equal(rows[1]!.next, 'sync');
  assert.equal(rows[1]!.stage, 'human-merge');
  assert.equal(rows[2]!.next, 'judge', '追従済みの PR は sync しない');
  assert.equal(fleetStatus(facts([rest]))[0]!.next, 'none', 'Merge 済みが無ければ main が進んでも sync しない');
});

test('選び方：止まる印・依存・着手宣言・Merge 済みの Issue は選ばない', () => {
  const f = facts([
    fi(planOk(1, { labels: ['agent:ready', 'agent:plan-ok', 'agent:hold'] })),
    fi(planOk(2, { openBlockers: [9] })),
    fi(planOk(3, { claim: { by: 'manual', at: '2026-09-26T00:00:00Z' } })),
    fi(planOk(4), null, [mergedPr(40)], true),
    fi(planOk(5)),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [5]);
  assert.match(s.excluded.get(3)!, /着手宣言/);
  assert.match(s.excluded.get(4)!, /Merge 済み/);
});

test('選び方：優先度の順に、人が1回にさばける数（max）まで選ぶ。PR のある Issue を先にする', () => {
  const f = facts([
    fi(planOk(1, { labels: ['agent:ready', 'agent:plan-ok', 'priority:low'] })),
    fi(planOk(2, { labels: ['agent:ready', 'agent:plan-ok', 'priority:highest'] })),
    fi(planOk(3)),
    fi(planOk(4, { labels: ['agent:ready', 'agent:plan-ok', 'priority:high'] })),
    fi(planOk(5, { labels: ['agent:ready', 'agent:plan-ok', 'priority:lowest'] }), null, [openPr(50)]),
  ]);
  assert.deepEqual(select(f, 3).selected, [5, 2, 4]);
  assert.deepEqual(select(f, 5).selected, [5, 2, 4, 3, 1]);
  assert.deepEqual(select(f, 1).selected, [5]);
  assert.match(select(f, 1).excluded.get(2)!, /さばける数（1）/);
});

test('選び方：同じ領域の候補が領域の上限を超えても、領域の上限では除外しない', () => {
  const f = facts([
    fi(planOk(1), ['harness/lib/a.ts']),
    fi(planOk(2), ['harness/lib/b.ts']),
    fi(planOk(3), ['harness/lib/c.ts']),
    fi(planOk(4), ['docs/x.md']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2, 3, 4], 'area:harness の上限 2 は fleet では見ない');
  assert.equal(s.excluded.size, 0);
});

test('選び方：計画の files が既に選んだ Issue や PR 段階の Issue と重なれば選ばず、重なりを表示する', () => {
  const f = facts([
    fi(planOk(1), ['harness/lib/fleet.ts']),
    fi(planOk(2), ['harness/lib/*.ts']),
    fi(planOk(3), ['docs/a.md']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 3]);
  assert.match(s.excluded.get(2)!, /#1 と触るファイルが重なるため待つ/);
  assert.deepEqual(s.overlaps.get(1), [2]);
  assert.deepEqual(s.overlaps.get(2), [1]);

  // PR 段階の Issue（優先度が低くても先）と重なる新しい Issue は待つ
  const pr = facts([
    fi(planOk(4, { labels: ['agent:ready', 'agent:plan-ok', 'priority:highest'] }), ['docs/a.md']),
    fi(planOk(5, { labels: ['agent:ready', 'agent:plan-ok', 'priority:lowest'] }), ['docs/**'], [openPr(50)]),
  ]);
  assert.deepEqual(select(pr).selected, [5]);
  assert.match(select(pr).excluded.get(4)!, /#5/);
  // 止まっていても PR のある Issue とは重ならないようにする
  const stopped = facts([fi(planOk(6), ['docs/a.md']), fi(planOk(7, { labels: ['agent:ready', 'agent:hold'] }), ['docs/a.md'], [openPr(70)])]);
  assert.deepEqual(select(stopped).selected, []);
});

test('選び方：計画の無い Issue は重なりの判定から外して選び、計画の後に重なれば後から選んだほうが待つ', () => {
  const before = facts([fi(planOk(1), ['harness/lib/fleet.ts']), fi(issueFacts(2))]);
  assert.deepEqual(select(before).selected, [1, 2]);
  const after = facts([fi(planOk(1), ['harness/lib/fleet.ts']), fi(planOk(2), ['harness/lib/fleet.ts'])]);
  const s = select(after);
  assert.deepEqual(s.selected, [1]);
  assert.match(s.excluded.get(2)!, /重なるため待つ/);
  const t = renderFleetStatus(fleetStatus(after), s, 3);
  assert.match(t, /\| #2 t2 \| — \| plan-ok（実装待ち） \| implement \| 待つ：#1 と触るファイルが重なるため待つ \| #1 \|/);
});

test('表：Issue・PR ごとの段階・次にやること・重なりを1つにまとめる（領域の表は出さない）', () => {
  const f = facts([fi(planOk(1), ['harness/lib/a.ts'], [openPr(10)]), fi(issueFacts(2))]);
  const t = renderFleetStatus(fleetStatus(f), select(f), null);
  assert.match(t, /\| #1 t1 \| #10 \| 判定待ち \| judge \| 選ぶ \|/);
  assert.match(t, /\| #2 t2 \| — \| 計画なし \| plan \| 選ぶ \|/);
  assert.match(t, /選んだ数：2（/);
  assert.doesNotMatch(t, /area:harness/);
});

test('CLAUDE.md が fleet を案内する', () => {
  const text = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(text.includes('(.claude/skills/fleet/SKILL.md)'), 'fleet への案内がありません');
  assert.match(text.split('\n').find((l) => l.startsWith('| `.claude/skills/` |')) ?? '', /fleet/);
});
