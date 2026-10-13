// Issue #652：配布の一覧（harness/managed.json）がリポジトリの全ファイルを覆うことを確かめる。
// git ls-files の全ファイルが managed・projectOwned の path・notDistributed のどれかに当たり、
// managed と notDistributed の両方に当たるファイルが無い。
// exclude（managed に当たっても配らないもの）は managed の glob に当たるので「入っている」扱いにする。
// 重なりの検査も exclude を除かずに managed の glob で行う（exclude に当たるものを notDistributed に重ねて書かない）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { globToRegExp } from '../lib/scope.ts';

const root = join(import.meta.dirname, '..', '..');

interface Managed {
  managed: string[];
  projectOwned: { path: string; template: string }[];
  notDistributed?: string[];
}
const m = JSON.parse(readFileSync(join(root, 'harness/managed.json'), 'utf8')) as Managed;
const matcher = (globs: string[]) => {
  const res = globs.map(globToRegExp);
  return (f: string): boolean => res.some((r) => r.test(f));
};
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const inManaged = matcher(m.managed);
const inOwned = matcher(m.projectOwned.map((o) => o.path));
const inNotDistributed = matcher(m.notDistributed ?? []);

test('managed-coverage：git ls-files の全ファイルが managed・projectOwned・notDistributed のどれかに入る', () => {
  assert.ok(Array.isArray(m.notDistributed), 'managed.json に notDistributed（文字列の配列）が無い');
  const missing = files.filter((f) => !inManaged(f) && !inOwned(f) && !inNotDistributed(f));
  assert.deepEqual(missing, []);
});

test('managed-coverage：managed と notDistributed の両方に当たるファイルが無い', () => {
  const both = files.filter((f) => inManaged(f) && inNotDistributed(f));
  assert.deepEqual(both, []);
});
