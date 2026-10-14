// Issue #702：保守の観測（observe）の運用の健康の節。偽の GitHub で JSON の opsHealth が 14 項目を出し要約で超えた項目が先に出ること、前回との差（diff.opsHealth）、
// しきい値が OPS_HEALTH_DEFAULTS の定数（17 キーの値）だけで実物と雛形の設定に observe が無く、キーが harness/docs/operations.md に書かれていること（#1077）、
// GitHub を読む上限が OPS_HEALTH_DEFAULTS.maxGets であること、GET しか呼ばないことを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GitHub } from '../lib/github.ts';
import { diffReports, observe, renderSummary, type ObserveIo, type ObserveOptions, type ObserveReport } from '../lib/observe.ts';
import { OPS_HEALTH_DEFAULTS, OPS_ITEM_IDS, type OpsItem } from '../lib/ops-health.ts';
import { config, FakeGitHub } from './support/gate-fixtures.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const OPTS: ObserveOptions = { days: 30, top: 20, junit: null, runTests: false, previous: null, offline: false };
const REAL_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL('../templates/harness.config.json', import.meta.url));
const DOCS_PATH = fileURLToPath(new URL('../docs/operations.md', import.meta.url));
/** 運用の健康の読み（collectOpsHealth）が呼ぶ一覧のパス。不安定なテスト・ミュータントの読み（/actions/workflows）とは分ける */
const OPS_PATH = /\/actions\/runs\?|\/pulls\?|\/issues\?/;

const io = (patch: Partial<ObserveIo> = {}): ObserveIo => ({
  config, now: NOW,
  gitFiles: () => ['README.md'],
  gitLog: () => '',
  head: () => 'f'.repeat(40),
  readText: (p) => (p === 'README.md' ? '# README\n' : null),
  gh: null,
  junit: async () => ({ reason: 'junit がありません' }),
  ...patch,
});

/** 実行も PR も無く、子が全部 Close の開いた Epic が1つだけある偽の GitHub。GET 以外のルートは無い（呼べば unrouted で throw し、calls に残る） */
function opsFake(): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/actions\/runs\?/, () => ({ workflow_runs: [] }))
    .on('GET', /\/pulls\?.*state=open/, () => [])
    .on('GET', /\/issues\?.*state=open/, () => [
      { number: 10, title: 'Epic', labels: [{ name: 'epic' }], sub_issues_summary: { total: 2, completed: 2, percent_completed: 100 } },
    ]);
}

const onlyGets = (fake: FakeGitHub) => assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET'), [], 'GitHub には GET しか呼ばない');

/** 要約のうち、見出しが prefix で始まる節（次の ## まで） */
function summarySection(summary: string, prefix: string): string {
  const lines = summary.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${prefix}`));
  assert.ok(start >= 0, `要約に「## ${prefix}」の節が無い`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

// --- AC1 ---

test('偽の GitHub で observe を回すと opsHealth が 14 項目を出し、要約の運用の健康の節で超えた項目が超えていない項目より先に出る（GET だけ）', async () => {
  const fake = opsFake();
  // 実行が無いので rate-limit（2番目の項目）は値 0・しきい値 1 で超えない。超えた epic-drift（10番目）が先に並ぶことを見る
  const report = await observe(io({ gh: new GitHub(fake, 'o/r') }), OPTS);

  const ops = report.opsHealth;
  assert.ok(ops?.available, '運用の健康の節が読めること');
  assert.deepEqual(ops.items.map((i) => i.id), [...OPS_ITEM_IDS]);
  assert.equal(ops.maxGets, OPS_HEALTH_DEFAULTS.maxGets);
  assert.equal(ops.since, new Date(NOW.getTime() - 24 * 3_600_000).toISOString());
  const byId = new Map(ops.items.map((i) => [i.id, i]));
  assert.equal((byId.get('epic-drift') as Extract<OpsItem, { available: true }>).exceeded, true);
  assert.equal((byId.get('rate-limit') as Extract<OpsItem, { available: true }>).exceeded, false);
  // io.worktrees が無いと項目 12 だけが読めない
  assert.deepEqual(ops.items.filter((i) => !i.available).map((i) => i.id), ['stale-worktree']);
  onlyGets(fake);

  const section = summarySection(renderSummary(report), '運用の健康');
  assert.ok(section.includes(`${ops.gets}/${ops.maxGets}`), 'GitHub を読んだ数（gets/maxGets）が出る');
  const exceeded = section.indexOf('Epic のずれ');
  const notExceeded = section.indexOf('API の上限');
  assert.ok(exceeded >= 0 && notExceeded >= 0);
  assert.ok(exceeded < notExceeded, '超えた項目が先に出る');
  assert.ok(section.includes('worktree を読めません'), '読めない項目は理由が出る');
});

test('gh が null なら運用の健康の節は offlineReason（無ければ --offline）の読めない旨になる', async () => {
  const offline = await observe(io(), OPTS);
  assert.equal(offline.opsHealth?.available, false);
  assert.match((offline.opsHealth as { reason: string }).reason, /--offline/);
  const reasoned = await observe(io({ offlineReason: 'GITHUB_TOKEN が無い' }), OPTS);
  assert.deepEqual(reasoned.opsHealth, { available: false, reason: 'GITHUB_TOKEN が無い' });
});

// --- AC3 ---

const opsItem = (id: OpsItem['id'], value: number, exceeded: boolean): OpsItem => ({ id, title: id, available: true, value, threshold: 1, exceeded, evidence: [] });
const withOps = (report: ObserveReport, items: OpsItem[] | null): ObserveReport => ({
  ...report,
  opsHealth: items === null ? { available: false, reason: '読めない' } : { available: true, since: report.generatedAt, gets: 3, maxGets: 200, items },
});

test('diff.opsHealth：前回か今回に opsHealth が無い・読めないなら null、両方あれば超えた項目の id の増減と値が増えた項目が出る', async () => {
  const base = await observe(io(), OPTS);
  const noOps: ObserveReport = { ...base };
  delete noOps.opsHealth;
  const previous = withOps(base, [opsItem('schedule-gap', 2, true), opsItem('epic-drift', 0, false), opsItem('requeue', 5, false)]);
  const current = withOps(base, [opsItem('schedule-gap', 0, false), opsItem('epic-drift', 3, true), opsItem('requeue', 4, false)]);

  assert.equal(diffReports(noOps, current).opsHealth, null);
  assert.equal(diffReports(withOps(base, null), current).opsHealth, null);
  assert.equal(diffReports(previous, withOps(base, null)).opsHealth, null);

  const diff = diffReports(previous, current);
  assert.deepEqual(diff.opsHealth, { exceeded: { added: ['epic-drift'], removed: ['schedule-gap'] }, increased: [{ id: 'epic-drift', previous: 0, current: 3 }] });

  const summary = renderSummary({ ...current, diff });
  const diffSection = summarySection(summary, '前回');
  assert.ok(diffSection.includes('epic-drift'), '要約の差の節に超えた項目・値が増えた項目が出る');
  assert.ok(diffSection.includes('schedule-gap'));
});

// --- AC4 ---

test('しきい値は OPS_HEALTH_DEFAULTS の 17 キーの今の値で、実物と雛形の設定に最上位の observe が無く、17 キーが harness/docs/operations.md の「見直しを /loop で回す」に書かれている', () => {
  assert.deepEqual(OPS_HEALTH_DEFAULTS, {
    scheduleGapMinutes: 90, rateLimitFailures: 1, failedGateMinutes: 60, gateRunsPerDay: 600, ciJobMinutes: 10,
    readyHours: 2, prOpenHours: 24, requeueCount: 2, claimIdleMinutes: 60, planReviewCount: 5, unplannedIssueCount: 10,
    epicDrift: 1, linkMismatch: 1, staleWorktrees: 1, areaFullMinutes: 60, reviewPanelFailures: 1, maxGets: 200,
  });
  for (const path of [REAL_PATH, TEMPLATE_PATH]) {
    const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(Object.hasOwn(json, 'observe'), false, `${path} に observe が残っている`);
  }
  const docs = readFileSync(DOCS_PATH, 'utf8');
  const docSection = (heading: string): string => {
    const lines = docs.split('\n');
    const start = lines.indexOf(`## ${heading}`);
    assert.ok(start >= 0, `harness/docs/operations.md に「## ${heading}」が無い`);
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
  };
  const keys = Object.keys(OPS_HEALTH_DEFAULTS);
  assert.equal(keys.length, 17);
  const text = docSection('見直しを /loop で回す');
  const missing = keys.filter((k) => !text.includes(`\`${k}\``));
  assert.deepEqual(missing, [], '「見直しを /loop で回す」に書かれていないキー');
});

// --- AC5 ---

test('report.opsHealth.maxGets は OPS_HEALTH_DEFAULTS.maxGets（200）で、GitHub を読んだ数はその上限以下・GET だけ', async () => {
  const fake = opsFake();
  const report = await observe(io({ gh: new GitHub(fake, 'o/r') }), OPTS);

  const ops = report.opsHealth;
  assert.ok(ops?.available);
  assert.equal(ops.maxGets, 200);
  assert.equal(ops.maxGets, OPS_HEALTH_DEFAULTS.maxGets);
  assert.ok(ops.gets <= ops.maxGets, `gets ${ops.gets}`);
  assert.ok(fake.calls.filter((c) => OPS_PATH.test(c.path)).length <= ops.maxGets, '偽の GitHub が受けた運用の健康の GET が上限を超えない');
  onlyGets(fake);
});
