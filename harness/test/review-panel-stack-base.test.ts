// Issue #739：合体版のレビューの担当が、Stacked PR の層を PR の base からの差分で読む（既定ブランチ宛ては今と同じ main からの差分）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

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

/** 番号つきの手順 `n. ` の行から、次の番号の手順か見出しの前までを切り出す */
function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || /^#+ /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const BASE_DIFF = 'git diff origin/<PR の base>...<headSha>';
const MAIN_DIFF = 'origin/main...<headSha>';

const AGENTS = [
  '.claude/agents/review-intake.md',
  '.claude/agents/review-lens.md',
  '.claude/agents/review-ac-scope.md',
  '.claude/agents/review-safety.md',
  '.claude/agents/review-overbuild.md',
  '.claude/agents/review-scorer.md',
];

test('合体版の担当6つは diff を PR の base から読み、main 固定の diff を書かない', () => {
  for (const path of AGENTS) {
    const text = read(path);
    assert.ok(text.includes(BASE_DIFF), `${path} に「${BASE_DIFF}」が無い`);
    assert.ok(!text.includes(MAIN_DIFF), `${path} に「${MAIN_DIFF}」が残っている`);
  }
});

test('合体版の担当6つは、下の層の変更は下の層の PR で見ることと、base が無いときの main を書く', () => {
  for (const path of AGENTS) {
    const text = read(path);
    for (const w of ['下の層の PR', '`main`']) {
      assert.ok(text.includes(w), `${path} に「${w}」が無い`);
    }
  }
});

test('review-lens・review-scorer の入力の節に PR の base がある', () => {
  for (const path of ['.claude/agents/review-lens.md', '.claude/agents/review-scorer.md']) {
    const input = section(read(path), '## 入力');
    assert.ok(input !== '', `${path} に ## 入力 の節が無い`);
    assert.ok(input.includes('PR の base'), `${path} の ## 入力 に「PR の base」が無い`);
  }
});

test('review-panel の skill は担当に PR の base からの diff を念押しし、review-lens・review-scorer に PR の base を渡す', () => {
  const text = read('.claude/skills/review-panel/SKILL.md');
  const steps = section(text, '## 手順');
  assert.ok(steps !== '', 'SKILL.md に ## 手順 の節が無い');
  assert.ok(steps.includes(`origin/<PR の base>...<headSha>`), '## 手順 に「origin/<PR の base>...<headSha>」が無い');
  assert.ok(!text.includes(MAIN_DIFF), `SKILL.md に「${MAIN_DIFF}」が残っている`);

  const step2 = step(steps, 2);
  assert.ok(step2 !== '', '手順2 が無い');
  const lens = step2.split('\n').find((l) => l.includes('**review-lens**'));
  assert.ok(lens !== undefined, '手順2 に review-lens の行が無い');
  assert.ok(lens.includes('PR の base'), '手順2 の review-lens に渡すものに「PR の base」が無い');

  const step4 = step(steps, 4);
  assert.ok(step4.includes('**review-scorer**'), '手順4 に review-scorer が無い');
  assert.ok(step4.includes('PR の base'), '手順4 の review-scorer に渡すものに「PR の base」が無い');
});
