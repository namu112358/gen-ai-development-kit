// 合体版の担当が渡された出力のパスにそのまま書き、呼び出し元は返したパスと読めないファイルを見分けて同じパスで呼び直す（Issue #406）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const PANEL_SKILL = '.claude/skills/review-panel/SKILL.md';

/** 合体版の担当6つ */
const AGENTS = ['review-intake', 'review-lens', 'review-ac-scope', 'review-safety', 'review-scorer', 'review-overbuild'];
const agentPath = (name: string): string => `.claude/agents/${name}.md`;

/** 担当の定義に足す4つの文（6つとも同じ言い回し） */
const OUTPUT_PATH_RULES = [
  '渡された出力のパスは、短くしたり、ファイル名だけにしたり、相対パスに直したりせず、渡された絶対パスのまま Write に渡す。',
  '『既にある』かは、渡されたパスそのものだけを見て決める。ほかの場所（scratchpad の直下・作業ディレクトリなど）にある同じ名前のファイルでは決めない。',
  'ファイルに書くのは JSON だけで、JSON の後ろに呼び出しの文字列や説明を書かない。',
  '返事の最後の行に `出力のパス: <Write に渡したパス>`（既にあって書かなかったときは渡されたパス）を1行だけ書く。この行はファイルに書かない（「前後に説明文を付けない」の例外はこの1行だけ）。',
];

/** 「担当のファイルの確かめ方」で始まる行から、見出しか、続きが箇条・字下げでない空行の前までを切り出す */
function checkParagraph(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('担当のファイルの確かめ方'));
  if (start < 0) return '';
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^#+ /.test(l)) break;
    if (l.trim() === '') {
      const next = lines[i + 1] ?? '';
      if (!/^(\s+|[-*] |\d+\. )/.test(next)) break;
    }
    out.push(l);
  }
  return out.join('\n');
}

/** 句点と改行で文に分ける */
const sentences = (text: string): string[] => text.split(/[。\n]/).map((s) => s.trim()).filter((s) => s !== '');

// ---- 担当の定義（AC1） ----

test('担当の定義：6つに、渡された絶対パスのまま書く・「既にある」は渡されたパスだけ・ファイルには JSON だけ・最後の行の出力のパス、の4つの文が同じ言い回しである', () => {
  for (const name of AGENTS) {
    const text = read(agentPath(name));
    for (const rule of OUTPUT_PATH_RULES) assert.ok(text.includes(rule), `${name}: 「${rule}」がありません`);
  }
});

// ---- review-panel の skill（AC2） ----

test('review-panel の skill：「担当のファイルの確かめ方」に、返したパスの比べ方・無いとき・読めないときの呼び直しと、2回目の失敗がある', () => {
  const para = checkParagraph(read(PANEL_SKILL));
  assert.ok(para !== '', '「担当のファイルの確かめ方」の段落がありません');
  const ss = sentences(para);
  const has = (words: string[]): boolean => ss.some((s) => words.every((w) => s.includes(w)));

  assert.ok(para.includes('出力のパス:'), '返事の最後の行の「出力のパス:」がありません');
  assert.ok(has(['出力のパス:', '比べ']), '「出力のパス:」を決まったパスと比べる文がありません');
  assert.ok(has(['写さ']) && has(['使わ']), '返したパスのファイルを写さない・使わない文がありません');
  assert.ok(has(['test ! -e', '呼び直']), '`test ! -e` で確かめてから呼び直す文がありません');
  assert.ok(has(['読めない']) && para.includes('rm '), 'JSON として読めないときに rm で消す文がありません');
  assert.ok(has(['同じパス', '1回だけ', '呼び直']), '同じパスで1回だけ呼び直す文がありません');
  assert.ok(has(['2回目', '失敗']), '2回目も無い・読めなければ失敗にする文がありません');
  assert.ok(!para.includes('呼び直さずに'), '古い「呼び直さずに合体版を失敗」の文が残っています');
});
