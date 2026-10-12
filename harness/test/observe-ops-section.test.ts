// Issue #702：保守の観測（observe）の運用の健康の節。偽の GitHub で JSON の opsHealth が 14 項目を出し要約で超えた項目が先に出ること、
// observe.opsHealth の誤り（opsHealthConfigErrors）で loadConfig は止まらず運用の健康の節だけ読めないこと、前回との差（diff.opsHealth）、
// 実物と雛形のしきい値が OPS_HEALTH_DEFAULTS と同じで docs/operations.md に書かれていること、maxGets が GitHub を読む上限に使われること、GET しか呼ばないことを確かめる。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { GitHub } from '../lib/github.ts';
import { diffReports, observe, opsHealthConfigErrors, renderSummary, type ObserveIo, type ObserveOptions, type ObserveReport } from '../lib/observe.ts';
import { OPS_HEALTH_DEFAULTS, OPS_ITEM_IDS, type OpsItem } from '../lib/ops-health.ts';
import { config, FakeGitHub } from './support/gate-fixtures.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const OPTS: ObserveOptions = { days: 30, top: 20, junit: null, runTests: false, previous: null, offline: false };
const REAL_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL('../templates/harness.config.json', import.meta.url));
const DOCS_PATH = fileURLToPath(new URL('../../docs/operations.md', import.meta.url));
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

function writeConfig(opsHealth: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'observe-ops-section-'));
  const path = join(dir, 'harness.config.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(REAL_PATH, 'utf8')), observe: { opsHealth } }, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --- AC1 ---

test('偽の GitHub で observe を回すと opsHealth が 14 項目を出し、要約の運用の健康の節で超えた項目が超えていない項目より先に出る（GET だけ）', async () => {
  const fake = opsFake();
  // schedule-gap（1番目の項目）は超えないようにして、超えた epic-drift（10番目）が先に並ぶことを見る
  const cfg = { ...config, observe: { opsHealth: { scheduleGapMinutes: 2000 } } };
  const report = await observe(io({ config: cfg, gh: new GitHub(fake, 'o/r') }), OPTS);

  const ops = report.opsHealth;
  assert.ok(ops?.available, '運用の健康の節が読めること');
  assert.deepEqual(ops.items.map((i) => i.id), [...OPS_ITEM_IDS]);
  assert.equal(ops.maxGets, OPS_HEALTH_DEFAULTS.maxGets);
  assert.equal(ops.since, new Date(NOW.getTime() - 24 * 3_600_000).toISOString());
  const byId = new Map(ops.items.map((i) => [i.id, i]));
  assert.equal((byId.get('epic-drift') as Extract<OpsItem, { available: true }>).exceeded, true);
  assert.equal((byId.get('schedule-gap') as Extract<OpsItem, { available: true }>).exceeded, false);
  // io.worktrees が無いと項目 12 だけが読めない
  assert.deepEqual(ops.items.filter((i) => !i.available).map((i) => i.id), ['stale-worktree']);
  onlyGets(fake);

  const section = summarySection(renderSummary(report), '運用の健康');
  assert.ok(section.includes(`${ops.gets}/${ops.maxGets}`), 'GitHub を読んだ数（gets/maxGets）が出る');
  const exceeded = section.indexOf('Epic のずれ');
  const notExceeded = section.indexOf('定期実行の抜け');
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

// --- AC2 ---

test('opsHealthConfigErrors：型と範囲の誤り・知らないキー・オブジェクトでない observe は誤りにし、キーと今の値を添える。正しい値と省略は誤りにしない', () => {
  const ok: unknown[] = [undefined, {}, { opsHealth: {} }, { opsHealth: { ...OPS_HEALTH_DEFAULTS } }, { opsHealth: { readyHours: 1.5, scheduleGapMinutes: 0.5, maxGets: 1 } }];
  for (const observeValue of ok) {
    const cfg = { ...config, observe: observeValue } as unknown as HarnessConfig;
    assert.deepEqual(opsHealthConfigErrors(cfg), [], `${JSON.stringify(observeValue)} を誤りにした`);
  }
  const bad: [unknown, string][] = [
    [{ opsHealth: { scheduleGapMinutes: -1 } }, 'observe.opsHealth.scheduleGapMinutes'],
    [{ opsHealth: { readyHours: 0 } }, 'observe.opsHealth.readyHours'],
    [{ opsHealth: { maxGets: 'x' } }, 'observe.opsHealth.maxGets'],
    [{ opsHealth: { maxGets: 1.5 } }, 'observe.opsHealth.maxGets'],
    [{ opsHealth: { maxGets: 0 } }, 'observe.opsHealth.maxGets'],
    [{ opsHealth: { requeueCount: 2.5 } }, 'observe.opsHealth.requeueCount'],
    [{ opsHealth: { staleWorktrees: -1 } }, 'observe.opsHealth.staleWorktrees'],
    [{ opsHealth: { ciJobMinutes: null } }, 'observe.opsHealth.ciJobMinutes'],
    [{ opsHealth: { bogus: 1 } }, 'observe.opsHealth.bogus'],
    [{ opsHealth: [] }, 'observe.opsHealth'],
    [{ opsHealth: 5 }, 'observe.opsHealth'],
    ['x', 'observe'],
    [null, 'observe'],
  ];
  for (const [observeValue, key] of bad) {
    const errors = opsHealthConfigErrors({ ...config, observe: observeValue } as unknown as HarnessConfig);
    assert.ok(errors.length > 0, `${JSON.stringify(observeValue)} を誤りにしなかった`);
    assert.ok(errors.some((e) => e.includes(key)), `${JSON.stringify(errors)} に ${key} が無い`);
  }
});

test('observe.opsHealth に負の数・文字列・知らないキーがあっても loadConfig は止まらず、運用の健康の節だけがキーと今の値を添えて読めない旨になる', async (t) => {
  const file = writeConfig({ scheduleGapMinutes: -1, maxGets: 'x', bogus: 1 });
  t.after(file.cleanup);
  let loaded: HarnessConfig | undefined;
  assert.doesNotThrow(() => { loaded = loadConfig(file.path); });

  const fake = opsFake();
  const report = await observe(io({ config: loaded!, gh: new GitHub(fake, 'o/r') }), OPTS);
  assert.equal(report.opsHealth?.available, false);
  const reason = (report.opsHealth as { reason: string }).reason;
  for (const part of ['observe.opsHealth.scheduleGapMinutes', '-1', 'observe.opsHealth.maxGets', '"x"', 'bogus']) assert.ok(reason.includes(part), `理由に ${part} が無い：${reason}`);
  assert.ok(renderSummary(report).includes('observe.opsHealth.scheduleGapMinutes'), '要約にも出る');
  assert.equal(report.docs.available, true);
  assert.equal(report.hotspots.available, true);
  onlyGets(fake);
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

test('実物と雛形の observe.opsHealth は OPS_HEALTH_DEFAULTS と同じで、17 キーが docs/operations.md の「上限の設定」と「見直しを /loop で回す」に書かれている', () => {
  for (const path of [REAL_PATH, TEMPLATE_PATH]) {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { observe?: { opsHealth?: unknown } };
    assert.deepEqual(json.observe?.opsHealth, OPS_HEALTH_DEFAULTS, path);
  }
  const docs = readFileSync(DOCS_PATH, 'utf8');
  const docSection = (heading: string): string => {
    const lines = docs.split('\n');
    const start = lines.indexOf(`## ${heading}`);
    assert.ok(start >= 0, `docs/operations.md に「## ${heading}」が無い`);
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
  };
  const keys = Object.keys(OPS_HEALTH_DEFAULTS);
  assert.equal(keys.length, 17);
  for (const heading of ['上限の設定', '見直しを /loop で回す']) {
    const text = docSection(heading);
    const missing = keys.filter((k) => !text.includes(`\`${k}\``));
    assert.deepEqual(missing, [], `「${heading}」に書かれていないキー`);
  }
});

// --- AC5 ---

test('設定の observe.opsHealth.maxGets が report.opsHealth.maxGets に出て、GitHub を読む上限に使われる（読んだ数は上限以下・GET だけ）', async (t) => {
  const file = writeConfig({ maxGets: 2 });
  t.after(file.cleanup);
  const fake = opsFake();
  const report = await observe(io({ config: loadConfig(file.path), gh: new GitHub(fake, 'o/r') }), OPTS);

  const ops = report.opsHealth;
  assert.ok(ops?.available);
  assert.equal(ops.maxGets, 2);
  assert.ok(ops.gets <= 2, `gets ${ops.gets}`);
  assert.ok(fake.calls.filter((c) => OPS_PATH.test(c.path)).length <= 2, '偽の GitHub が受けた運用の健康の GET が上限を超えない');
  assert.ok(ops.items.some((i) => !i.available && i.reason.includes('上限')), '上限の理由で読めない項目が出る');
  onlyGets(fake);
});
