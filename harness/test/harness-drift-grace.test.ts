// Issue #812：読み込みの古さに時間の猶予を置く。git の砂場（support/git-sandbox.ts）で cli.ts の harnessDrift() と同じ順
// （記録 harnessVersionsOnDisk → origin で commit の時刻を指定して変えて push → fetch → harnessVersionsAt（origin・merge-base）→ compareHarness
// → firstChangeTimes → assessDrift → judgeBlock）につなぎ、猶予の内の skill の変更では古くない・judge を止めない、判定の担当と規則の変更は
// 猶予の内でも古い（judge を止める）、猶予を過ぎた変更は古い・猶予の時間を変えるとその値で決まる、を確かめる。純粋な端（時刻が読めない・猶予を置かないファイル）も見る。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  assessDrift,
  compareHarness,
  DEFAULT_GRACE_HOURS,
  firstChangeTimes,
  harnessVersionsAt,
  harnessVersionsOnDisk,
  judgeBlock,
  type DriftResult,
} from '../lib/harness-drift.ts';
import { sandbox } from './support/git-sandbox.ts';

const HQ = '.claude/skills/hq/SKILL.md';
const REVIEWER = '.claude/agents/reviewer.md';
const RULES = 'harness/CLAUDE.harness.md';
const SKILLS_README = '.claude/skills/README.md';
const HOUR_MS = 60 * 60 * 1000;

type Sb = ReturnType<typeof sandbox>;

/** ファイルを書いて commit する。at があれば committer の時刻をそれにする */
function put(sb: Sb, cwd: string, files: Record<string, string>, message: string, at?: Date): void {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), body);
    sb.git(cwd, 'add', file);
  }
  const env = at ? { ...process.env, GIT_COMMITTER_DATE: at.toISOString(), GIT_AUTHOR_DATE: at.toISOString() } : process.env;
  const r = spawnSync('git', ['commit', '-qm', message], { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git commit: ${r.stderr}`);
}

/** origin にハーネスのファイルを置き、本体（repo）を追いつかせた砂場 */
function harnessSandbox(t: { after: (fn: () => void) => void }): Sb {
  const sb = sandbox();
  t.after(sb.cleanup);
  put(
    sb,
    sb.seed,
    { 'CLAUDE.md': 'claude\n', [RULES]: 'rules\n', [HQ]: 'hq v1\n', [REVIEWER]: 'reviewer v1\n', [SKILLS_README]: 'skills v1\n', '.claude/settings.json': '{}\n' },
    'harness',
  );
  sb.git(sb.seed, 'push', '-q', 'origin', 'main');
  sb.git(sb.root, 'pull', '-q', '--ff-only');
  return sb;
}

/** seed で commit の時刻を指定して変えて push し、本体では fetch だけする */
function pushFromOrigin(sb: Sb, files: Record<string, string>, at: Date): void {
  put(sb, sb.seed, files, 'origin change', at);
  sb.git(sb.seed, 'push', '-q', 'origin', 'HEAD:main');
  sb.git(sb.root, 'fetch', '-q', 'origin');
}

/** 記録（L）と記録の HEAD を作る（SessionStart の hook が書くのと同じ中身） */
function record(sb: Sb): { loaded: Record<string, string>; head: string } {
  const loaded = harnessVersionsOnDisk(sb.root);
  assert.ok(loaded, '記録の版が読める');
  return { loaded, head: sb.git(sb.root, 'rev-parse', 'HEAD') };
}

/** cli.ts の harnessDrift() と同じ順：compareHarness → firstChangeTimes → assessDrift */
function drift(sb: Sb, rec: { loaded: Record<string, string>; head: string }, graceHours: number, nowMs = Date.now()) {
  const origin = harnessVersionsAt(sb.root, 'origin/main');
  assert.ok(origin, 'origin/main の版が読める');
  const mergeBase = harnessVersionsAt(sb.root, sb.git(sb.root, 'merge-base', rec.head, 'origin/main'));
  assert.ok(mergeBase, 'merge-base の版が読める');
  const raw = compareHarness(rec.loaded, origin, mergeBase);
  const paths = [...raw.changed, ...raw.added, ...raw.removed];
  const times = paths.length === 0 ? {} : firstChangeTimes(sb.root, rec.head, 'origin/main', paths);
  return { raw, times, result: assessDrift(raw, times, nowMs, graceHours) };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR_MS);

// 数えるのは commit の範囲（記録の head..origin/main）で、時刻ではない。GIT_COMMITTER_DATE で過去にした commit は記録の HEAD の commit より
// 前の時刻になるが、範囲の中なので数える（記録の HEAD に含まれる commit は時刻に関係なく数えない）。

test('AC1：origin で hq の SKILL.md だけが猶予の内（1 時間前）に変わった → 古くない、pending に入る、judge は止まらない', (t) => {
  const sb = harnessSandbox(t);
  const rec = record(sb);
  pushFromOrigin(sb, { [HQ]: 'hq v2\n' }, hoursAgo(1));
  const { raw, times, result } = drift(sb, rec, DEFAULT_GRACE_HOURS);
  assert.deepEqual(raw.changed, [HQ], '違うファイルとしては出る');
  assert.ok(times && typeof times[HQ] === 'number', '変更の時刻が読める');
  assert.equal(result.stale, false);
  assert.deepEqual(result.pending, [HQ]);
  assert.deepEqual(result.changed, [HQ], 'changed は raw のまま');
  assert.equal(result.graceHours, DEFAULT_GRACE_HOURS);
  assert.ok(result.pendingUntil, '猶予の切れる時刻がある');
  assert.equal(Date.parse(result.pendingUntil!), times![HQ]! * 1000 + DEFAULT_GRACE_HOURS * HOUR_MS);
  assert.equal(judgeBlock('judge', result), null, 'claim --stage judge は止まらない');
});

test('AC2：判定の担当（reviewer.md）・規則が猶予の内（1 時間前）に変わった → 古い、judge を止める', async (t) => {
  for (const [path, body] of [
    [REVIEWER, 'reviewer v2\n'],
    [RULES, 'rules v2\n'],
  ] as const) {
    await t.test(path, (tt) => {
      const sb = harnessSandbox(tt);
      const rec = record(sb);
      pushFromOrigin(sb, { [path]: body }, hoursAgo(1));
      const { result } = drift(sb, rec, DEFAULT_GRACE_HOURS);
      assert.equal(result.stale, true);
      assert.deepEqual(result.changed, [path]);
      assert.ok(!result.pending.includes(path), '猶予を置かないファイルは pending に入らない');
      assert.equal(typeof judgeBlock('judge', result), 'string', 'claim --stage judge が止まる');
    });
  }
});

test('AC2：猶予の内の hq の変更と、判定の担当の変更が一緒にある → 古い（judge を止める）', (t) => {
  const sb = harnessSandbox(t);
  const rec = record(sb);
  pushFromOrigin(sb, { [HQ]: 'hq v2\n', [REVIEWER]: 'reviewer v2\n' }, hoursAgo(1));
  const { result } = drift(sb, rec, DEFAULT_GRACE_HOURS);
  assert.equal(result.stale, true);
  assert.equal(typeof judgeBlock('judge', result), 'string');
});

test('AC3：hq の SKILL.md が 8 時間前に変わった → 既定の猶予（6）では古い、猶予 12 なら古くない', (t) => {
  assert.equal(DEFAULT_GRACE_HOURS, 6);
  const sb = harnessSandbox(t);
  const rec = record(sb);
  pushFromOrigin(sb, { [HQ]: 'hq v2\n' }, hoursAgo(8));
  const six = drift(sb, rec, DEFAULT_GRACE_HOURS).result;
  assert.equal(six.stale, true);
  assert.equal(typeof judgeBlock('judge', six), 'string', '猶予を過ぎれば今と同じく judge を止める');
  const twelve = drift(sb, rec, 12).result;
  assert.equal(twelve.stale, false);
  assert.deepEqual(twelve.pending, [HQ]);
  assert.equal(twelve.graceHours, 12);
  assert.equal(judgeBlock('judge', twelve), null);
});

test('AC3：猶予の内の変更の後に同じファイルをまた変えても、一番古い変更（8 時間前）から数える', (t) => {
  const sb = harnessSandbox(t);
  const rec = record(sb);
  pushFromOrigin(sb, { [HQ]: 'hq v2\n' }, hoursAgo(8));
  pushFromOrigin(sb, { [HQ]: 'hq v3\n' }, hoursAgo(1));
  assert.equal(drift(sb, rec, DEFAULT_GRACE_HOURS).result.stale, true);
});

test('記録の HEAD に含まれる変更は数えない：記録より前に取り込んだ commit（8 時間前）の後、猶予の内（1 時間前）に変わった → 古くない', (t) => {
  const sb = harnessSandbox(t);
  pushFromOrigin(sb, { [HQ]: 'hq v2\n' }, hoursAgo(8));
  sb.git(sb.root, 'merge', '-q', '--ff-only', 'origin/main');
  const rec = record(sb);
  pushFromOrigin(sb, { [HQ]: 'hq v3\n' }, hoursAgo(1));
  const { result } = drift(sb, rec, DEFAULT_GRACE_HOURS);
  assert.equal(result.stale, false);
  assert.deepEqual(result.pending, [HQ]);
});

test('猶予 0 → 猶予の内の変更でも古い（今と同じ判断）', (t) => {
  const sb = harnessSandbox(t);
  const rec = record(sb);
  pushFromOrigin(sb, { [HQ]: 'hq v2\n' }, hoursAgo(1));
  assert.equal(drift(sb, rec, 0).result.stale, true);
});

test('要件5：origin で .claude/skills/ の下の README.md だけが変わった → compareHarness は古くない', (t) => {
  const sb = harnessSandbox(t);
  const rec = record(sb);
  pushFromOrigin(sb, { [SKILLS_README]: 'skills v2\n' }, hoursAgo(100));
  const { raw, result } = drift(sb, rec, DEFAULT_GRACE_HOURS);
  assert.deepEqual(raw, { stale: false, changed: [], added: [], removed: [] });
  assert.equal(result.stale, false);
});

test('firstChangeTimes：記録の head が無い（null）なら null', (t) => {
  const sb = harnessSandbox(t);
  assert.equal(firstChangeTimes(sb.root, null, 'origin/main', [HQ]), null);
});

const raw = (changed: string[], added: string[] = [], removed: string[] = []): DriftResult => ({
  stale: changed.length + added.length + removed.length > 0,
  changed,
  added,
  removed,
});

test('assessDrift（純粋）：時刻が分からない違い → 古い（安全側）', () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  assert.equal(assessDrift(raw([HQ]), null, now, DEFAULT_GRACE_HOURS).stale, true, 'times が null');
  assert.equal(assessDrift(raw([HQ]), {}, now, DEFAULT_GRACE_HOURS).stale, true, 'times にそのパスが無い');
  assert.equal(assessDrift(raw([], [HQ]), { [HQ]: nowSec - 3600 }, now, DEFAULT_GRACE_HOURS).stale, false, 'added も猶予の内なら古くない');
  const none = assessDrift(raw([]), {}, now, DEFAULT_GRACE_HOURS);
  assert.equal(none.stale, false);
  assert.deepEqual(none.pending, []);
  assert.equal(none.pendingUntil, null);
});

test('assessDrift（純粋）：猶予を置かないファイル（規則・settings・判定の担当）は 1 時間前の変更でも古い。ほかの担当・skill は猶予の内なら古くない', () => {
  const now = Date.now();
  const at = Math.floor(now / 1000) - 3600;
  const cases: [string, boolean][] = [
    [RULES, true],
    ['.claude/settings.json', true],
    [REVIEWER, true],
    ['.claude/agents/risk-agent.md', true],
    ['.claude/agents/review-lens.md', true],
    ['.claude/agents/review-scorer.md', true],
    ['.claude/skills/judge/SKILL.md', true],
    ['.claude/skills/review-panel/SKILL.md', true],
    ['.claude/agents/plan-critic.md', false],
    ['.claude/agents/test-designer.md', false],
    ['.claude/skills/ship/SKILL.md', false],
    ['.claude/skills/fleet/SKILL.md', false],
    ['CLAUDE.md', false],
  ];
  for (const [path, stale] of cases) {
    for (const r of [raw([path]), raw([], [path]), raw([], [], [path])]) {
      const result = assessDrift(r, { [path]: at }, now, DEFAULT_GRACE_HOURS);
      assert.equal(result.stale, stale, path);
      assert.equal(judgeBlock('judge', result) !== null, stale, `${path} の judge`);
    }
  }
});
