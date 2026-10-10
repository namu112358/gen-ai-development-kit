// Issue #570：mod（mods/agent-harness/）を変えたら plugin.json の version を上げる。上げないと `claude plugin update` で届かない。
// main（origin の既定のブランチ）との merge-base から mod が変わっていて、版が base より大きくなければ `npm run check` を落とす。
// git の砂場（support/git-sandbox.ts）で判定を確かめ、最後にこのリポジトリ自体に当てる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { sandbox } from './support/git-sandbox.ts';

const MOD = 'mods/agent-harness';
const PLUGIN_JSON = `${MOD}/.claude-plugin/plugin.json`;

/** x.y.z を数字3つで比べる（a が大きければ正、同じなら 0、小さければ負）。どちらかが x.y.z で読めなければ null */
function compareVersion(a: string, b: string): number | null {
  const re = /^\d+\.\d+\.\d+$/;
  if (!re.test(a) || !re.test(b)) return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

/** baseRef との merge-base から mod が変わっていて、plugin.json の version が上がっていなければ problem。merge-base が取れなければ skip */
function modVersionProblem(cwd: string, baseRef: string): { skip: string } | { problem: string } | null {
  const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const mb = git('merge-base', 'HEAD', baseRef);
  const base = mb.status === 0 ? mb.stdout.trim() : '';
  if (!base) return { skip: `${baseRef} との merge-base が取れない（履歴が無い）` };
  const changed = git('diff', '--name-only', base, '--', MOD).stdout.trim();
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', MOD).stdout.trim();
  if (!changed && !untracked) return null;
  const old = git('show', `${base}:${PLUGIN_JSON}`);
  if (old.status !== 0) return null;
  const readVersion = (text: string): string => {
    try {
      const v = (JSON.parse(text) as { version?: unknown }).version;
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  };
  const baseVersion = readVersion(old.stdout);
  let nowText = '';
  try {
    nowText = readFileSync(join(cwd, PLUGIN_JSON), 'utf8');
  } catch {}
  const nowVersion = readVersion(nowText);
  const cmp = compareVersion(nowVersion, baseVersion);
  if (cmp !== null && cmp > 0) return null;
  return {
    problem: `${MOD}/ を変えたので plugin.json の version を上げる。上げないと claude plugin update で届かない（base: ${baseVersion || '読めない'}、今: ${nowVersion || '読めない'}）`,
  };
}

type Sb = ReturnType<typeof sandbox>;

const pluginJson = (version: string) => `${JSON.stringify({ name: 'agent-harness', version }, null, 2)}\n`;

/** ファイルを書く（ディレクトリは作る）。commit を渡せば add して commit する */
function put(sb: Sb, cwd: string, files: Record<string, string>, message?: string): void {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), body);
    if (message) sb.git(cwd, 'add', file);
  }
  if (message) sb.git(cwd, 'commit', '-qm', message);
}

/** origin/main に mod（版 0.1.0）を置き、本体（repo）を追いつかせてブランチを切った砂場 */
function modSandbox(t: { after: (fn: () => void) => void }): Sb {
  const sb = sandbox();
  t.after(sb.cleanup);
  put(sb, sb.seed, { [PLUGIN_JSON]: pluginJson('0.1.0'), [`${MOD}/README.md`]: 'mod\n', 'harness/x.ts': 'x\n' }, 'mod');
  sb.git(sb.seed, 'push', '-q', 'origin', 'main');
  sb.git(sb.root, 'pull', '-q', '--ff-only');
  sb.git(sb.root, 'checkout', '-qb', 'claude/issue-1-x');
  return sb;
}

test('compareVersion：x.y.z を数字で比べる。x.y.z でなければ null', () => {
  const cases: [string, string, 'gt' | 'eq' | 'lt' | null][] = [
    ['0.1.1', '0.1.0', 'gt'],
    ['0.2.0', '0.1.9', 'gt'],
    ['1.0.0', '0.9.9', 'gt'],
    ['0.10.0', '0.9.0', 'gt'],
    ['0.1.0', '0.1.0', 'eq'],
    ['0.1.0', '0.1.1', 'lt'],
    ['0.1', '0.1.0', null],
    ['0.1.0-beta', '0.1.0', null],
    ['', '0.1.0', null],
    ['0.1.0', 'x', null],
  ];
  for (const [a, b, want] of cases) {
    const got = compareVersion(a, b);
    const sign = got === null ? null : got > 0 ? 'gt' : got < 0 ? 'lt' : 'eq';
    assert.equal(sign, want, `${a} と ${b}`);
  }
});

test('mod を変えて commit し、版が同じ → problem（上げる指示と base・今の版が出る）', (t) => {
  const sb = modSandbox(t);
  put(sb, sb.root, { [`${MOD}/README.md`]: 'mod changed\n' }, 'change mod');
  const r = modVersionProblem(sb.root, 'origin/main');
  assert.ok(r && 'problem' in r, JSON.stringify(r));
  assert.match(r.problem, /plugin\.json の version を上げる/);
  assert.match(r.problem, /claude plugin update/);
  assert.match(r.problem, /0\.1\.0/);
});

test('mod を変えたのが未 commit・未追跡の新しいファイルだけでも、版が同じなら problem', (t) => {
  const sb = modSandbox(t);
  put(sb, sb.root, { [`${MOD}/hooks/new.ts`]: 'new\n' });
  const r = modVersionProblem(sb.root, 'origin/main');
  assert.ok(r && 'problem' in r, JSON.stringify(r));
});

test('mod を変えて、作業ツリーで未 commit の変更だけでも、版が同じなら problem', (t) => {
  const sb = modSandbox(t);
  put(sb, sb.root, { [`${MOD}/README.md`]: 'mod edited\n' });
  const r = modVersionProblem(sb.root, 'origin/main');
  assert.ok(r && 'problem' in r, JSON.stringify(r));
});

test('mod を変えて版を下げた・x.y.z でない版にした → problem', (t) => {
  for (const version of ['0.0.9', 'next']) {
    const sb = modSandbox(t);
    put(sb, sb.root, { [`${MOD}/README.md`]: 'mod changed\n', [PLUGIN_JSON]: pluginJson(version) }, 'change mod');
    const r = modVersionProblem(sb.root, 'origin/main');
    assert.ok(r && 'problem' in r, `${version}: ${JSON.stringify(r)}`);
  }
});

test('mod を変えて版を上げた → null（commit 済みでも未 commit でも）', (t) => {
  const sb = modSandbox(t);
  put(sb, sb.root, { [`${MOD}/README.md`]: 'mod changed\n', [PLUGIN_JSON]: pluginJson('0.1.1') }, 'change mod');
  assert.equal(modVersionProblem(sb.root, 'origin/main'), null);

  const sb2 = modSandbox(t);
  put(sb2, sb2.root, { [`${MOD}/hooks/new.ts`]: 'new\n', [PLUGIN_JSON]: pluginJson('0.2.0') });
  assert.equal(modVersionProblem(sb2.root, 'origin/main'), null);
});

test('mod の外だけを変えた → null', (t) => {
  const sb = modSandbox(t);
  put(sb, sb.root, { 'harness/x.ts': 'x changed\n' }, 'outside');
  put(sb, sb.root, { 'harness/y.ts': 'untracked\n' });
  assert.equal(modVersionProblem(sb.root, 'origin/main'), null);
});

test('origin の無いリポジトリ（git init だけ）→ skip', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.com');
  mkdirSync(join(dir, MOD, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, PLUGIN_JSON), pluginJson('0.1.0'));
  git('add', '.');
  git('commit', '-qm', 'init');
  const r = modVersionProblem(dir, 'origin/main');
  assert.ok(r && 'skip' in r, JSON.stringify(r));
});

test('このリポジトリ：mod を変えたなら plugin.json の version が main より上がっている', (t) => {
  const r = modVersionProblem(process.cwd(), `origin/${loadConfig().defaultBranch}`);
  if (r && 'skip' in r) {
    t.skip(r.skip);
    return;
  }
  assert.equal(r, null, r && 'problem' in r ? r.problem : '');
});
