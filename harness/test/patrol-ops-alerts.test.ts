// Issue #692：patrol.ts select の知らせ（alerts・alertsNote）を確かめる。運用の健康（opsHealth）のうち超えた項目と前回から値が増えた項目が
// alerts に出ること、opsHealth の有無で見直しの選び方（run・suggest・skipped・reasons）が変わらないこと、形の違う opsHealth では知らせを空にすること、
// diff.sections の形の違いは今までどおり checkObserveReport が誤りにすること。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObserveReport, ObserveSection } from '../lib/observe.ts';
import type { OpsItem, OpsItemId } from '../lib/ops-health.ts';
import { checkObserveReport, selectReviews, type PatrolReviewName, type PatrolSelection, type PatrolState } from '../lib/patrol.ts';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-30T00:00:00Z');
const hoursBefore = (n: number): string => new Date(NOW.getTime() - n * HOUR).toISOString();

/** 3つとも下限以上・上限未満（差だけで決まる）の状態 */
function stateAgo(hours: Record<PatrolReviewName, number>): PatrolState {
  const reviews: PatrolState['reviews'] = {};
  for (const [name, h] of Object.entries(hours)) reviews[name as PatrolReviewName] = { lastRunAt: hoursBefore(h) };
  return { version: 1, reviews, observe: 'patrol-observe.json', rounds: [] };
}
const STATE = stateAgo({ 'arch-review': 24, 'qa-retro': 48, 'test-prune': 48 });

const judged = (id: OpsItemId, title: string, value: number, threshold: number, exceeded: boolean): OpsItem =>
  ({ id, title, available: true, value, threshold, exceeded, evidence: [`テストの根拠 ${id}`] });

/**
 * 5種の項目：超えた（前回は超えていない）・超えていて値が増えた・超えていないが値が増えた・超えておらず増えていない・読めない。
 * items は OPS_ITEM_IDS の順と逆に並べ、出力が OPS_ITEM_IDS の順に並ぶかを見る。
 */
const ITEMS: OpsItem[] = [
  { id: 'ci-load', title: 'CI の過剰な実行', available: false, reason: 'テストで読めない' },
  judged('gate-runs', 'ゲートの実行の数', 10, 600, false),
  judged('requeue', '判定のやり直し', 1, 2, false),
  judged('failed-gate', '失敗したままのゲート', 90, 60, true),
  judged('rate-limit', 'API の上限', 2, 1, true),
];
const OPS_DIFF: NonNullable<NonNullable<ObserveReport['diff']>['opsHealth']> = {
  exceeded: { added: ['rate-limit'], removed: [] },
  increased: [
    { id: 'failed-gate', previous: 70, current: 90 },
    { id: 'requeue', previous: 0, current: 1 },
  ],
};

type SectionDiff = { added: string[]; removed: string[] } | null;
const EMPTY: SectionDiff = { added: [], removed: [] };

/**
 * 観測の JSON（ObserveReport の形）。ops に undefined を渡すと opsHealth の無い（古い）JSON、opsDiff に undefined を渡すと diff.opsHealth の欄が無い JSON。
 * sections に null を渡すと diff 自体が無い（初回の）JSON。
 */
function report(opts: {
  ops?: ObserveReport['opsHealth'];
  opsDiff?: NonNullable<ObserveReport['diff']>['opsHealth'];
  sections?: Partial<Record<ObserveSection, SectionDiff>> | null;
}): ObserveReport {
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
  if (opts.ops !== undefined) r.opsHealth = opts.ops;
  if (opts.sections !== null) {
    r.diff = {
      previousGeneratedAt: hoursBefore(6),
      sections: { docs: EMPTY, hotspots: EMPTY, slowTests: EMPTY, flakyTests: EMPTY, mutants: EMPTY, ...(opts.sections ?? {}) },
    };
    if (opts.opsDiff !== undefined) r.diff.opsHealth = opts.opsDiff;
  }
  return r;
}
const OPS: ObserveReport['opsHealth'] = { available: true, since: hoursBefore(24), gets: 30, maxGets: 200, items: ITEMS };

/** JSON を通して checkObserveReport に渡し（スクリプトと同じ経路）、ok の報告を返す */
function checked(v: unknown): ObserveReport {
  const r = checkObserveReport(JSON.parse(JSON.stringify(v)));
  assert.ok(r.ok, `checkObserveReport が誤りにしました: ${JSON.stringify(r)}`);
  return r.report;
}
const choice = (s: PatrolSelection) => ({ run: s.run, suggest: s.suggest, skipped: s.skipped, reasons: s.reasons });

test('超えた項目と前回から増えた項目が alerts に OPS_ITEM_IDS の順で出て、opsHealth の無い JSON と見直しの選び方は同じ', () => {
  const sections = { docs: { added: ['docs/a.md'], removed: [] }, flakyTests: { added: ['t1'], removed: [] } };
  const sel = selectReviews(STATE, checked(report({ ops: OPS, opsDiff: OPS_DIFF, sections })), NOW, 2);
  assert.deepEqual(sel.alerts, [
    { id: 'rate-limit', title: 'API の上限', value: 2, threshold: 1, exceeded: true, newlyExceeded: true, previous: null },
    { id: 'failed-gate', title: '失敗したままのゲート', value: 90, threshold: 60, exceeded: true, newlyExceeded: false, previous: 70 },
    { id: 'requeue', title: '判定のやり直し', value: 1, threshold: 2, exceeded: false, newlyExceeded: false, previous: 0 },
  ]);
  const without = selectReviews(STATE, checked(report({ sections })), NOW, 2);
  assert.deepEqual(choice(sel), choice(without), 'opsHealth の有無で見直しの選び方が変わりました');
  assert.ok(sel.run.length > 0, '比べる選び方が空です（観測の差の作り方を見直す）');
});

test('opsHealth が無い・読めない・形が違うと、checkObserveReport は通し、alerts は空で alertsNote に理由がある', () => {
  const rows: { name: string; ops: unknown }[] = [
    { name: 'opsHealth が無い（古い JSON）', ops: undefined },
    { name: 'opsHealth.available が false', ops: { available: false, reason: 'GitHub を読めません' } },
    { name: 'items が配列でない', ops: { ...OPS, items: { 'rate-limit': ITEMS[4] } } },
    { name: 'value が文字列の項目がある', ops: { ...OPS, items: [...ITEMS.slice(0, 4), { ...ITEMS[4], value: '2' }] } },
  ];
  for (const row of rows) {
    const sel = selectReviews(STATE, checked(report({ ops: row.ops as ObserveReport['opsHealth'], opsDiff: OPS_DIFF })), NOW, 2);
    assert.deepEqual(sel.alerts, [], `${row.name}：alerts が空ではありません`);
    assert.equal(typeof sel.alertsNote, 'string', `${row.name}：alertsNote がありません`);
    assert.ok(sel.alertsNote!.length > 0, `${row.name}：alertsNote が空です`);
  }
});

test('前回との差（diff.opsHealth）が使えないときは超えた項目だけを出し、alertsNote にその旨がある', () => {
  const rows: { name: string; r: ObserveReport }[] = [
    { name: 'diff.opsHealth が null', r: report({ ops: OPS, opsDiff: null }) },
    { name: 'diff 自体が無い（初回）', r: report({ ops: OPS, sections: null }) },
  ];
  for (const row of rows) {
    const sel = selectReviews(STATE, checked(row.r), NOW, 2);
    assert.deepEqual(sel.alerts, [
      { id: 'rate-limit', title: 'API の上限', value: 2, threshold: 1, exceeded: true, newlyExceeded: false, previous: null },
      { id: 'failed-gate', title: '失敗したままのゲート', value: 90, threshold: 60, exceeded: true, newlyExceeded: false, previous: null },
    ], `${row.name}：超えた項目だけになっていません`);
    assert.equal(typeof sel.alertsNote, 'string', `${row.name}：alertsNote がありません`);
    assert.ok(sel.alertsNote!.length > 0, `${row.name}：alertsNote が空です`);
  }
});

test('diff.sections の形が違う JSON は、opsHealth があっても今までどおり checkObserveReport が誤りにする', () => {
  const good = report({ ops: OPS, opsDiff: OPS_DIFF });
  const rows: { name: string; diff: unknown }[] = [
    { name: 'sections の節の added が配列でない', diff: { ...good.diff, sections: { ...good.diff!.sections, docs: { added: 'docs/a.md', removed: [] } } } },
    { name: 'sections が無い', diff: { previousGeneratedAt: hoursBefore(6), opsHealth: OPS_DIFF } },
  ];
  for (const row of rows) {
    const r = checkObserveReport(JSON.parse(JSON.stringify({ ...good, diff: row.diff })));
    assert.equal(r.ok, false, `${row.name}：誤りになりません`);
  }
});
