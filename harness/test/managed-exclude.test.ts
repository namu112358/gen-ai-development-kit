/**
 * harness/managed.json の exclude（managed に当たっても導入先に配らない、このリポジトリ専用の観測系）の検査（Issue #643）。
 * exclude の各項目が実在して managed の glob に当たること、Issue の根拠に名前のある観測系が exclude にあること、
 * 配るほうの .ts が exclude のファイルを相対 import していない（導入先で import が壊れない）ことを確かめる。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { globToRegExp } from '../lib/scope.ts';

const root = join(import.meta.dirname, '..', '..');
const loadManaged = (): { managed: string[]; exclude?: string[] } =>
  JSON.parse(readFileSync(join(root, 'harness', 'managed.json'), 'utf8')) as { managed: string[]; exclude?: string[] };
const toRel = (abs: string): string => relative(root, abs).split(sep).join('/');

test('managed.json：exclude の各項目が実在し、managed の glob に当たる（/** はディレクトリ）', () => {
  const m = loadManaged();
  assert.ok(Array.isArray(m.exclude) && m.exclude.length > 0, 'exclude は空でない配列');
  const managed = m.managed.map(globToRegExp);
  for (const p of m.exclude) {
    assert.equal(typeof p, 'string');
    if (p.endsWith('/**')) {
      const dir = p.slice(0, -3);
      assert.ok(existsSync(join(root, dir)) && statSync(join(root, dir)).isDirectory(), `${p} のディレクトリが無い`);
      assert.ok(managed.some((r) => r.test(`${dir}/SKILL.md`)), `${p} が managed のどれにも当たらない`);
    } else {
      assert.ok(!p.includes('*'), `${p}：glob は /** で終わる形だけ`);
      assert.ok(existsSync(join(root, p)) && statSync(join(root, p)).isFile(), `${p} が無い`);
      assert.ok(managed.some((r) => r.test(p)), `${p} が managed のどれにも当たらない`);
    }
  }
});

test('managed.json：Issue の根拠に名前のある観測系が exclude にある', () => {
  const exclude = loadManaged().exclude ?? [];
  const named = [
    ...['observe', 'test-prune', 'test-prune-loop', 'qa-retro-loop', 'mutate', 'patrol'].map((n) => `harness/scripts/${n}.ts`),
    ...['hotspot', 'observe-docs', 'test-prune', 'patrol', 'arch-review'].map((n) => `harness/lib/${n}.ts`),
    ...['patrol', 'qa-retro', 'test-prune', 'arch-review'].map((n) => `.claude/skills/${n}/**`),
    '.claude/agents/arch-reviewer.md',
  ];
  for (const p of named) assert.ok(exclude.includes(p), `${p} が exclude に無い`);
});

/** ディレクトリの下の .ts を再帰で集める（リポジトリからの相対パス） */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(abs));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(toRel(abs));
  }
  return out;
}

test('managed.json：配る .ts（exclude に無いもの）が exclude のファイルを相対 import していない', () => {
  const m = loadManaged();
  const managed = m.managed.map(globToRegExp);
  const excluded = (m.exclude ?? []).map(globToRegExp);
  const isExcluded = (p: string): boolean => excluded.some((r) => r.test(p));
  const IMPORT_RE = /(?:\bfrom|\bimport\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g;
  const sources = ['harness/lib', 'harness/gates', 'harness/scripts', '.claude/hooks']
    .flatMap((d) => tsFiles(join(root, d)))
    .filter((p) => managed.some((r) => r.test(p)) && !isExcluded(p));
  assert.ok(sources.length > 0);
  const bad: string[] = [];
  for (const src of sources) {
    const text = readFileSync(join(root, src), 'utf8');
    for (const [, spec] of text.matchAll(IMPORT_RE)) {
      const target = toRel(join(root, dirname(src), spec!));
      if (isExcluded(target)) bad.push(`${src} → ${target}`);
    }
  }
  assert.deepEqual(bad, [], '配るファイルが配らないファイルを import している');
});
