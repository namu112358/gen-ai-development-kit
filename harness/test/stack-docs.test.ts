import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Issue #147：Stacked PR の使い方と制限が CLAUDE.md・docs・agent・skill に書かれている

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

/** 見出しの行（前方一致）から、同じか上の階層の次の見出しの前までを切り出す */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return '';
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

function assertIncludesAll(text: string, words: string[], where: string): void {
  for (const w of words) assert.ok(text.includes(w), `${where} に「${w}」が無い`);
}

/** 使い方と制限として CLAUDE.harness.md と docs/operations.md の両方に書く語 */
const STACK_RULES = [
  '付き添いのセッションだけ',
  '下の層と同じファイル',
  '下の層が足したもの',
  'Stack:',
  'Refs #',
  'Closes #',
  'Human Merge',
  'auto-merge',
  'Merge API',
  'git merge',
  'rebase',
  'force push',
];

const BASE_DIFF = 'origin/<PR の base>...';

test('CLAUDE.md がハーネスの規則を読み込み、構成の表に gh-stack がある', () => {
  const text = read('CLAUDE.md');
  assert.ok(text.includes('@harness/CLAUDE.harness.md'));
  const section2 = section(text, '## 構成');
  assert.ok(section2.includes('gh-stack'), '構成の節に gh-stack が無い');
});

test('CLAUDE.harness.md の進め方に Stacked PR の使い方と制限、やってはいけないことに gh stack がある', () => {
  const text = read('harness/CLAUDE.harness.md');
  const steps = section(text, '## 進め方');
  assert.ok(steps !== '', '## 進め方 の節が無い');
  assertIncludesAll(steps, ['Stacked PR', ...STACK_RULES], 'CLAUDE.harness.md の ## 進め方');
  assert.ok(steps.includes('[gh-stack](../.claude/skills/gh-stack/SKILL.md)'), 'skill の表に gh-stack が無い');
  const donts = section(text, '## やってはいけないこと');
  assert.ok(donts.includes('gh stack'), '## やってはいけないこと に gh stack が無い');
});

test('docs/operations.md に Stacked PR の節と orphan-base の理由コードがある', () => {
  const text = read('docs/operations.md');
  const stack = section(text, '## Stacked PR');
  assert.ok(stack !== '', '## Stacked PR の節が無い');
  assertIncludesAll(stack, [...STACK_RULES, 'orphan-base'], 'docs/operations.md の ## Stacked PR');
  assert.ok(
    text.split('\n').some((l) => l.startsWith('| `orphan-base` |')),
    '理由コードの表に orphan-base の行が無い',
  );
});

test('harness/lib/config.ts の理由コードに orphan-base がある', () => {
  assert.ok(read('harness/lib/config.ts').includes('orphan-base'));
});

test('reviewer.md にスタックの必要性の条件とブロッキングの扱いがある', () => {
  const text = read('.claude/agents/reviewer.md');
  assertIncludesAll(text, ['下の層と同じファイル', '下の層が足したもの', 'Stack:', 'out-of-scope', 'ブロッキング', BASE_DIFF], 'reviewer.md');
});

test('risk-agent・judge・sync は PR の base との差分を見る', () => {
  assert.ok(read('.claude/agents/risk-agent.md').includes(BASE_DIFF), 'risk-agent.md');
  assert.ok(read('.claude/skills/judge/SKILL.md').includes(BASE_DIFF), 'judge/SKILL.md');
  assert.ok(read('.claude/skills/sync/SKILL.md').includes(`git diff ${BASE_DIFF}`), 'sync/SKILL.md');
});

test('docs/formats.md と docs/plan.md にスタックの記録と計画の書き方がある', () => {
  assertIncludesAll(read('docs/formats.md'), ['stack-link', 'orphan-base', 'base-resolved', 'stack-closed'], 'docs/formats.md');
  assertIncludesAll(read('docs/plan.md'), ['Stacked PR', 'Refs #N', 'App が閉じる'], 'docs/plan.md');
});

test('gh-stack の skill があり、手順に止められる gh stack の操作を書かない', () => {
  const text = read('.claude/skills/gh-stack/SKILL.md');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'frontmatter が無い');
  assert.ok(fm[1]!.split('\n').some((l) => l.trim() === 'name: gh-stack'), 'name: gh-stack が無い');
  assertIncludesAll(text, ['github/gh-stack', 'v0.1.1'], 'gh-stack/SKILL.md');
  const steps = section(text, '## 手順');
  assert.ok(steps !== '', '## 手順 の節が無い');
  const bad = steps.split('\n').filter((l) => /gh stack (merge|push|sync|rebase|submit|modify|alias|unstack|checkout)\b/.test(l));
  assert.deepEqual(bad, [], '手順に止められる gh stack の操作がある');
});

test('.claude/skills/README.md の表に gh-stack の行がある', () => {
  const lines = read('.claude/skills/README.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('|') && l.includes('gh-stack/')));
});

test('ship の skill と PR の雛形にスタックの書き方がある', () => {
  assert.ok(read('.claude/skills/ship/SKILL.md').includes('Refs #N'), 'ship/SKILL.md');
  assertIncludesAll(read('.github/pull_request_template.md'), ['Refs #', 'Stack:'], 'pull_request_template.md');
});
