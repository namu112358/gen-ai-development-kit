// Issue #651：kit の版を指定して配布物を写す harness/scripts/sync.ts を、git の砂場（注釈付きタグ v1 を持つ kit と、古い版の導入先）で動かし、
// --dry-run の一覧と何も書かないこと、本番の後の中身・harness/kit-version.json・除外・settings の merge・--prune・止まる場合の終了コードを確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const syncPath = join(root, 'harness', 'scripts', 'sync.ts');

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const put = (dir: string, path: string, content: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');

const initRepo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
};

const commitAll = (dir: string, msg: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
};

const KIT_SETTINGS = {
  permissions: { deny: ['Bash(kit-deny)'], allow: ['Bash(kit-allow)'], disableBypassPermissionsMode: 'disable' },
};
const TARGET_SETTINGS = { permissions: { deny: ['Bash(old-deny)'], allow: ['Bash(local-allow)'] } };

/**
 * kit：このリポジトリの harness/managed.json と managed の数ファイル・projectOwned の雛形・.claude/settings.json を写し、
 * `git tag -a v1` の後にもう1つ commit する（v1 の中身が写ることを確かめるため）。
 * 導入先：古い版の managed・導入先だけの managed・managed.local.json の除外1件・独自の allow を持つ settings を commit する。
 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-cli-'));
  tmpDirs.push(dir);
  const kit = join(dir, 'kit');
  const target = join(dir, 'target');

  initRepo(kit);
  for (const p of [
    'harness/managed.json',
    'harness/templates/harness.config.json',
    'harness/templates/CLAUDE.template.md',
  ]) {
    put(kit, p, read(root, p));
  }
  put(kit, 'harness/CLAUDE.harness.md', 'kit v1 rules\n');
  put(kit, '.claude/routine.md', 'kit v1 routine\n');
  put(kit, '.claude/agents/reviewer.md', 'kit v1 reviewer\n');
  put(kit, 'harness/lib/same.ts', 'export const same = 1;\n');
  put(kit, '.claude/settings.json', `${JSON.stringify(KIT_SETTINGS, null, 2)}\n`);
  put(kit, 'README.md', 'kit readme (not managed)\n');
  commitAll(kit, 'v1');
  git(kit, 'tag', '-a', 'v1', '-m', 'v1');
  put(kit, 'harness/CLAUDE.harness.md', 'kit v2 rules\n');
  commitAll(kit, 'v2');

  initRepo(target);
  put(target, 'harness/CLAUDE.harness.md', 'old rules\n');
  put(target, '.claude/agents/reviewer.md', 'local reviewer\n');
  put(target, 'harness/lib/same.ts', 'export const same = 1;\n');
  put(target, '.claude/skills/local-only/SKILL.md', 'local only skill\n');
  put(target, 'harness/managed.local.json', `${JSON.stringify({ exclude: ['.claude/agents/reviewer.md'] }, null, 2)}\n`);
  put(target, '.claude/settings.json', `${JSON.stringify(TARGET_SETTINGS, null, 2)}\n`);
  put(target, 'CLAUDE.md', 'project claude\n');
  put(target, 'README.md', 'target readme\n');
  commitAll(target, 'old');

  return {
    kit,
    target,
    v1Commit: git(kit, 'rev-parse', 'v1^{commit}'),
    v1TagObject: git(kit, 'rev-parse', 'v1'),
  };
}

const runSync = (cwd: string, args: string[]) =>
  spawnSync(process.execPath, [syncPath, ...args], { cwd, encoding: 'utf8', env: process.env });

test('--dry-run は上書き・新規・除外・kit に無い managed・settings の changedKeys・ref と SHA を出し、何も書かない', () => {
  const s = sandbox();
  assert.notEqual(s.v1Commit, s.v1TagObject, '砂場の v1 は注釈付きタグであること');
  const r = runSync(s.target, ['v1', '--from', s.kit, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  for (const want of [
    'harness/CLAUDE.harness.md', // 上書き
    '.claude/routine.md', // 新規
    'harness.config.json', // 新規（projectOwned）
    '.claude/agents/reviewer.md', // 除外
    '.claude/skills/local-only/SKILL.md', // kit に無い managed
    '--prune',
    'permissions.deny', // settings の changedKeys
    'permissions.disableBypassPermissionsMode',
    'v1',
    s.v1Commit,
  ]) {
    assert.ok(r.stdout.includes(want), `標準出力に ${want} がありません:\n${r.stdout}`);
  }
  assert.equal(git(s.target, 'status', '--porcelain', '--untracked-files=all'), '', '--dry-run で導入先が変わりました');
  assert.ok(!existsSync(join(s.target, 'harness', 'kit-version.json')));
});

test('本番は v1 の中身を写し、kit-version.json に commit の SHA を記録し、除外と導入先だけのファイルと独自の settings を残す', () => {
  const s = sandbox();
  const r = runSync(s.target, ['v1', '--from', s.kit]);
  assert.equal(r.status, 0, r.stderr);

  // 上書き・新規は kit の v1 と同じ（v1 の後の commit の中身ではない）
  assert.equal(read(s.target, 'harness/CLAUDE.harness.md'), 'kit v1 rules\n');
  assert.equal(read(s.target, '.claude/routine.md'), 'kit v1 routine\n');
  assert.equal(read(s.target, 'harness.config.json'), read(root, 'harness/templates/harness.config.json'));
  assert.equal(read(s.target, 'harness/lib/same.ts'), 'export const same = 1;\n');
  // 導入先のもの（projectOwned の既存・managed に当たらない）は変わらない
  assert.equal(read(s.target, 'CLAUDE.md'), 'project claude\n');
  assert.equal(read(s.target, 'README.md'), 'target readme\n');
  // 除外したファイルは変わらない
  assert.equal(read(s.target, '.claude/agents/reviewer.md'), 'local reviewer\n');
  // --prune 無しでは導入先だけの managed は残る
  assert.equal(read(s.target, '.claude/skills/local-only/SKILL.md'), 'local only skill\n');

  const settings = JSON.parse(read(s.target, '.claude/settings.json'));
  assert.deepEqual(settings.permissions.allow, ['Bash(local-allow)']);
  assert.deepEqual(settings.permissions.deny, KIT_SETTINGS.permissions.deny);
  assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');

  const version = JSON.parse(read(s.target, 'harness/kit-version.json'));
  assert.deepEqual(Object.keys(version).sort(), ['ref', 'repository', 'sha', 'syncedAt']);
  assert.equal(version.repository, s.kit);
  assert.equal(version.ref, 'v1');
  assert.equal(version.sha, s.v1Commit);
  assert.notEqual(version.sha, s.v1TagObject);
  assert.ok(!Number.isNaN(Date.parse(version.syncedAt)), version.syncedAt);
});

test('--prune ありは kit に無い managed のファイルを消し、除外したファイルは残す', () => {
  const s = sandbox();
  const r = runSync(s.target, ['v1', '--from', s.kit, '--prune']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(s.target, '.claude/skills/local-only/SKILL.md')));
  assert.equal(read(s.target, '.claude/agents/reviewer.md'), 'local reviewer\n');
});

test('git のリポジトリでない・存在しない ref は終了コード 1 で止まり、kit-version.json を書かない', () => {
  const s = sandbox();
  const plain = mkdtempSync(join(tmpdir(), 'sync-cli-plain-'));
  tmpDirs.push(plain);
  const cases: { name: string; cwd: string; args: string[] }[] = [
    { name: 'git でない', cwd: plain, args: ['v1', '--from', s.kit] },
    { name: '存在しない ref', cwd: s.target, args: ['no-such-ref', '--from', s.kit] },
  ];
  for (const c of cases) {
    const r = runSync(c.cwd, c.args);
    assert.equal(r.status, 1, `${c.name}: ${r.stdout}${r.stderr}`);
    assert.ok(!existsSync(join(c.cwd, 'harness', 'kit-version.json')), c.name);
  }
  assert.equal(git(s.target, 'status', '--porcelain', '--untracked-files=all'), '');
});
