// Issue #164：ハーネスの規則（harness/CLAUDE.harness.md）に書いた着手宣言の段階（--stage）の名前が、本体の CLAIM_STAGES にあるかを検査する。
// あわせて、.claude/hooks/README.md の表の説明が括弧の途中で切れていないことを確かめる。規則・docs の語の有無は固定しない（#1007）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAIM_STAGES } from '../lib/queue.ts';
import { section } from './support/skill-text.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** 段落・箇条・表の行ごとに分けた、空でない行 */
const nonEmptyLines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

/** 文中の `--stage <名前>` の名前（`judge|fix|sync` のような並びは分ける。`<段階>` のような置き換えの印は除く） */
function stageNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/--stage ([a-z][a-z|-]*)/g)) names.push(...(m[1] ?? '').split('|').filter((s) => s !== ''));
  return names;
}

const rules = (): string => section(read('harness/CLAUDE.harness.md'), '## 進め方');

// ---- 規則に書いた --stage の段階の名前が本体の値と合う ----

test('規則（進め方）：--stage の段階の名前はすべて CLAIM_STAGES にある', () => {
  const names = stageNames(rules());
  assert.ok(names.length > 0, '--stage の段階の名前が1つも無い');
  for (const n of names) assert.ok((CLAIM_STAGES as readonly string[]).includes(n), `--stage ${n} は CLAIM_STAGES に無い`);
});

// ---- 追加の要件：README の表の説明が括弧の途中で切れない ----

/** 全角・半角の丸括弧の開きと閉じの数が釣り合っているか */
function balancedParens(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

test('.claude/hooks/README.md：session-env.ts の行の説明は括弧が閉じている', () => {
  const row = nonEmptyLines(read('.claude/hooks/README.md')).find((l) => l.startsWith('| `session-env.ts` |'));
  assert.ok(row, '`session-env.ts` の行が無い');
  const description = row.split('|')[2] ?? '';
  assert.ok(balancedParens(description), `説明が括弧の途中で切れている：${description.trim()}`);
});

test('.claude/hooks/README.md：生成した表のどの行も、説明の括弧が閉じている', () => {
  const text = read('.claude/hooks/README.md');
  const start = text.indexOf('<!-- readme:generated start -->');
  const end = text.indexOf('<!-- readme:generated end -->');
  assert.ok(start >= 0 && end > start, '生成した表の目印が無い');
  const rows = nonEmptyLines(text.slice(start, end)).filter((l) => l.startsWith('| `'));
  assert.ok(rows.length > 0);
  for (const row of rows) assert.ok(balancedParens(row.split('|')[2] ?? ''), `説明が括弧の途中で切れている：${row}`);
});
