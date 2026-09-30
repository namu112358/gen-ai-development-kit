// Issue #318：今の reviewer にあって合体版に無かったもの（⑥⑦の採点のモデル・⑦の採点の材料・提案の出し先・humanNotes を必ず書く場合）が、skill と担当の定義に書いてある
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const PANEL_SKILL = '.claude/skills/review-panel/SKILL.md';
const agentPath = (name: string): string => `.claude/agents/${name}.md`;
/** 提案（suggestions）を返す担当 */
const SUGGESTING_AGENTS = ['review-lens', 'review-ac-scope', 'review-safety'];
/** humanNotes（concerns・checkPoints）を返す担当 */
const NOTE_AGENTS = ['review-ac-scope', 'review-safety'];

/** skill の手順のうち「段階4」の項（`N. 段階4` の行から次の番号付きの項の前まで） */
function stage4(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\d+\.\s+段階4/.test(l));
  assert.ok(start >= 0, `${PANEL_SKILL} に段階4の項がありません`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\.\s/.test(l) || l.startsWith('## '));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))];
}

// ---- review-panel の skill ----

test('review-panel の skill：段階4に、⑥⑦の指摘の review-scorer は model を opus にして呼ぶと書いてある', () => {
  const block = stage4(read(PANEL_SKILL));
  assert.ok(block.some((l) => l.includes('review-scorer')), '段階4に review-scorer がありません');
  assert.ok(
    block.some((l) => l.includes('⑥') && l.includes('⑦') && l.includes('opus')),
    '段階4に、⑥⑦の指摘の採点を opus で呼ぶ行（⑥・⑦・opus を含む行）がありません',
  );
});

test('review-panel の skill：⑦の指摘の採点にも Issue 本文を渡すと書いてある', () => {
  const lines = read(PANEL_SKILL).split('\n');
  assert.ok(lines.some((l) => l.includes('⑦') && l.includes('Issue 本文')), '⑦ と Issue 本文 を含む行がありません');
});

// ---- 担当の定義 ----

test('担当の定義：review-lens・review-ac-scope・review-safety の出力の JSON に suggestions があり、確信が低い指摘を suggestions に移さないと書いてある', () => {
  for (const name of SUGGESTING_AGENTS) {
    const text = read(agentPath(name));
    assert.ok(text.includes('"suggestions"'), `${name}.md の出力の JSON に "suggestions" がありません`);
    assert.ok(
      text.split('\n').some((l) => l.includes('findings') && l.includes('suggestions') && l.includes('移さない')),
      `${name}.md に「確信が低くても findings に書き、suggestions に移さない」旨の行（findings・suggestions・移さない を含む行）がありません`,
    );
  }
});

test('担当の定義：review-ac-scope・review-safety に、humanNotes（concerns・checkPoints）を必ず書く場合が書いてある', () => {
  for (const name of NOTE_AGENTS) {
    const lines = read(agentPath(name)).split('\n');
    assert.ok(
      lines.some((l) => l.includes('必ず書く') && (l.includes('concerns') || l.includes('humanNotes'))),
      `${name}.md に humanNotes（concerns・checkPoints）を必ず書く旨の行がありません`,
    );
    const text = lines.join('\n');
    for (const w of ['ハーネス', '公開インターフェース', 'データ', 'テストで確かめきれ']) {
      assert.ok(text.includes(w), `${name}.md に必ず書く場合の「${w}」がありません`);
    }
  }
});
