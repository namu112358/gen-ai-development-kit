// Epic の振り分けの純粋な関数（harness/lib/epic-triage.ts）のテスト。Epic #436・Issue #564：
// 判定（下限・差・前に足した Epic・閉じた Epic）、Jev の要求（問い済みを除く・criteria の no）、対象の選び方、記録の読み取り、設定
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { appLogin, LABELS, limitErrors, loadConfig, type HarnessConfig } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import {
  buildEpicTriageRequest,
  decideEpic,
  EPIC_TRIAGE_KIND,
  epicTriageSettings,
  readEpicTriageHistory,
  selectTriageTargets,
  type OpenEpic,
  type TriageIssue,
} from '../lib/epic-triage.ts';

const config = loadConfig();
const settings = { probability: 0.9, margin: 0.2 };
const noHistory = { probabilities: {}, added: [] as number[] };
const OPEN = [436, 437];

const epic = (number: number, children: number[] = [], splitChildren: number[] = []): OpenEpic => ({
  number,
  title: `Epic ${number}`,
  body: `### Goal\n\nEpic ${number} の目的\n`,
  children: children.map((n) => ({ number: n, title: `child ${n}` })),
  splitChildren,
});
const EPICS = [epic(436), epic(437)];

let nextId = 1;
const comment = (login: string, kind: string, record: unknown): IssueComment => ({
  id: nextId++,
  body: `${appMark(kind)}\n本文\n\n${renderBlock('agent-app', record)}`,
  html_url: 'u',
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '',
  author_association: 'NONE',
  user: { login, type: login === appLogin(config) ? 'Bot' : 'User' },
});
const triageRecord = (probabilities: Record<string, number | null>, added: number[] = []) => ({
  version: 1,
  questionSet: 1,
  mode: 'shadow',
  model: 'm',
  probabilities,
  decision: { epic: null, probability: null, second: null },
  added,
  size: null,
});

// (1)〜(3)：下限と差の判定
const decisions: { name: string; current: Record<string, number>; epic: number | null }[] = [
  { name: '(1) どの Epic も下限未満なら返さない', current: { '436': 0.5, '437': 0.3 }, epic: null },
  { name: '(2) 1番目と2番目の差が epicMargin 未満なら返さない', current: { '436': 0.95, '437': 0.8 }, epic: null },
  { name: '(3) 下限以上で差も十分なら1番目の Epic', current: { '436': 0.95, '437': 0.3 }, epic: 436 },
  { name: '(3) 差が epicMargin ちょうど（0.95 と 0.75）でも返す', current: { '436': 0.95, '437': 0.75 }, epic: 436 },
];
for (const d of decisions) {
  test(`decideEpic：${d.name}`, () => {
    assert.equal(decideEpic(settings, d.current, noHistory, OPEN).epic, d.epic);
  });
}

test('decideEpic：(4) 前の記録の added にある Epic は確率が高くても返さない', () => {
  assert.equal(decideEpic(settings, { '436': 0.99, '437': 0.1 }, { probabilities: {}, added: [436] }, OPEN).epic, null);
});

test('decideEpic：(5) 閉じた Epic の古い確率は比べに使わない', () => {
  const history = { probabilities: { '999': 0.99 }, added: [] };
  // 999 が比べに入れば1番目が 999 になり、436 は返らない
  assert.equal(decideEpic(settings, { '436': 0.95, '437': 0.3 }, history, OPEN).epic, 436);
});

test('buildEpicTriageRequest：(6) 前の記録で問い済みの Epic は要求に入らず、全部問い済みなら問わない', () => {
  const issue = { title: 'feat: 何か', body: '本文' };
  const once = readEpicTriageHistory(config, [comment(appLogin(config), EPIC_TRIAGE_KIND, triageRecord({ '436': null }))]);
  const partial = buildEpicTriageRequest(config, issue, EPICS, once.asked);
  assert.equal(partial.ask, true);
  if (!partial.ask) return;
  assert.deepEqual(Object.keys(partial.request.questions), ['epic_437']);

  const all = readEpicTriageHistory(config, [comment(appLogin(config), EPIC_TRIAGE_KIND, triageRecord({ '436': 0.4, '437': 0.2 }))]);
  assert.equal(buildEpicTriageRequest(config, issue, EPICS, all.asked).ask, false);
});

test('buildEpicTriageRequest：(7) 各問いの criteria.false に同じ領域・同じファイル・分からないが no と書かれている', () => {
  const r = buildEpicTriageRequest(config, { title: 't', body: null }, EPICS, []);
  assert.equal(r.ask, true);
  if (!r.ask) return;
  const questions = Object.values(r.request.questions);
  assert.equal(questions.length, 2);
  for (const q of questions) {
    for (const word of [/same area/i, /same files/i, /cannot tell/i]) assert.match(q.criteria.false, word);
    assert.match(q.instructions, /answer no/i);
  }
});

test('selectTriageTargets：(8) PR・ダッシュボード・epic のラベル・子を持つ Issue・Epic の子・分割の子を除く', () => {
  const issue = (number: number, extra: Partial<TriageIssue> = {}): TriageIssue => ({
    number, title: `Issue ${number}`, body: '', labels: [], isPullRequest: false, subIssues: 0, ...extra,
  });
  const issues = [
    issue(10),
    issue(11, { isPullRequest: true }),
    issue(12, { title: config.dashboardIssueTitle }),
    issue(13, { labels: [LABELS.epic] }),
    issue(14, { subIssues: 2 }),
    issue(15),
    issue(16),
    issue(436),
    issue(17),
  ];
  const epics = [epic(436, [15]), epic(437, [], [16])];
  assert.deepEqual(selectTriageTargets(issues, epics, config.dashboardIssueTitle).map((i) => i.number), [10, 17]);
});

test('readEpicTriageHistory：(9) App 以外の名義の同じ形のコメントは読まない', () => {
  const history = readEpicTriageHistory(config, [comment('someone', EPIC_TRIAGE_KIND, triageRecord({ '436': 0.99 }, [436]))]);
  assert.deepEqual(history, { probabilities: {}, asked: [], added: [] });
});

test('設定：(10) 2つの harness.config.json の値と、キーの無い設定の既定', () => {
  const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8'));
  for (const rel of ['harness.config.json', 'harness/templates/harness.config.json']) {
    const jev = read(rel).jev;
    assert.deepEqual(
      [jev?.thresholds?.epicProbability, jev?.thresholds?.epicMargin, jev?.epicTriage, jev?.epicTriagePerRun],
      [0.9, 0.2, 'shadow', 3],
      rel,
    );
  }
  const { epicTriage: _m, epicTriagePerRun: _p, ...jev } = config.jev as HarnessConfig['jev'] & Record<string, unknown>;
  const { epicProbability: _q, epicMargin: _r, ...thresholds } = config.jev.thresholds as HarnessConfig['jev']['thresholds'] & Record<string, unknown>;
  const bare = { ...config, jev: { ...jev, thresholds } } as HarnessConfig;
  assert.deepEqual(epicTriageSettings(bare), { mode: 'shadow', perRun: 3, probability: 0.9, margin: 0.2 });
});

test('設定：(11) limitErrors が jev.epicTriagePerRun: 0 を誤りにする', () => {
  const bad = { ...config, jev: { ...config.jev, epicTriagePerRun: 0 } };
  assert.ok(limitErrors(bad).some((e) => e.includes('jev.epicTriagePerRun')), JSON.stringify(limitErrors(bad)));
});
