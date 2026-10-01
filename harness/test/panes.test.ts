// Issue #284：fleet と hq のワークスペースのペイン表示（進み具合・人がすること・PR と費用）を確かめる。
// 段階の読み替え（locateRow）、fleet 自身の着手宣言を「このセッション」として扱うこと、描き方の関数がスナップショットだけを
// 受け取って gh・GitHub を呼ばないこと、collect が設定の間隔で読むことを、偽の deps と schedule で確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import {
  CLEAR_SCREEN, HISTORY_LIMIT, MARKS, PANE_STEPS, clip, displayWidth, locateRow, nextSince, padEnd, renderPrs,
  renderProgress, renderTodo, rowSignature, stripAnsi, todoItems, type PanePr, type PaneSnapshot,
} from '../lib/panes.ts';
import { projectTranscriptDir } from '../lib/usage.ts';
import {
  collectOnce, defaultSnapshotPath, startCollect, startRender, type CollectDeps, type CollectOptions, type RenderDeps, type RunResult,
} from '../scripts/panes.ts';

const root = join(import.meta.dirname, '..', '..');

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const own = (stage: string | null): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess-1', own: true });
const other = (stage: string | null): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess-other', own: false });

const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.filter((r) => r.selected).length, selected: rows.filter((r) => r.selected).map((r) => r.issue), max: null, mode: null,
});
const snap = (rows: FleetStatusRow[], patch: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  version: 1, at: '2026-09-30T00:00:00.000Z', session: 'sess-1', label: null, intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: statusData(rows), prs: [], usage: null, history: [], since: {}, error: null, ...patch,
});
const pr = (number: number, patch: Partial<PanePr> = {}): PanePr => ({
  number, title: `pr${number}`, state: 'OPEN', isDraft: false, autoMerge: false, labels: [], checks: [], ...patch,
});
const NOW = Date.parse('2026-09-30T00:10:00.000Z');
const plain = (s: string): string => stripAnsi(s);

// ---- 定数 ----

test('CLEAR_SCREEN・PANE_STEPS・HISTORY_LIMIT の値', () => {
  assert.equal(CLEAR_SCREEN, '\x1b[H\x1b[2J\x1b[3J');
  assert.deepEqual([...PANE_STEPS], ['計画', '批評', 'ゲート', '実装', '判定', 'Merge']);
  assert.equal(HISTORY_LIMIT, 40);
});

// ---- locateRow：表の段階 ----

test('locateRow：merged は done', () => {
  const l = locateRow(row(1, { stage: 'merged' }));
  assert.equal(l.step, 'done');
  assert.equal(l.who, 'done');
  assert.equal(l.other, false);
});

test('locateRow：宣言の無い行は表の段階から場所と誰の番を決める', () => {
  const cases: [FleetStage, number, string][] = [
    ['no-plan', 0, 'ai'], ['plan-gate', 2, 'app'], ['plan-review', 2, 'human'], ['plan-ok', 3, 'ai'],
    ['judge', 4, 'ai'], ['fix', 4, 'ai'], ['human-merge', 5, 'human'], ['auto-merge', 5, 'app'],
  ];
  for (const [stage, step, who] of cases) {
    const l = locateRow(row(1, { stage }));
    assert.equal(l.step, step, stage);
    assert.equal(l.who, who, stage);
    assert.equal(l.other, false, stage);
  }
});

test('locateRow：宣言の無い plan-review は「計画ゲートで停止」、human-merge は「人の Merge 待ち」', () => {
  assert.match(locateRow(row(1, { stage: 'plan-review' })).what, /計画ゲートで停止/);
  assert.match(locateRow(row(1, { stage: 'human-merge', pr: 50 })).what, /人の Merge 待ち/);
});

// ---- locateRow：宣言の段階を優先 ----

test('locateRow：宣言の段階 implement は、表の段階が plan-review・plan-ok でも実装中（AI）', () => {
  for (const stage of ['plan-review', 'plan-ok'] as const) {
    const l = locateRow(row(1, { stage, claim: own('implement') }));
    assert.equal(l.step, 3, stage);
    assert.equal(l.who, 'ai', stage);
    assert.match(l.what, /実装中/, stage);
    assert.equal(l.other, false, stage);
  }
});

test('locateRow：宣言の段階 judge・fix・sync は判定（AI）', () => {
  for (const s of ['judge', 'fix', 'sync']) {
    const l = locateRow(row(1, { stage: 'human-merge', pr: 50, prClaim: own(s) }));
    assert.equal(l.step, 4, s);
    assert.equal(l.who, 'ai', s);
  }
});

test('locateRow：宣言の段階 plan・plan-critique・plan-gate', () => {
  const cases: [string, number, string][] = [['plan', 0, 'ai'], ['plan-critique', 1, 'ai'], ['plan-gate', 2, 'app']];
  for (const [s, step, who] of cases) {
    const l = locateRow(row(1, { stage: 'no-plan', claim: own(s) }));
    assert.equal(l.step, step, s);
    assert.equal(l.who, who, s);
  }
});

test('locateRow：PR の宣言を Issue の宣言より先に見る', () => {
  const l = locateRow(row(1, { stage: 'judge', pr: 50, claim: own('implement'), prClaim: own('judge') }));
  assert.equal(l.step, 4);
  assert.equal(l.who, 'ai');
});

test('locateRow：ほかのセッションの宣言なら AI のまま other で、あなたの番にしない', () => {
  const l = locateRow(row(1, { stage: 'plan-review', claim: other('implement') }));
  assert.equal(l.who, 'ai');
  assert.equal(l.other, true);
  assert.match(l.what, /ほかのセッションが作業中/);
  const p = locateRow(row(2, { stage: 'human-merge', pr: 50, claim: own('implement'), prClaim: other('fix') }));
  assert.equal(p.who, 'ai');
  assert.equal(p.other, true, 'PR の宣言がほかのセッションなら other');
});

// ---- locateRow：止まる行・待つ行 ----

test('locateRow：Epic は epic・wait', () => {
  const l = locateRow(row(281, { stage: 'stopped', note: 'Epic（子課題で進める）', selected: false, next: 'none' }));
  assert.equal(l.step, 'epic');
  assert.equal(l.who, 'wait');
});

test('locateRow：依存待ちは計画の前で wait', () => {
  const l = locateRow(row(1, { stage: 'stopped', note: '依存 #196 が未解決', waitReason: '依存 #196 が未解決', selected: false, next: 'none' }));
  assert.equal(l.step, 0);
  assert.equal(l.who, 'wait');
  const w = locateRow(row(2, { stage: 'stopped', note: null, waitReason: '依存 #196 が未解決', selected: false, next: 'none' }));
  assert.equal(w.step, 0, 'waitReason だけでも依存待ち');
  assert.equal(w.who, 'wait');
});

test('locateRow：ほかの止まる印（agent:hold など）は stopped・human', () => {
  const l = locateRow(row(1, { stage: 'stopped', note: 'agent:hold', selected: false, next: 'none' }));
  assert.equal(l.step, 'stopped');
  assert.equal(l.who, 'human');
});

test('locateRow：選ばれず待つ理由があり宣言が無い行は順番待ち（wait）で、what に理由', () => {
  const reason = '#284 と触るファイルが重なるため待つ';
  const l = locateRow(row(1, { stage: 'plan-ok', selected: false, waitReason: reason }));
  assert.equal(l.who, 'wait');
  assert.ok(l.what.includes(reason), l.what);
});

// ---- rowSignature・nextSince ----

test('rowSignature：段階が変われば署名が変わり、同じ行なら同じ', () => {
  assert.equal(rowSignature(row(1)), rowSignature(row(1)));
  assert.notEqual(rowSignature(row(1, { stage: 'plan-ok' })), rowSignature(row(1, { stage: 'judge', pr: 50 })));
});

test('nextSince：署名の変わった行だけ時刻を更新する', () => {
  const t1 = '2026-09-30T00:00:00.000Z';
  const t2 = '2026-09-30T00:03:00.000Z';
  const first = nextSince(null, [row(1), row(2)], t1);
  assert.equal(first['1']?.at, t1);
  assert.equal(first['2']?.at, t1);
  const second = nextSince(first, [row(1), row(2, { stage: 'judge', pr: 50 })], t2);
  assert.equal(second['1']?.at, t1, '変わらない行は前の時刻のまま');
  assert.equal(second['1']?.signature, first['1']?.signature);
  assert.equal(second['2']?.at, t2, '変わった行は今の時刻');
  assert.equal(second['2']?.signature, rowSignature(row(2, { stage: 'judge', pr: 50 })));
});

// ---- todoItems・renderTodo ----

test('todoItems：人の番の行だけを、人の Merge 待ち → 計画ゲートで停止 → 止まる印の順に並べる', () => {
  const s = snap([
    row(3, { stage: 'stopped', note: 'agent:hold', selected: false, next: 'none' }),
    row(2, { stage: 'plan-review' }),
    row(4, { stage: 'plan-ok' }),
    row(1, { stage: 'human-merge', pr: 50 }),
    row(5, { stage: 'stopped', note: 'Epic（子課題で進める）', selected: false, next: 'none' }),
  ]);
  const items = todoItems(s);
  assert.deepEqual(items.map((i) => i.issue), [1, 2, 3]);
  assert.deepEqual(items.map((i) => i.rank), [0, 1, 2]);
  assert.equal(items[0]?.pr, 50);
});

test('todoItems：自分の宣言で AI が作業中の行は人がすることに出ない', () => {
  const s = snap([row(7, { stage: 'plan-review', claim: own('implement') })]);
  assert.deepEqual(todoItems(s), []);
  const text = plain(renderTodo(s, NOW, 100));
  assert.match(text, /いまは何もありません/);
});

test('renderTodo：自動 Merge の対象で agent/tests が FAILURE、test:exempt が無ければ判断の項目を出す', () => {
  const rows = [row(8, { stage: 'auto-merge', pr: 60 })];
  const failing = [{ name: 'agent/tests', conclusion: 'FAILURE' }];
  const s = snap(rows, { prs: [pr(60, { checks: failing })] });
  assert.match(plain(renderTodo(s, NOW, 100)), /test:exempt を付けるか決める/);
  const exemptItem = todoItems(s).find((i) => i.pr === 60);
  assert.equal(exemptItem?.rank, 1);
  const labelled = snap(rows, { prs: [pr(60, { checks: failing, labels: ['test:exempt'] })] });
  assert.doesNotMatch(plain(renderTodo(labelled, NOW, 100)), /test:exempt を付けるか決める/);
  const autoMergeFlag = snap([row(9, { stage: 'judge', pr: 61 })], { prs: [pr(61, { autoMerge: true, checks: failing })] });
  assert.match(plain(renderTodo(autoMergeFlag, NOW, 100)), /test:exempt を付けるか決める/, 'autoMerge の PR も対象');
});

test('renderTodo：snap が null なら最初の読み込み中', () => {
  assert.match(plain(renderTodo(null, NOW, 100)), /最初の読み込み中/);
});

// ---- renderProgress ----

test('renderProgress：自分の宣言の行は「このセッション」、ほかの宣言の行は「ほかのセッション」', () => {
  const s = snap([row(1, { stage: 'plan-review', claim: own('implement') })]);
  assert.match(plain(renderProgress(s, NOW, 120)), /このセッション/);
  const o = snap([row(2, { stage: 'plan-review', claim: other('implement') })]);
  const text = plain(renderProgress(o, NOW, 120));
  assert.match(text, /ほかのセッション/);
});

test('renderProgress：凡例に MARKS の全ての mark と meaning が出る', () => {
  const text = plain(renderProgress(snap([row(1)]), NOW, 200));
  for (const [key, m] of Object.entries(MARKS)) {
    assert.ok(text.includes(m.mark), `${key} の mark ${m.mark}`);
    assert.ok(text.includes(m.meaning), `${key} の meaning ${m.meaning}`);
  }
});

test('renderProgress：snap が null なら最初の読み込み中', () => {
  assert.match(plain(renderProgress(null, NOW, 100)), /最初の読み込み中/);
});

// ---- renderPrs ----

test('renderPrs：usage が null なら「読めませんでした」、あれば合計とモデル別', () => {
  const rows = [row(1, { stage: 'judge', pr: 50 })];
  assert.match(plain(renderPrs(snap(rows, { prs: [pr(50)] }), NOW, 120)), /読めませんでした/);
  const text = plain(renderPrs(snap(rows, { prs: [pr(50)], usage: { totalUsd: 1.234, perModel: { 'claude-opus-5-5': 1.234 } } }), NOW, 120));
  assert.ok(text.includes('1.23'), text);
  assert.ok(text.includes('opus-5-5'), text);
  assert.doesNotMatch(text, /読めませんでした/);
});

// ---- 文字幅 ----

test('displayWidth・clip・padEnd：全角は幅2、切るときは … で幅に収める', () => {
  assert.equal(displayWidth('あa'), 3);
  const c = clip('あいうえおかきくけこ', 7);
  assert.ok(displayWidth(c) <= 7, c);
  assert.ok(c.endsWith('…'), c);
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(displayWidth(padEnd('あ', 6)), 6);
});

// ---- lib/panes.ts は外を呼ばない ----

test('lib/panes.ts は node:child_process・node:fs・github を import しない', () => {
  const src = readFileSync(join(root, 'harness', 'lib', 'panes.ts'), 'utf8');
  const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
  for (const s of specs) {
    assert.notEqual(s, 'node:child_process', s);
    assert.notEqual(s, 'child_process', s);
    assert.notEqual(s, 'node:fs', s);
    assert.notEqual(s, 'fs', s);
    assert.notEqual(s, 'node:fs/promises', s);
    assert.doesNotMatch(s, /github(\.ts)?$/, s);
  }
});

// ---- scripts/panes.ts：collect ----

interface Call { cmd: string; args: string[]; opts: { cwd: string; env: Record<string, string | undefined> } }

const SESSION = 'sess-1';
const TRANSCRIPT_CWD = 'C:\\work\\repo';
const HOME = 'C:\\Users\\u';
const transcriptFile = join(projectTranscriptDir(TRANSCRIPT_CWD, HOME), `${SESSION}.jsonl`);

function fakeDeps(o: {
  rows?: FleetStatusRow[];
  fleetFails?: boolean;
  existing?: string[];
  prev?: PaneSnapshot | null;
  prJson?: Record<number, unknown>;
} = {}): { deps: CollectDeps; calls: Call[]; exists: string[]; written: { path: string; snap: PaneSnapshot }[] } {
  const calls: Call[] = [];
  const exists: string[] = [];
  const written: { path: string; snap: PaneSnapshot }[] = [];
  const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });
  const deps: CollectDeps = {
    run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') return ok('{"data":{"repository":{}}}');
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const n = Number(args[2]);
        const j = o.prJson?.[n];
        return j === undefined ? { status: 1, stdout: '', stderr: 'not found' } : ok(JSON.stringify(j));
      }
      if (args[1] === 'fleet-status') return o.fleetFails ? { status: 1, stdout: '', stderr: 'boom' } : ok(JSON.stringify(statusData(o.rows ?? [row(1)])));
      if (args[1] === 'usage') return ok(JSON.stringify({ estimatedUsd: 0.5, perModel: { 'claude-opus-5-5': { estimatedUsd: 0.5 } } }));
      return { status: 1, stdout: '', stderr: 'unknown' };
    },
    exists(path) {
      exists.push(path);
      return (o.existing ?? []).includes(path);
    },
    readSnapshot: () => o.prev ?? null,
    writeSnapshot(path, s) {
      written.push({ path, snap: s });
    },
    now: () => new Date('2026-09-30T01:00:00.000Z'),
    env: { PATH: '/bin', CLAUDE_CODE_REMOTE_SESSION_ID: 'remote-xyz', AGENT_HARNESS_SESSION: 'old' },
    root: '/repo',
    home: HOME,
    node: 'node-bin',
  };
  return { deps, calls, exists, written };
}

const opts = (patch: Partial<CollectOptions> = {}): CollectOptions => ({
  session: SESSION, label: 'fleet-a', issues: [11, 22], snapshotPath: '/tmp/agent-harness-panes/sess-1.json', transcriptCwd: TRANSCRIPT_CWD, intervalSeconds: 180, ...patch,
});

test('collectOnce：fleet-status を渡したセッションの ID で呼び、CLAUDE_CODE_REMOTE_SESSION_ID を子に渡さない', () => {
  const { deps, calls } = fakeDeps();
  collectOnce(deps, opts());
  const fs = calls.find((c) => c.args[1] === 'fleet-status');
  assert.ok(fs, 'fleet-status を呼ぶ');
  assert.equal(fs.cmd, 'node-bin');
  assert.deepEqual(fs.args, ['harness/scripts/agent.ts', 'fleet-status', '--json', '11', '22']);
  assert.equal(fs.opts.cwd, '/repo');
  assert.equal(fs.opts.env.AGENT_HARNESS_SESSION, SESSION);
  assert.equal(fs.opts.env.CLAUDE_CODE_REMOTE_SESSION_ID, undefined);
  assert.equal(fs.opts.env.PATH, '/bin', 'ほかの環境変数は引き継ぐ');
  assert.equal(deps.env.CLAUDE_CODE_REMOTE_SESSION_ID, 'remote-xyz', 'deps.env は書き換えない');
});

test('collectOnce：記録 <ID>.jsonl が無ければ usage を呼ばず、usage は null', () => {
  const { deps, calls, exists } = fakeDeps();
  const s = collectOnce(deps, opts());
  assert.ok(exists.includes(transcriptFile), `${transcriptFile} を確かめる`);
  assert.equal(calls.filter((c) => c.args[1] === 'usage').length, 0);
  assert.equal(s.usage, null);
});

test('collectOnce：記録 <ID>.jsonl があれば usage をその path で呼び、合計とモデル別にする', () => {
  const { deps, calls } = fakeDeps({ existing: [transcriptFile] });
  const s = collectOnce(deps, opts());
  const u = calls.filter((c) => c.args[1] === 'usage');
  assert.equal(u.length, 1);
  assert.deepEqual(u[0]?.args, ['harness/scripts/agent.ts', 'usage', transcriptFile]);
  assert.equal(u[0]?.opts.env.AGENT_HARNESS_SESSION, SESSION);
  assert.deepEqual(s.usage, { totalUsd: 0.5, perModel: { 'claude-opus-5-5': 0.5 } });
});

test('collectOnce：スナップショットを書いて返す（version・at・間隔・セッション・Issue）', () => {
  const { deps, written } = fakeDeps();
  const s = collectOnce(deps, opts());
  assert.equal(written.length, 1);
  assert.equal(written[0]?.path, '/tmp/agent-harness-panes/sess-1.json');
  assert.deepEqual(written[0]?.snap, s);
  assert.equal(s.version, 1);
  assert.equal(s.at, '2026-09-30T01:00:00.000Z');
  assert.equal(s.intervalSeconds, 180);
  assert.equal(s.session, SESSION);
  assert.equal(s.label, 'fleet-a');
  assert.deepEqual(s.issues, [11, 22]);
  assert.equal(s.error, null);
  assert.deepEqual(s.since['1']?.at, s.at);
});

test('collectOnce：fleet 自身の宣言の行は「このセッション」と描かれ、人がすることに出ない', () => {
  const rows = [row(11, { stage: 'plan-review', claim: own('implement') })];
  const { deps } = fakeDeps({ rows });
  const s = collectOnce(deps, opts());
  assert.match(plain(renderProgress(s, NOW, 120)), /このセッション/);
  const todo = plain(renderTodo(s, NOW, 120));
  assert.match(todo, /いまは何もありません/);
  assert.ok(!todo.includes('#11'), todo);
});

test('collectOnce：PR を gh pr view で読み、autoMerge・labels・checks にする', () => {
  const rows = [row(11, { stage: 'judge', pr: 50 })];
  const prJson = {
    50: {
      number: 50, title: 'x', state: 'OPEN', isDraft: true, autoMergeRequest: { enabledAt: '2026-09-30T00:00:00Z' },
      labels: [{ name: 'agent:auto-merge' }], statusCheckRollup: [{ name: 'agent/tests', conclusion: 'FAILURE' }, { context: 'ci/x', state: 'SUCCESS' }],
    },
  };
  const { deps, calls } = fakeDeps({ rows, prJson });
  const s = collectOnce(deps, opts());
  const gh = calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view');
  assert.equal(gh.length, 1);
  assert.deepEqual(gh[0]?.args, ['pr', 'view', '50', '--json', 'number,title,state,isDraft,autoMergeRequest,labels,statusCheckRollup']);
  assert.deepEqual(s.prs, [{
    number: 50, title: 'x', state: 'OPEN', isDraft: true, autoMerge: true, labels: ['agent:auto-merge'],
    checks: [{ name: 'agent/tests', conclusion: 'FAILURE' }, { name: 'ci/x', conclusion: 'SUCCESS' }],
  }]);
});

test('collectOnce：fleet-status・PR が読めなければ前回のものを使い、error に書く', () => {
  const prevRows = [row(11, { stage: 'judge', pr: 50 })];
  const prev = snap(prevRows, { prs: [pr(50, { title: 'prev' })], history: [{ at: 'h0', totalUsd: 0.1 }] });
  const { deps } = fakeDeps({ fleetFails: true, prev });
  const s = collectOnce(deps, opts());
  assert.deepEqual(s.status, prev.status);
  assert.deepEqual(s.prs, [pr(50, { title: 'prev' })]);
  assert.equal(typeof s.error, 'string');
  assert.ok((s.error ?? '').length > 0);
});

test('collectOnce：history は前回に足して末尾 HISTORY_LIMIT 件', () => {
  const history = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ at: `h${i}`, totalUsd: i }));
  const { deps } = fakeDeps({ prev: snap([row(1)], { history }), existing: [transcriptFile] });
  const s = collectOnce(deps, opts());
  assert.equal(s.history.length, HISTORY_LIMIT);
  assert.deepEqual(s.history.at(-1), { at: '2026-09-30T01:00:00.000Z', totalUsd: 0.5 });
  assert.equal(s.history[0]?.at, 'h1');
});

test('startCollect：すぐ1回読み、設定の間隔（秒×1000）で次を予約する', () => {
  const { deps, written } = fakeDeps();
  const scheduled: { fn: () => void; ms: number }[] = [];
  startCollect(deps, opts({ intervalSeconds: 240 }), (fn, ms) => {
    scheduled.push({ fn, ms });
  });
  assert.equal(written.length, 1, '最初に1回 collectOnce');
  assert.ok(scheduled.length >= 1);
  assert.equal(scheduled[0]?.ms, 240_000);
  scheduled[0]?.fn();
  assert.equal(written.length, 2, '予約した関数を呼ぶともう1回読む');
  for (const s of scheduled) assert.equal(s.ms, 240_000);
});

// ---- scripts/panes.ts：render ----

test('startRender：スナップショットを読んで描くだけで、書く文字は CLEAR_SCREEN で始まる', () => {
  // RenderDeps には子のプロセスを動かす手段（run）が無い（描く側は gh・GitHub を呼べない）
  type HasRun = 'run' extends keyof RenderDeps ? true : false;
  const noRun: HasRun = false;
  assert.equal(noRun, false);

  const s = snap([row(1)]);
  const used: string[] = [];
  const out: string[] = [];
  const deps: RenderDeps = {
    readSnapshot: () => { used.push('readSnapshot'); return s; },
    write: (t) => { used.push('write'); out.push(t); },
    now: () => NOW,
    width: () => 80,
  };
  const drawn: (PaneSnapshot | null)[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  startRender(deps, (x, now, width) => { drawn.push(x); return `DRAW ${now} ${width}`; }, (fn, ms) => { scheduled.push({ fn, ms }); });
  assert.equal(out.length, 1);
  assert.equal(out[0], `${CLEAR_SCREEN}DRAW ${NOW} 80`);
  assert.equal(drawn[0], s);
  assert.equal(scheduled[0]?.ms, 5000, '既定の間隔は 5000ms');
  scheduled[0]?.fn();
  assert.equal(out.length, 2);
  assert.ok(out[1]?.startsWith(CLEAR_SCREEN));
  assert.deepEqual([...new Set(used)].sort(), ['readSnapshot', 'write']);

  const s2: { ms: number }[] = [];
  startRender(deps, () => '', (_fn, ms) => { s2.push({ ms }); }, 1000);
  assert.equal(s2[0]?.ms, 1000);
});

test('startRender：スナップショットが無ければ null を描く関数に渡す', () => {
  const out: string[] = [];
  let got: PaneSnapshot | null | undefined;
  startRender({ readSnapshot: () => null, write: (t) => out.push(t), now: () => NOW, width: () => 80 }, (x) => { got = x; return renderProgress(x, NOW, 80); }, () => undefined);
  assert.equal(got, null);
  assert.match(plain(out[0] ?? ''), /最初の読み込み中/);
});

// ---- defaultSnapshotPath ----

test('defaultSnapshotPath：tmp の下の agent-harness-panes/<ID>.json、不正な ID は throw', () => {
  assert.equal(defaultSnapshotPath('/tmp', 'sess-1'), join('/tmp', 'agent-harness-panes', 'sess-1.json'));
  for (const bad of ['../x', '', 'a/b', 'a b']) assert.throws(() => defaultSnapshotPath('/tmp', bad), Error, bad);
});
