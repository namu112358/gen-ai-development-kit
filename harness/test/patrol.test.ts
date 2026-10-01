// Issue #370・#388：patrol が今回まわす見直しの決め方（観測の差・経過・上限・時期が来た test-prune を回すこと・勧めるだけの形の仕組み）と、状態の読み書き・記録・引数の読み取りを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObserveReport, ObserveSection } from '../lib/observe.ts';
import {
  parsePatrolArgs, parsePatrolState, PATROL_DEFAULT_MAX, PATROL_MAX_ROUNDS, PATROL_REVIEWS, recordRound, selectReviews,
  type PatrolReviewDef, type PatrolReviewName, type PatrolRound, type PatrolSelection, type PatrolState,
} from '../lib/patrol.ts';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-30T00:00:00Z');
const hoursBefore = (n: number, d: Date = NOW): string => new Date(d.getTime() - n * HOUR).toISOString();
const hoursAfter = (n: number, d: Date = NOW): Date => new Date(d.getTime() + n * HOUR);

type SectionDiff = { added: string[]; removed: string[] } | null;
const EMPTY: SectionDiff = { added: [], removed: [] };
const items = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/**
 * 観測の JSON（ObserveReport の形）。selectReviews が読むのは diff だけなので、節の中身は読めない形にしておく。
 * diff に null を渡すと前回の観測が無い（diff が無い）報告になる。節を省くと差なし（added・removed が空）。
 */
function report(diff: Partial<Record<ObserveSection, SectionDiff>> | null = {}): ObserveReport {
  const na = { available: false as const, reason: 'テストの観測' };
  const r: ObserveReport = {
    version: 1,
    generatedAt: NOW.toISOString(),
    head: 'a'.repeat(40),
    period: { days: 30, since: hoursBefore(30 * 24), until: NOW.toISOString() },
    top: 20,
    docs: na,
    hotspots: na,
    slowTests: na,
    flakyTests: na,
    mutants: na,
    notes: [],
  };
  if (diff !== null) {
    r.diff = {
      previousGeneratedAt: hoursBefore(6),
      sections: { docs: EMPTY, hotspots: EMPTY, slowTests: EMPTY, flakyTests: EMPTY, mutants: EMPTY, ...diff },
    };
  }
  return r;
}

/**
 * 見直しごとの経過（時間）から状態を作る。どれも lastRunAt。
 * suggest を true にすると test-prune だけ lastSuggestedAt にする（SUGGEST_DEFS で suggest の形を確かめるとき）
 */
function stateAgo(hours: Partial<Record<PatrolReviewName, number>>, rounds: PatrolRound[] = [], suggest = false): PatrolState {
  const reviews: PatrolState['reviews'] = {};
  if (hours['arch-review'] !== undefined) reviews['arch-review'] = { lastRunAt: hoursBefore(hours['arch-review']) };
  if (hours['qa-retro'] !== undefined) reviews['qa-retro'] = { lastRunAt: hoursBefore(hours['qa-retro']) };
  if (hours['test-prune'] !== undefined) {
    reviews['test-prune'] = suggest ? { lastSuggestedAt: hoursBefore(hours['test-prune']) } : { lastRunAt: hoursBefore(hours['test-prune']) };
  }
  return { version: 1, reviews, observe: 'patrol-observe.json', rounds };
}

/** suggest の形の仕組みを確かめるための定義（名前は今の3つのまま、test-prune だけ suggest の形） */
const SUGGEST_DEFS: PatrolReviewDef[] = PATROL_REVIEWS.map((d) => (d.name === 'test-prune' ? { ...d, mode: 'suggest' as const } : d));

/** 3つとも下限以上・上限未満の状態（差だけで決まる） */
const MIDDLE = { 'arch-review': 24, 'qa-retro': 48, 'test-prune': 48 } as const;

const reasonOf = (sel: PatrolSelection, name: PatrolReviewName) => {
  const r = sel.reasons.find((x) => x.name === name);
  assert.ok(r, `${name} の理由がありません: ${JSON.stringify(sel.reasons)}`);
  return r;
};
const skippedOf = (sel: PatrolSelection, name: PatrolReviewName) => sel.skipped.find((x) => x.name === name)?.reason;

function mustRecord(
  state: PatrolState | null, ran: string[], suggested: string[], at: Date, observe = 'patrol-observe.json', defs?: readonly PatrolReviewDef[],
): PatrolState {
  const r = defs ? recordRound(state, ran, suggested, at, observe, defs) : recordRound(state, ran, suggested, at, observe);
  assert.ok(r.ok, JSON.stringify(r));
  return r.state;
}

// --- 定数 ---

test('定数：見直しの表（形・見る節・下限・上限）と、上限の既定 2・回の記録 50 件', () => {
  assert.deepEqual(PATROL_REVIEWS.map((r) => [r.name, r.mode, r.sections, r.minHours, r.maxHours]), [
    ['arch-review', 'run', ['docs'], 12, 72],
    ['qa-retro', 'run', ['flakyTests', 'mutants'], 24, 168],
    ['test-prune', 'run', ['slowTests', 'flakyTests', 'mutants'], 24, 336],
  ]);
  assert.equal(PATROL_DEFAULT_MAX, 2);
  assert.equal(PATROL_MAX_ROUNDS, 50);
});

// --- 観測の差 ---

test('差あり：docs に増えた項目があると arch-review を diff で回し、qa-retro・test-prune は no-diff', () => {
  const sel = selectReviews(stateAgo(MIDDLE), report({ docs: { added: ['docs/a.md'], removed: [] } }), NOW, 2);
  assert.deepEqual(sel.run, ['arch-review']);
  assert.deepEqual(sel.suggest, []);
  assert.equal(reasonOf(sel, 'arch-review').reason, 'diff');
  assert.equal(reasonOf(sel, 'qa-retro').reason, 'no-diff', 'docs だけの差で qa-retro を回しています');
  assert.equal(reasonOf(sel, 'test-prune').reason, 'no-diff');
  assert.equal(skippedOf(sel, 'qa-retro'), 'no-diff');
  assert.equal(skippedOf(sel, 'test-prune'), 'no-diff');
});

test('差あり：flakyTests の消えた項目でも差として数え、qa-retro と test-prune を回す（同じ件数なら表の順）', () => {
  const sel = selectReviews(stateAgo(MIDDLE), report({ flakyTests: { added: [], removed: ['t1'] } }), NOW, 2);
  assert.deepEqual(sel.run, ['qa-retro', 'test-prune']);
  assert.deepEqual(sel.suggest, []);
  assert.equal(reasonOf(sel, 'arch-review').reason, 'no-diff');
  assert.equal(reasonOf(sel, 'qa-retro').reason, 'diff');
  assert.equal(reasonOf(sel, 'test-prune').reason, 'diff');
});

test('差あり：mutants の差で qa-retro と test-prune を回す。slowTests だけの差では qa-retro は回さず test-prune だけ回す', () => {
  const m = selectReviews(stateAgo(MIDDLE), report({ mutants: { added: ['m1'], removed: [] } }), NOW, 2);
  assert.deepEqual(m.run, ['qa-retro', 'test-prune']);
  assert.equal(reasonOf(m, 'qa-retro').reason, 'diff');
  const s = selectReviews(stateAgo(MIDDLE), report({ slowTests: { added: ['slow1'], removed: [] } }), NOW, 2);
  assert.deepEqual(s.run, ['test-prune']);
  assert.deepEqual(s.suggest, []);
  assert.equal(reasonOf(s, 'test-prune').reason, 'diff');
  assert.equal(reasonOf(s, 'qa-retro').reason, 'no-diff');
});

test('差なし：どの節にも差が無ければ、下限以上・上限未満の見直しはどれも no-diff で回さない', () => {
  const sel = selectReviews(stateAgo(MIDDLE), report(), NOW, 2);
  assert.deepEqual(sel.run, []);
  assert.deepEqual(sel.suggest, []);
  for (const name of ['arch-review', 'qa-retro', 'test-prune'] as const) {
    assert.equal(reasonOf(sel, name).reason, 'no-diff', name);
    assert.equal(skippedOf(sel, name), 'no-diff', name);
  }
});

test('対応しない節：hotspots だけの差では arch-review を回さない（どれも no-diff）', () => {
  const sel = selectReviews(stateAgo(MIDDLE), report({ hotspots: { added: items('h', 5), removed: items('g', 5) } }), NOW, 2);
  assert.deepEqual(sel.run, []);
  assert.deepEqual(sel.suggest, []);
  assert.equal(reasonOf(sel, 'arch-review').reason, 'no-diff');
});

test('読めない節：null の節は差なしとして数え、理由に「読めない」と書く', () => {
  const sel = selectReviews(stateAgo(MIDDLE), report({ docs: null, slowTests: null }), NOW, 2);
  assert.deepEqual(sel.run, []);
  assert.deepEqual(sel.suggest, []);
  const arch = reasonOf(sel, 'arch-review');
  assert.equal(arch.reason, 'no-diff');
  assert.ok(arch.detail.includes('読めない'), `arch-review の detail: ${arch.detail}`);
  const prune = reasonOf(sel, 'test-prune');
  assert.equal(prune.reason, 'no-diff');
  assert.ok(prune.detail.includes('読めない'), `test-prune の detail: ${prune.detail}`);
});

test('読めない節：null の節があっても、ほかの対応する節の差で回す', () => {
  const sel = selectReviews(stateAgo(MIDDLE), report({ flakyTests: null, mutants: { added: ['m1'], removed: [] } }), NOW, 2);
  assert.deepEqual(sel.run, ['qa-retro', 'test-prune']);
  assert.equal(reasonOf(sel, 'qa-retro').reason, 'diff');
});

test('前回の観測が無い：どれも差なしとして経過だけで決め、理由に「前回の観測が無い」と書く', () => {
  const sel = selectReviews(stateAgo(MIDDLE), report(null), NOW, 2);
  assert.deepEqual(sel.run, []);
  assert.deepEqual(sel.suggest, []);
  for (const name of ['arch-review', 'qa-retro', 'test-prune'] as const) {
    const r = reasonOf(sel, name);
    assert.equal(r.reason, 'no-diff', name);
    assert.ok(r.detail.includes('前回の観測が無い'), `${name} の detail: ${r.detail}`);
  }
  const over = selectReviews(stateAgo({ 'arch-review': 100, 'qa-retro': 48, 'test-prune': 48 }), report(null), NOW, 2);
  assert.deepEqual(over.run, ['arch-review'], '前回の観測が無くても上限を過ぎたものは回す');
  assert.equal(reasonOf(over, 'arch-review').reason, 'overdue');
});

// --- 経過の長短 ---

test('never：状態が無い・時刻が無い見直しは差が無くても回す。3つとも never で max 2 なら test-prune は limit、max 3 なら3つとも回す', () => {
  for (const state of [null, { version: 1, reviews: {}, observe: null, rounds: [] } satisfies PatrolState]) {
    const sel = selectReviews(state, report(), NOW, 2);
    assert.deepEqual(sel.run, ['arch-review', 'qa-retro'], JSON.stringify(state));
    assert.deepEqual(sel.suggest, []);
    for (const name of ['arch-review', 'qa-retro'] as const) assert.equal(reasonOf(sel, name).reason, 'never', name);
    assert.equal(reasonOf(sel, 'test-prune').reason, 'limit');
    assert.deepEqual(sel.skipped, [{ name: 'test-prune', reason: 'limit' }]);
    const all = selectReviews(state, report(), NOW, 3);
    assert.deepEqual(all.run, ['arch-review', 'qa-retro', 'test-prune'], JSON.stringify(state));
    assert.deepEqual(all.suggest, []);
    for (const name of ['arch-review', 'qa-retro', 'test-prune'] as const) assert.equal(reasonOf(all, name).reason, 'never', name);
    assert.deepEqual(all.skipped, []);
  }
});

test('never：run の形は lastRunAt で測る。lastSuggestedAt しか無い今までの状態の test-prune は never で回す', () => {
  const state: PatrolState = {
    version: 1,
    reviews: { 'arch-review': { lastSuggestedAt: hoursBefore(1) }, 'qa-retro': { lastRunAt: hoursBefore(1) }, 'test-prune': { lastSuggestedAt: hoursBefore(1) } },
    observe: null,
    rounds: [],
  };
  const sel = selectReviews(state, report(), NOW, 2);
  assert.equal(reasonOf(sel, 'arch-review').reason, 'never', 'arch-review は lastRunAt が無いので never');
  assert.equal(reasonOf(sel, 'qa-retro').reason, 'too-soon');
  assert.equal(reasonOf(sel, 'test-prune').reason, 'never', 'test-prune は lastRunAt が無いので never（lastSuggestedAt では測らない）');
  assert.deepEqual(sel.run, ['arch-review', 'test-prune']);
  assert.deepEqual(sel.suggest, []);
});

test('overdue：上限ちょうど以上たったら、差が無くても回す', () => {
  const sel = selectReviews(stateAgo({ 'arch-review': 72, 'qa-retro': 168, 'test-prune': 336 }), report(), NOW, 3);
  assert.deepEqual(sel.run, ['arch-review', 'qa-retro', 'test-prune']);
  assert.deepEqual(sel.suggest, []);
  for (const name of ['arch-review', 'qa-retro', 'test-prune'] as const) assert.equal(reasonOf(sel, name).reason, 'overdue', name);
});

test('上限の直前は overdue にならない（差が無ければ no-diff）', () => {
  const sel = selectReviews(stateAgo({ 'arch-review': 71.9, 'qa-retro': 167.9, 'test-prune': 335.9 }), report(), NOW, 2);
  assert.deepEqual(sel.run, []);
  assert.deepEqual(sel.suggest, []);
  for (const name of ['arch-review', 'qa-retro', 'test-prune'] as const) assert.equal(reasonOf(sel, name).reason, 'no-diff', name);
});

test('too-soon：下限未満なら、対応する節に差があっても回さない', () => {
  const diff = report({ docs: { added: ['d1'], removed: [] }, flakyTests: { added: ['f1'], removed: [] }, slowTests: { added: ['s1'], removed: [] } });
  const sel = selectReviews(stateAgo({ 'arch-review': 11.9, 'qa-retro': 23.9, 'test-prune': 23.9 }), diff, NOW, 2);
  assert.deepEqual(sel.run, []);
  assert.deepEqual(sel.suggest, []);
  for (const name of ['arch-review', 'qa-retro', 'test-prune'] as const) {
    assert.equal(reasonOf(sel, name).reason, 'too-soon', name);
    assert.equal(skippedOf(sel, name), 'too-soon', name);
  }
});

test('下限ちょうどは too-soon でなく、差があれば diff で回す', () => {
  const diff = report({ docs: { added: ['d1'], removed: [] }, flakyTests: { added: ['f1'], removed: [] } });
  const sel = selectReviews(stateAgo({ 'arch-review': 12, 'qa-retro': 24, 'test-prune': 24 }), diff, NOW, 3);
  assert.deepEqual(sel.run, ['arch-review', 'qa-retro', 'test-prune']);
  assert.deepEqual(sel.suggest, []);
  for (const name of ['arch-review', 'qa-retro', 'test-prune'] as const) assert.equal(reasonOf(sel, name).reason, 'diff', name);
});

test('reasons は見直しごとに表の順で3件', () => {
  const sel = selectReviews(stateAgo(MIDDLE), report(), NOW, 2);
  assert.deepEqual(sel.reasons.map((r) => [r.name, r.mode]), [['arch-review', 'run'], ['qa-retro', 'run'], ['test-prune', 'run']]);
  for (const r of sel.reasons) assert.equal(typeof r.detail, 'string');
});

// --- 上限（max） ---

test('上限：max=1 では never が overdue より先に選ばれ、残りは limit', () => {
  const sel = selectReviews(stateAgo({ 'arch-review': 100, 'test-prune': 48 }), report(), NOW, 1);
  assert.deepEqual(sel.run, ['qa-retro'], 'qa-retro は never');
  assert.equal(skippedOf(sel, 'arch-review'), 'limit');
  assert.equal(reasonOf(sel, 'arch-review').reason, 'limit');
  assert.equal(reasonOf(sel, 'qa-retro').reason, 'never');
});

test('上限：max=1 では overdue が diff より先に選ばれ、残りは limit', () => {
  const sel = selectReviews(stateAgo({ 'arch-review': 24, 'qa-retro': 200, 'test-prune': 48 }), report({ docs: { added: items('d', 10), removed: [] } }), NOW, 1);
  assert.deepEqual(sel.run, ['qa-retro']);
  assert.equal(skippedOf(sel, 'arch-review'), 'limit');
  assert.equal(reasonOf(sel, 'arch-review').reason, 'limit');
  assert.equal(reasonOf(sel, 'qa-retro').reason, 'overdue');
});

test('上限：max=2 なら両方を never → overdue → diff の順で回す', () => {
  const a = selectReviews(stateAgo({ 'arch-review': 100, 'test-prune': 48 }), report(), NOW, 2);
  assert.deepEqual(a.run, ['qa-retro', 'arch-review']);
  assert.equal(skippedOf(a, 'arch-review'), undefined);
  const b = selectReviews(stateAgo({ 'arch-review': 24, 'qa-retro': 200, 'test-prune': 48 }), report({ docs: { added: ['d1'], removed: [] } }), NOW, 2);
  assert.deepEqual(b.run, ['qa-retro', 'arch-review']);
  assert.equal(reasonOf(b, 'arch-review').reason, 'diff');
});

test('上限：overdue 同士は上限を超えた時間の長い順', () => {
  // arch-review は 72 時間を 10 時間超え、qa-retro は 168 時間を 30 時間超え
  const a = selectReviews(stateAgo({ 'arch-review': 82, 'qa-retro': 198, 'test-prune': 48 }), report(), NOW, 2);
  assert.deepEqual(a.run, ['qa-retro', 'arch-review']);
  assert.deepEqual(selectReviews(stateAgo({ 'arch-review': 82, 'qa-retro': 198, 'test-prune': 48 }), report(), NOW, 1).run, ['qa-retro']);
  // arch-review は 50 時間超え、qa-retro は 1 時間超え（経過の長さではなく超えた時間で比べる）
  const b = selectReviews(stateAgo({ 'arch-review': 122, 'qa-retro': 169, 'test-prune': 48 }), report(), NOW, 2);
  assert.deepEqual(b.run, ['arch-review', 'qa-retro']);
  assert.deepEqual(selectReviews(stateAgo({ 'arch-review': 122, 'qa-retro': 169, 'test-prune': 48 }), report(), NOW, 1).run, ['arch-review']);
  // test-prune も overdue なら同じ比べ方で並ぶ（336 時間を 40 時間超え）
  const c = selectReviews(stateAgo({ 'arch-review': 82, 'qa-retro': 198, 'test-prune': 376 }), report(), NOW, 2);
  assert.deepEqual(c.run, ['test-prune', 'qa-retro']);
  assert.equal(skippedOf(c, 'arch-review'), 'limit');
});

test('上限：diff 同士は差の件数（added と removed の合計）の多い順、同じなら表の順', () => {
  const s = stateAgo(MIDDLE);
  const archMore = report({ docs: { added: items('d', 2), removed: ['x'] }, flakyTests: { added: ['f1'], removed: [] }, mutants: { added: [], removed: ['m1'] } });
  assert.deepEqual(selectReviews(s, archMore, NOW, 2).run, ['arch-review', 'qa-retro'], 'arch-review 3 件・qa-retro 2 件・test-prune 2 件');
  assert.deepEqual(selectReviews(s, archMore, NOW, 1).run, ['arch-review']);
  const qaMore = report({ docs: { added: ['d1'], removed: [] }, flakyTests: { added: ['f1', 'f2'], removed: [] }, mutants: { added: [], removed: ['m1'] } });
  assert.deepEqual(selectReviews(s, qaMore, NOW, 3).run, ['qa-retro', 'test-prune', 'arch-review'], 'arch-review 1 件・qa-retro 3 件・test-prune 3 件');
  assert.deepEqual(selectReviews(s, qaMore, NOW, 2).run, ['qa-retro', 'test-prune']);
  const one = selectReviews(s, qaMore, NOW, 1);
  assert.deepEqual(one.run, ['qa-retro']);
  assert.equal(skippedOf(one, 'arch-review'), 'limit');
  const pruneMore = report({ slowTests: { added: ['s1'], removed: [] }, flakyTests: { added: ['f1'], removed: [] } });
  assert.deepEqual(selectReviews(s, pruneMore, NOW, 1).run, ['test-prune'], 'qa-retro 1 件・test-prune 2 件');
  const tie = report({ docs: { added: ['d1', 'd2'], removed: [] }, flakyTests: { added: ['f1', 'f2'], removed: [] } });
  assert.deepEqual(selectReviews(s, tie, NOW, 2).run, ['arch-review', 'qa-retro'], '同じ件数なら表の順');
  assert.deepEqual(selectReviews(s, tie, NOW, 1).run, ['arch-review']);
});

// --- 時期が来た test-prune を回す（run の形） ---

test('test-prune：lastRunAt から上限（336 時間）以上なら、差が無くても overdue で回す', () => {
  const sel = selectReviews(stateAgo({ 'arch-review': 24, 'qa-retro': 48, 'test-prune': 336 }), report(), NOW, PATROL_DEFAULT_MAX);
  assert.deepEqual(sel.run, ['test-prune']);
  assert.deepEqual(sel.suggest, []);
  assert.equal(reasonOf(sel, 'test-prune').reason, 'overdue');
  assert.equal(reasonOf(sel, 'test-prune').mode, 'run');
});

test('test-prune：下限（24 時間）以上で slowTests の差があれば diff で回し、下限未満なら差があっても too-soon', () => {
  const diff = report({ slowTests: { added: ['s1'], removed: [] } });
  const ok = selectReviews(stateAgo({ 'arch-review': 24, 'qa-retro': 48, 'test-prune': 24 }), diff, NOW, PATROL_DEFAULT_MAX);
  assert.deepEqual(ok.run, ['test-prune']);
  assert.equal(reasonOf(ok, 'test-prune').reason, 'diff');
  const soon = selectReviews(stateAgo({ 'arch-review': 24, 'qa-retro': 48, 'test-prune': 23 }), diff, NOW, PATROL_DEFAULT_MAX);
  assert.deepEqual(soon.run, []);
  assert.equal(reasonOf(soon, 'test-prune').reason, 'too-soon');
  assert.equal(skippedOf(soon, 'test-prune'), 'too-soon');
});

test('test-prune：run の形なので max の枠を使い、枠を超えたら limit', () => {
  const sel = selectReviews(stateAgo({ 'arch-review': 100, 'qa-retro': 48, 'test-prune': 400 }), report(), NOW, 1);
  assert.deepEqual(sel.run, ['test-prune'], '上限を超えた時間は test-prune（64 時間）が arch-review（28 時間）より長い');
  assert.equal(skippedOf(sel, 'arch-review'), 'limit');
  const lower = selectReviews(stateAgo({ 'arch-review': 200, 'qa-retro': 48, 'test-prune': 340 }), report(), NOW, 1);
  assert.deepEqual(lower.run, ['arch-review']);
  assert.equal(skippedOf(lower, 'test-prune'), 'limit');
});

// --- suggest の形の仕組み（test-prune だけ suggest にした定義を渡す） ---

test('suggest：suggest の形は選ばれても run に入らず suggest に入り、max=1 でも run の枠を押し出さない', () => {
  const sel = selectReviews(null, report(), NOW, 1, SUGGEST_DEFS);
  assert.deepEqual(sel.run, ['arch-review'], 'never 同士は表の順');
  assert.deepEqual(sel.suggest, ['test-prune']);
  assert.ok(!sel.run.includes('test-prune'));
  assert.equal(skippedOf(sel, 'qa-retro'), 'limit');
  assert.equal(skippedOf(sel, 'test-prune'), undefined, 'test-prune が limit で落ちています');
  assert.equal(reasonOf(sel, 'test-prune').mode, 'suggest');
  const withDiff = selectReviews(stateAgo(MIDDLE, [], true), report({ flakyTests: { added: ['f1'], removed: [] } }), NOW, 1, SUGGEST_DEFS);
  assert.deepEqual(withDiff.run, ['qa-retro']);
  assert.deepEqual(withDiff.suggest, ['test-prune']);
});

test('suggest：suggest の形は lastSuggestedAt で測る（lastRunAt しか無ければ never）', () => {
  const state: PatrolState = { version: 1, reviews: { 'test-prune': { lastRunAt: hoursBefore(1) } }, observe: null, rounds: [] };
  const sel = selectReviews(state, report(), NOW, 2, SUGGEST_DEFS);
  assert.equal(reasonOf(sel, 'test-prune').reason, 'never');
  assert.deepEqual(sel.suggest, ['test-prune']);
});

test('suggest：lastSuggestedAt から下限未満は勧めず、上限以上は差が無くても勧める', () => {
  const soon = selectReviews(stateAgo({ 'arch-review': 24, 'qa-retro': 48, 'test-prune': 23 }, [], true), report({ slowTests: { added: ['s1'], removed: [] } }), NOW, 2, SUGGEST_DEFS);
  assert.deepEqual(soon.suggest, []);
  assert.equal(reasonOf(soon, 'test-prune').reason, 'too-soon');
  const over = selectReviews(stateAgo({ 'arch-review': 24, 'qa-retro': 48, 'test-prune': 336 }, [], true), report(), NOW, 2, SUGGEST_DEFS);
  assert.deepEqual(over.suggest, ['test-prune']);
  assert.deepEqual(over.run, []);
  assert.equal(reasonOf(over, 'test-prune').reason, 'overdue');
});

// --- recordRound ---

test('recordRound：状態が無ければ作り、回した見直し（test-prune も）の lastRunAt・観測の写し・回を記録する', () => {
  const s = mustRecord(null, ['arch-review', 'qa-retro', 'test-prune'], [], NOW, 'patrol-observe.json');
  assert.equal(s.version, 1);
  assert.equal(s.observe, 'patrol-observe.json');
  assert.deepEqual(s.reviews, {
    'arch-review': { lastRunAt: NOW.toISOString() },
    'qa-retro': { lastRunAt: NOW.toISOString() },
    'test-prune': { lastRunAt: NOW.toISOString() },
  });
  assert.deepEqual(s.rounds, [{ at: NOW.toISOString(), ran: ['arch-review', 'qa-retro', 'test-prune'], suggested: [] }]);
});

test('recordRound：suggest の形の定義では、勧めた見直しの lastSuggestedAt を記録する', () => {
  const s = mustRecord(null, ['arch-review', 'qa-retro'], ['test-prune'], NOW, 'patrol-observe.json', SUGGEST_DEFS);
  assert.deepEqual(s.reviews, {
    'arch-review': { lastRunAt: NOW.toISOString() },
    'qa-retro': { lastRunAt: NOW.toISOString() },
    'test-prune': { lastSuggestedAt: NOW.toISOString() },
  });
  assert.deepEqual(s.rounds, [{ at: NOW.toISOString(), ran: ['arch-review', 'qa-retro'], suggested: ['test-prune'] }]);
});

test('recordRound：今までの状態（test-prune に lastSuggestedAt）で ran に test-prune を渡すと lastRunAt が入り、次は lastRunAt で測る', () => {
  const old: PatrolState = { version: 1, reviews: { 'test-prune': { lastSuggestedAt: hoursBefore(100) } }, observe: null, rounds: [] };
  const s = mustRecord(old, ['test-prune'], [], NOW);
  assert.equal(s.reviews['test-prune']?.lastRunAt, NOW.toISOString());
  assert.equal(reasonOf(selectReviews(s, report({ slowTests: { added: ['s1'], removed: [] } }), hoursAfter(1), 2), 'test-prune').reason, 'too-soon');
});

test('recordRound：回したものが無くても、観測の写しと回の時刻は更新する', () => {
  const before = stateAgo(MIDDLE);
  const s = mustRecord(before, [], [], NOW, 'next.json');
  assert.equal(s.observe, 'next.json');
  assert.deepEqual(s.reviews, before.reviews);
  assert.deepEqual(s.rounds, [{ at: NOW.toISOString(), ran: [], suggested: [] }]);
});

test('recordRound：suggested では lastSuggestedAt だけが変わり、ほかの見直しの時刻は変わらない（suggest の形の定義）', () => {
  const before = stateAgo(MIDDLE, [], true);
  const s = mustRecord(before, [], ['test-prune'], NOW, 'patrol-observe.json', SUGGEST_DEFS);
  assert.deepEqual(s.reviews['test-prune'], { lastSuggestedAt: NOW.toISOString() }, 'lastRunAt を書いていないこと');
  assert.deepEqual(s.reviews['arch-review'], before.reviews['arch-review']);
  assert.deepEqual(s.reviews['qa-retro'], before.reviews['qa-retro']);
});

test('recordRound：ran に suggest の形・suggested に run の形・知らない名前・重複は誤りで、元の状態は変えない', () => {
  const state = stateAgo(MIDDLE);
  const before = structuredClone(state);
  const cases: [string[], string[], string][] = [
    [[], ['test-prune'], '--suggested test-prune（既定の定義では run の形）'],
    [[], ['arch-review'], '--suggested arch-review'],
    [[], ['qa-retro'], '--suggested qa-retro'],
    [['patrol'], [], '知らない名前（ran）'],
    [[], ['unknown'], '知らない名前（suggested）'],
    [['qa-retro', 'qa-retro'], [], '重複（ran）'],
    [['test-prune', 'test-prune'], [], '重複（ran の test-prune）'],
  ];
  for (const [ran, suggested, label] of cases) {
    const r = recordRound(state, ran, suggested, NOW, 'x.json');
    assert.equal(r.ok, false, label);
    assert.ok(!r.ok && r.errors.length > 0, label);
  }
  // suggest の形の定義では、ran の test-prune と suggested の重複が誤り
  const suggestCases: [string[], string[], string][] = [
    [['test-prune'], [], '--ran test-prune（suggest の形）'],
    [[], ['test-prune', 'test-prune'], '重複（suggested）'],
  ];
  for (const [ran, suggested, label] of suggestCases) {
    const r = recordRound(state, ran, suggested, NOW, 'x.json', SUGGEST_DEFS);
    assert.equal(r.ok, false, label);
    assert.ok(!r.ok && r.errors.length > 0, label);
  }
  assert.deepEqual(state, before);
});

test('recordRound：成功しても元の状態は変えず、新しい状態を返す', () => {
  const state = stateAgo(MIDDLE);
  const before = structuredClone(state);
  const s = mustRecord(state, ['arch-review'], [], NOW);
  assert.deepEqual(state, before);
  assert.notEqual(s, state);
  assert.equal(s.reviews['arch-review']?.lastRunAt, NOW.toISOString());
});

test('recordRound：rounds は直近 50 件に切る', () => {
  const old: PatrolRound[] = Array.from({ length: PATROL_MAX_ROUNDS }, (_, i) => ({ at: hoursBefore(1000 - i), ran: [], suggested: [] }));
  const s = mustRecord(stateAgo(MIDDLE, old), ['arch-review'], [], NOW);
  assert.equal(s.rounds.length, PATROL_MAX_ROUNDS);
  assert.deepEqual(s.rounds[0], old[1], '最も古い回が落ちていません');
  assert.deepEqual(s.rounds.at(-1), { at: NOW.toISOString(), ran: ['arch-review'], suggested: [] });
});

// --- 2回分（/loop の1回目と2回目） ---

test('2回分：1回目は初回で全部選び（max 3）、記録した後の同じ時刻の2回目はどれも too-soon で回さない', () => {
  const sel1 = selectReviews(null, report(null), NOW, 3);
  assert.deepEqual(sel1.run, ['arch-review', 'qa-retro', 'test-prune']);
  assert.deepEqual(sel1.suggest, []);
  const s1 = mustRecord(null, sel1.run, sel1.suggest, NOW);
  assert.equal(s1.reviews['test-prune']?.lastRunAt, NOW.toISOString(), 'ran の test-prune が lastRunAt を書いていません');
  // 状態のファイルに書いて読み戻した形で2回目を決める
  const read = parsePatrolState(JSON.stringify(s1, null, 2));
  assert.ok(read.ok, JSON.stringify(read));
  const sel2 = selectReviews(
    read.state,
    report({ docs: { added: ['d1'], removed: [] }, flakyTests: { added: ['f1'], removed: [] }, slowTests: { added: ['s1'], removed: [] } }),
    NOW,
    PATROL_DEFAULT_MAX,
  );
  assert.deepEqual(sel2.run, []);
  assert.deepEqual(sel2.suggest, []);
  for (const name of ['arch-review', 'qa-retro', 'test-prune'] as const) assert.equal(reasonOf(sel2, name).reason, 'too-soon', name);
});

test('2回分：既定の max 2 で1回目に limit になった test-prune は、2回目に never で回る', () => {
  const sel1 = selectReviews(null, report(null), NOW, PATROL_DEFAULT_MAX);
  assert.deepEqual(sel1.run, ['arch-review', 'qa-retro']);
  assert.equal(skippedOf(sel1, 'test-prune'), 'limit');
  const s1 = mustRecord(null, sel1.run, sel1.suggest, NOW);
  const read = parsePatrolState(JSON.stringify(s1, null, 2));
  assert.ok(read.ok, JSON.stringify(read));
  const sel2 = selectReviews(read.state, report(), hoursAfter(1), PATROL_DEFAULT_MAX);
  assert.deepEqual(sel2.run, ['test-prune']);
  assert.equal(reasonOf(sel2, 'test-prune').reason, 'never');
  assert.equal(reasonOf(sel2, 'arch-review').reason, 'too-soon');
  const s2 = mustRecord(read.state, sel2.run, sel2.suggest, hoursAfter(1));
  assert.equal(s2.reviews['test-prune']?.lastRunAt, hoursAfter(1).toISOString());
  assert.deepEqual(s2.rounds.map((r) => r.ran), [['arch-review', 'qa-retro'], ['test-prune']]);
});

test('2回分：2回目は観測の差と経過に応じて回す見直しを変える', () => {
  const sel1 = selectReviews(null, report(null), NOW, 3);
  const s1 = mustRecord(null, sel1.run, sel1.suggest, NOW);
  const docsDiff = report({ docs: { added: ['d1'], removed: [] } });
  // 13 時間後：arch-review は下限（12 時間）を過ぎ docs に差があるので回す。qa-retro・test-prune はまだ下限（24 時間）未満
  const at13 = selectReviews(s1, docsDiff, hoursAfter(13), PATROL_DEFAULT_MAX);
  assert.deepEqual(at13.run, ['arch-review']);
  assert.equal(reasonOf(at13, 'arch-review').reason, 'diff');
  assert.equal(reasonOf(at13, 'qa-retro').reason, 'too-soon');
  assert.equal(reasonOf(at13, 'test-prune').reason, 'too-soon');
  // 13 時間後でも差が無ければ回さない
  const at13NoDiff = selectReviews(s1, report(), hoursAfter(13), PATROL_DEFAULT_MAX);
  assert.deepEqual(at13NoDiff.run, []);
  assert.equal(reasonOf(at13NoDiff, 'arch-review').reason, 'no-diff');
  // 25 時間後：flakyTests の差で qa-retro と test-prune を回す。arch-review は docs に差が無いので回さない
  const at25 = selectReviews(s1, report({ flakyTests: { added: ['f1'], removed: [] } }), hoursAfter(25), PATROL_DEFAULT_MAX);
  assert.deepEqual(at25.run, ['qa-retro', 'test-prune']);
  assert.deepEqual(at25.suggest, []);
  assert.equal(reasonOf(at25, 'arch-review').reason, 'no-diff');
});

// --- parsePatrolState ---

test('parsePatrolState：ファイルが無ければ（null）状態無しとして読む', () => {
  assert.deepEqual(parsePatrolState(null), { ok: true, state: null });
});

test('parsePatrolState：recordRound が作った状態を JSON にして読み戻せる', () => {
  const s = mustRecord(mustRecord(null, ['arch-review', 'qa-retro', 'test-prune'], [], NOW), ['arch-review'], [], hoursAfter(13));
  const r = parsePatrolState(JSON.stringify(s));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.state, s);
  // suggest の形で記録した今までの状態（lastSuggestedAt・suggested）も読める
  const old = mustRecord(null, ['arch-review'], ['test-prune'], NOW, 'patrol-observe.json', SUGGEST_DEFS);
  const o = parsePatrolState(JSON.stringify(old));
  assert.ok(o.ok, JSON.stringify(o));
  assert.deepEqual(o.state, old);
});

test('parsePatrolState：壊れた JSON・version が 1 でない・形の誤りは誤りとして読む', () => {
  const good = { version: 1, reviews: {}, observe: null, rounds: [] };
  for (const text of [
    '{',
    '',
    JSON.stringify([]),
    JSON.stringify(null),
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ reviews: {}, observe: null, rounds: [] }),
    JSON.stringify({ ...good, reviews: 'x' }),
    JSON.stringify({ ...good, observe: 1 }),
    JSON.stringify({ ...good, rounds: {} }),
    JSON.stringify({ ...good, rounds: [{ at: 1, ran: [], suggested: [] }] }),
    JSON.stringify({ ...good, reviews: { 'arch-review': { lastRunAt: 1 } } }),
  ]) {
    const r = parsePatrolState(text);
    assert.equal(r.ok, false, text);
    assert.ok(!r.ok && r.errors.length > 0, text);
  }
});

// --- parsePatrolArgs ---

test('parsePatrolArgs：既定値（max 2・state なし・ran と suggested は空）', () => {
  const r = parsePatrolArgs(['select', 'observe.json']);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.sub, 'select');
  assert.deepEqual(r.positional, ['observe.json']);
  assert.equal(r.max, PATROL_DEFAULT_MAX);
  assert.equal(r.state, null);
  assert.deepEqual(r.ran, []);
  assert.deepEqual(r.suggested, []);
  const p = parsePatrolArgs(['previous']);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.sub, 'previous');
  assert.deepEqual(p.positional, []);
});

test('parsePatrolArgs：--max・--state・繰り返しの --ran・--suggested を読む', () => {
  const r = parsePatrolArgs(['record', 'observe.json', '--ran', 'arch-review', '--state', '/tmp/p.json', '--ran', 'qa-retro', '--suggested', 'test-prune', '--max', '3']);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.sub, 'record');
  assert.deepEqual(r.positional, ['observe.json']);
  assert.equal(r.max, 3);
  assert.equal(r.state, '/tmp/p.json');
  assert.deepEqual(r.ran, ['arch-review', 'qa-retro']);
  assert.deepEqual(r.suggested, ['test-prune']);
});

test('parsePatrolArgs：--max が正の整数でない・値が無い・--state が2回・知らない引数は誤り', () => {
  for (const args of [
    ['select', 'o.json', '--max', '0'],
    ['select', 'o.json', '--max', '-1'],
    ['select', 'o.json', '--max', 'abc'],
    ['select', 'o.json', '--max', '1.5'],
    ['select', 'o.json', '--max'],
    ['select', 'o.json', '--state'],
    ['select', 'o.json', '--state', 'a.json', '--state', 'b.json'],
    ['record', 'o.json', '--ran'],
    ['record', 'o.json', '--suggested'],
    ['select', 'o.json', '--dry-run'],
    ['select', 'o.json', '--unknown', 'x'],
  ]) {
    const r = parsePatrolArgs(args);
    assert.equal(r.ok, false, args.join(' '));
    assert.ok(!r.ok && r.errors.length > 0, args.join(' '));
  }
});
