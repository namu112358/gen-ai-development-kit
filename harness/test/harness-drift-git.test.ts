// Issue #199：git の砂場（support/git-sandbox.ts）で、読み込みの記録（harnessVersionsOnDisk）と origin・merge-base の版（harnessVersionsAt）を作り、
// compareHarness が「古い」を正しく判断するか（cli.ts の harnessDrift() と同じ git の読み方）。origin がハーネスのファイルを変えた・本体が origin より
// 古いまま記録した → 古い。対象の外のファイルの変更・ブランチが自分で skill を変えただけ → 古くない。そのうえで origin が別のハーネスのファイルを変えた → 古い。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { compareHarness, contentVersion, harnessVersionsAt, harnessVersionsOnDisk } from '../lib/harness-drift.ts';
import { sandbox } from './support/git-sandbox.ts';

const SHIP = '.claude/skills/ship/SKILL.md';
const FLEET = '.claude/skills/fleet/SKILL.md';
const RULES = 'harness/CLAUDE.harness.md';

type Sb = ReturnType<typeof sandbox>;

/** ファイルを書いて commit する（ディレクトリは作る） */
function put(sb: Sb, cwd: string, files: Record<string, string>, message = 'change'): string {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), body);
    sb.git(cwd, 'add', file);
  }
  sb.git(cwd, 'commit', '-qm', message);
  return sb.git(cwd, 'rev-parse', 'HEAD');
}

/** origin（seed から push）にハーネスのファイルと対象の外のファイルを置き、本体（repo）を追いつかせた砂場 */
function harnessSandbox(t: { after: (fn: () => void) => void }): Sb {
  const sb = sandbox();
  t.after(sb.cleanup);
  put(sb, sb.seed, { 'CLAUDE.md': 'claude\n', [RULES]: 'rules\n', [SHIP]: 'ship v1\n', [FLEET]: 'fleet v1\n', '.claude/settings.json': '{}\n', 'harness/lib/x.ts': 'x\n' }, 'harness');
  sb.git(sb.seed, 'push', '-q', 'origin', 'main');
  sb.git(sb.root, 'pull', '-q', '--ff-only');
  return sb;
}

/** seed（origin に push するのは seed だけ）で変えて push し、本体では fetch だけする */
function pushFromOrigin(sb: Sb, files: Record<string, string>): void {
  put(sb, sb.seed, files, 'origin change');
  sb.git(sb.seed, 'push', '-q', 'origin', 'HEAD:main');
  sb.git(sb.root, 'fetch', '-q', 'origin');
}

/** cli.ts の harnessDrift() と同じ比べ方：記録（L）と head から、origin/main の版（O）と merge-base の版（M） */
function drift(sb: Sb, cwd: string, loaded: Record<string, string>, head: string) {
  const origin = harnessVersionsAt(cwd, 'origin/main');
  assert.ok(origin, 'origin/main の版が読める');
  const base = sb.git(cwd, 'merge-base', head, 'origin/main');
  const mergeBase = harnessVersionsAt(cwd, base);
  assert.ok(mergeBase, 'merge-base の版が読める');
  return compareHarness(loaded, origin, mergeBase);
}

test('harnessVersionsOnDisk：対象のファイル（git ls-files）だけの版。対象の外のファイルは入らない、中身の版は contentVersion', (t) => {
  const sb = harnessSandbox(t);
  const v = harnessVersionsOnDisk(sb.root);
  assert.ok(v);
  assert.deepEqual(Object.keys(v).sort(), ['.claude/settings.json', FLEET, SHIP, 'CLAUDE.md', RULES].sort());
  assert.equal(v[SHIP], contentVersion('ship v1\n'));
});

test('harnessVersionsOnDisk：ディスクの中身を読む（CRLF で置かれていても LF と同じ版）、未 commit の変更も入る', (t) => {
  const sb = harnessSandbox(t);
  writeFileSync(join(sb.root, SHIP), 'ship v1\r\n');
  assert.equal(harnessVersionsOnDisk(sb.root)![SHIP], contentVersion('ship v1\n'));
  writeFileSync(join(sb.root, SHIP), 'ship local\n');
  assert.equal(harnessVersionsOnDisk(sb.root)![SHIP], contentVersion('ship local\n'));
});

test('harnessVersionsAt：ref の中身の版はディスクから作った版と同じ表。知らない ref・git の外なら null', (t) => {
  const sb = harnessSandbox(t);
  assert.deepEqual(harnessVersionsAt(sb.root, 'origin/main'), harnessVersionsOnDisk(sb.root));
  assert.deepEqual(harnessVersionsAt(sb.root, 'HEAD'), harnessVersionsOnDisk(sb.root));
  assert.equal(harnessVersionsAt(sb.root, 'no-such-ref'), null);
  assert.equal(harnessVersionsAt(sb.dir, 'HEAD'), null, 'git の外');
  assert.equal(harnessVersionsOnDisk(sb.dir), null, 'git の外');
});

test('記録の後に origin がハーネスのファイルを変えて push した → 古い（changed に出る）', (t) => {
  const sb = harnessSandbox(t);
  const loaded = harnessVersionsOnDisk(sb.root)!;
  const head = sb.git(sb.root, 'rev-parse', 'HEAD');
  assert.equal(drift(sb, sb.root, loaded, head).stale, false, '変わる前は古くない');
  pushFromOrigin(sb, { [SHIP]: 'ship v2\n' });
  assert.deepEqual(drift(sb, sb.root, loaded, head), { stale: true, changed: [SHIP], added: [], removed: [] });
});

test('origin にハーネスのファイルが増えた → 古い（added）', (t) => {
  const sb = harnessSandbox(t);
  const loaded = harnessVersionsOnDisk(sb.root)!;
  const head = sb.git(sb.root, 'rev-parse', 'HEAD');
  pushFromOrigin(sb, { '.claude/agents/reviewer.md': 'reviewer\n' });
  assert.deepEqual(drift(sb, sb.root, loaded, head), { stale: true, changed: [], added: ['.claude/agents/reviewer.md'], removed: [] });
});

test('本体の checkout が origin より古いまま記録した（fetch 済み・未 pull）→ 最初から古い', (t) => {
  const sb = harnessSandbox(t);
  pushFromOrigin(sb, { [FLEET]: 'fleet v2\n' });
  // 本体は追いつかせないまま始めた
  const loaded = harnessVersionsOnDisk(sb.root)!;
  const head = sb.git(sb.root, 'rev-parse', 'HEAD');
  assert.deepEqual(drift(sb, sb.root, loaded, head), { stale: true, changed: [FLEET], added: [], removed: [] });
});

test('origin が対象の外のファイル（harness/lib・README）だけを変えた → 古くない', (t) => {
  const sb = harnessSandbox(t);
  const loaded = harnessVersionsOnDisk(sb.root)!;
  const head = sb.git(sb.root, 'rev-parse', 'HEAD');
  pushFromOrigin(sb, { 'harness/lib/x.ts': 'x2\n', 'README.md': 'readme\n', '.claude/hooks/session-env.ts': '// hook\n' });
  assert.deepEqual(drift(sb, sb.root, loaded, head), { stale: false, changed: [], added: [], removed: [] });
});

test('ブランチ（worktree）で skill を自分で変えて記録、origin は変えていない → 古くない。そのうえで origin が別のハーネスのファイルを変えた → 古い', (t) => {
  const sb = harnessSandbox(t);
  const wt = join(sb.dir, 'wt');
  sb.git(sb.root, 'worktree', 'add', '-q', '-b', 'claude/issue-199-x', wt, 'origin/main');
  const head = put(sb, wt, { [SHIP]: 'ship mine\n' }, 'branch edits ship');
  const loaded = harnessVersionsOnDisk(wt)!;
  assert.equal(loaded[SHIP], contentVersion('ship mine\n'));
  assert.deepEqual(drift(sb, wt, loaded, head), { stale: false, changed: [], added: [], removed: [] }, '自分の変更は古いと数えない');

  pushFromOrigin(sb, { [FLEET]: 'fleet v2\n' });
  assert.deepEqual(drift(sb, wt, loaded, head), { stale: true, changed: [FLEET], added: [], removed: [] }, 'origin が別のファイルを変えた');
});

test('ブランチが変えた skill を origin もその後に変えた → 古い', (t) => {
  const sb = harnessSandbox(t);
  const wt = join(sb.dir, 'wt');
  sb.git(sb.root, 'worktree', 'add', '-q', '-b', 'claude/issue-199-y', wt, 'origin/main');
  const head = put(sb, wt, { [SHIP]: 'ship mine\n' }, 'branch edits ship');
  const loaded = harnessVersionsOnDisk(wt)!;
  pushFromOrigin(sb, { [SHIP]: 'ship theirs\n' });
  assert.deepEqual(drift(sb, wt, loaded, head), { stale: true, changed: [SHIP], added: [], removed: [] });
});
