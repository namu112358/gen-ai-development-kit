// Issue #1034：agent.ts fleet-config が panes.ts config と同じ出力を出すことと、fleet・ship の skill と参照用のファイルに panes.ts config の参照が無いこと。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const run = (script: string, arg: string) =>
  spawnSync(process.execPath, [join(root, 'harness', 'scripts', script), arg], { cwd: root, encoding: 'utf8' });

test('agent.ts fleet-config：標準出力・終了コード・標準エラーが panes.ts config と同じ', () => {
  const a = run('agent.ts', 'fleet-config');
  const p = run('panes.ts', 'config');
  assert.equal(a.status, p.status, a.stderr);
  assert.equal(a.stdout, p.stdout);
  assert.equal(a.stderr, p.stderr);
});

test('fleet・ship の skill と fleet の参照用のファイルに panes.ts config の参照が無い', () => {
  const refs = join('.claude', 'skills', 'fleet', 'references');
  const files = [
    join('.claude', 'skills', 'fleet', 'SKILL.md'),
    join('.claude', 'skills', 'ship', 'SKILL.md'),
    ...readdirSync(join(root, refs)).filter((f) => f.endsWith('.md')).map((f) => join(refs, f)),
  ];
  const hits = files.filter((f) => readFileSync(join(root, f), 'utf8').includes('panes.ts config'));
  assert.deepEqual(hits, []);
});
