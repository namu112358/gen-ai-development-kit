/**
 * 規則として参照する docs を harness/docs/ に移して導入先に配ることの検査（Issue #641）。
 * managed に harness/docs/** があること、6文書が harness/docs/ にあり docs/ に無いこと、
 * リポジトリの中に旧パス（root からの形の docs/<名前>.md）への参照が残っていないこと、
 * Markdown の文書の相対リンクが実在するファイルを指すことを確かめる。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const SELF = 'harness/test/managed-docs.test.ts';

const MOVED = ['formats', 'operations', 'risk-policy', 'review-panel', 'security', 'glossary'];

/** root からの形の旧パス（直前が英数字・`.`・`/`・`-` でない docs/<名前>.md） */
const OLD_PATH = /(?<![\w./-])docs\/(formats|operations|risk-policy|review-panel|security|glossary)\.md/;

/** git が追跡しているファイル（root からの相対パス） */
function lsFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ls-files が失敗: ${r.stderr}`);
  return r.stdout.split('\0').filter((p) => p.length > 0);
}

/** docs/upstream/<写し>/ の下（docs/upstream/README.md は含まない） */
const isUpstreamCopy = (p: string): boolean => /^docs\/upstream\/[^/]+\//.test(p);

test('managed.json：managed に harness/docs/** がある', () => {
  const managed = (JSON.parse(read('harness/managed.json')) as { managed: string[] }).managed;
  assert.ok(managed.includes('harness/docs/**'), 'harness/docs/** が managed に無い');
});

test('6文書が harness/docs/ にあり、docs/ には無い', () => {
  for (const name of MOVED) {
    assert.ok(existsSync(join(root, 'harness/docs', `${name}.md`)), `harness/docs/${name}.md が無い`);
    assert.ok(!existsSync(join(root, 'docs', `${name}.md`)), `docs/${name}.md が残っている`);
  }
});

test('旧パスの判定：root からの形だけを旧とみなす', () => {
  const cases: [string, boolean][] = [
    ['docs/formats.md', true],
    ['`docs/risk-policy.md` を見る', true],
    ['[x](docs/glossary.md)', true],
    ['"docs/security.md"', true],
    ['harness/docs/formats.md', false],
    ['../docs/operations.md', false],
    ['./docs/review-panel.md', false],
    ['mydocs/formats.md', false],
    ['docs/setup.md', false],
    ['docs/plan.md', false],
  ];
  for (const [text, old] of cases) assert.equal(OLD_PATH.test(text), old, text);
});

test('リポジトリの中に、移した6文書の旧パス（docs/<名前>.md）への参照が残っていない', () => {
  const found: string[] = [];
  for (const file of lsFiles()) {
    if (file === SELF || isUpstreamCopy(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue; // バイナリ
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      if (OLD_PATH.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], `旧パスへの参照が残っている:\n${found.join('\n')}`);
});

/** 相対リンクの実在を確かめる Markdown の文書か */
function isLinkCheckTarget(p: string): boolean {
  if (!p.endsWith('.md')) return false;
  if (isUpstreamCopy(p)) return false;
  return (
    p.startsWith('.claude/') ||
    p === 'harness/CLAUDE.harness.md' ||
    (p.startsWith('harness/') && p.endsWith('/README.md')) ||
    /^harness\/docs\/[^/]+\.md$/.test(p) ||
    p === 'CLAUDE.md' ||
    p === 'README.md' ||
    p.startsWith('docs/')
  );
}

test('Markdown の文書の相対リンクが、各ファイルのディレクトリから見て存在するファイルを指す', () => {
  const targets = lsFiles().filter(isLinkCheckTarget);
  assert.ok(targets.includes('harness/CLAUDE.harness.md'), '対象の選び方が壊れている');
  const broken: string[] = [];
  for (const file of targets) {
    const text = read(file);
    for (const m of text.matchAll(/\]\((\.{0,2}\/?[^)#\s]+)/g)) {
      const link = m[1] ?? '';
      if (/^https?:/.test(link)) continue;
      if (!existsSync(resolve(join(root, dirname(file)), link))) broken.push(`${file}: ${link}`);
    }
  }
  assert.deepEqual(broken, [], `存在しないファイルへのリンク:\n${broken.join('\n')}`);
});
