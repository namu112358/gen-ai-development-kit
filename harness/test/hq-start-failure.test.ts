// Issue #551：起動の失敗の控え（hq-start-failures.json）を確かめる。skill の文は hq-skill.test.ts で確かめる
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hqStateDir, parseScreen } from '../scripts/hq-state.ts';

type StartFailure = {
  dispatch: string; theme: string; stage: string; screen: string[]; hasDraft: boolean;
  resent: 'accepted' | 'unobserved' | 'none' | null; at: string;
};
type StartFailureFile = { version: 1; failures: StartFailure[] };

const root = join(import.meta.dirname, '..', '..');
const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-start-failure-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const cli = (dir: string, args: string[]) =>
  spawnSync(process.execPath, ['harness/scripts/hq-state.ts', ...args, '--common-dir', dir], { cwd: root, encoding: 'utf8' });
const writeScreen = (dir: string, name: string, body: string): string => {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
};
const workerRead = (tail: string[], draft: string): string => JSON.stringify({ result: { terminal: { tail, draft } } });
const save = (dir: string, dispatch: string, screenFile: string, extra: string[] = []) => {
  const r = cli(dir, ['start-failure-save', '--dispatch', dispatch, '--theme', 'ops', '--stage', 'worker-start', '--screen-file', screenFile, ...extra]);
  assert.equal(r.status, 0, r.stderr);
};
const readFailures = (dir: string): StartFailureFile | null => {
  const r = cli(dir, ['start-failures']);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as StartFailureFile | null;
};

// ---- parseScreen（単体） ----

test('parseScreen：60 行の tail は末尾 50 行だけ残る', () => {
  const tail = Array.from({ length: 60 }, (_, i) => `line${i}`);
  const r = parseScreen(workerRead(tail, ''));
  assert.deepEqual(r.screen, tail.slice(10));
  assert.equal(r.hasDraft, false);
});

// ---- CLI start-failure-save / start-failures ----

test('CLI start-failures：控えが無いときは null', () => withDir((dir) => {
  assert.equal(readFailures(dir), null);
}));

test('CLI start-failure-save：worker-read の JSON から tail と hasDraft が残り、draft の本文は残らない。resent は省略で null', () => withDir((dir) => {
  const cases = [
    { dispatch: 'd-draft', draft: '入力欄に残った指示の本文', hasDraft: true },
    { dispatch: 'd-empty', draft: '', hasDraft: false },
  ];
  for (const c of cases) save(dir, c.dispatch, writeScreen(dir, `${c.dispatch}.json`, workerRead(['画面1', '画面2'], c.draft)));
  const file = readFailures(dir);
  assert.ok(file, 'start-failures が null');
  assert.equal(file.version, 1);
  for (const c of cases) {
    const f: StartFailure | undefined = file.failures.find((x) => x.dispatch === c.dispatch);
    assert.ok(f, `${c.dispatch} が無い：${JSON.stringify(file)}`);
    assert.deepEqual(f.screen, ['画面1', '画面2']);
    assert.equal(f.hasDraft, c.hasDraft, c.dispatch);
    assert.equal(f.theme, 'ops');
    assert.equal(f.stage, 'worker-start');
    assert.equal(f.resent, null);
    assert.ok(!Number.isNaN(Date.parse(f.at)), f.at);
  }
  // 控えのファイルの置き場所と、draft の本文が残らないこと
  const raw = readFileSync(join(hqStateDir(dir), 'hq-start-failures.json'), 'utf8');
  assert.ok(!raw.includes('入力欄に残った指示の本文'), raw);
}));

test('CLI start-failure-save：JSON でない画面は \\r\\n を行に分けた末尾 50 行が残り、hasDraft は false', () => withDir((dir) => {
  const lines = Array.from({ length: 55 }, (_, i) => `raw${i}`);
  save(dir, 'd-raw', writeScreen(dir, 'raw.txt', lines.join('\r\n')));
  const f = readFailures(dir)?.failures.find((x) => x.dispatch === 'd-raw');
  assert.ok(f);
  assert.deepEqual(f.screen, lines.slice(5));
  assert.equal(f.hasDraft, false);
}));

test('CLI start-failure-save：同じ dispatch を --resent accepted で保存し直すと前の件を置き換える', () => withDir((dir) => {
  const screen = writeScreen(dir, 's.json', workerRead(['x'], ''));
  save(dir, 'd1', screen);
  save(dir, 'd1', screen, ['--resent', 'accepted']);
  const file = readFailures(dir);
  assert.equal(file?.failures.length, 1, JSON.stringify(file));
  assert.equal(file?.failures[0]?.resent, 'accepted');
}));

test('CLI start-failure-save：21 件保存すると最古が落ちて 20 件になる', () => withDir((dir) => {
  const screen = writeScreen(dir, 's.json', workerRead(['x'], ''));
  for (let i = 0; i < 21; i++) save(dir, `d${i}`, screen);
  const file = readFailures(dir);
  assert.equal(file?.failures.length, 20);
  const ids = file?.failures.map((f) => f.dispatch) ?? [];
  assert.ok(!ids.includes('d0'), ids.join(','));
  assert.ok(ids.includes('d20'), ids.join(','));
}));

test('CLI start-failure-save：--resent に不正な値なら 0 以外で終わり、控えを書かない', () => withDir((dir) => {
  const screen = writeScreen(dir, 's.json', workerRead(['x'], ''));
  const r = cli(dir, ['start-failure-save', '--dispatch', 'd1', '--theme', 'ops', '--stage', 'worker-start', '--screen-file', screen, '--resent', 'maybe']);
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(join(hqStateDir(dir), 'hq-start-failures.json')), false);
}));
