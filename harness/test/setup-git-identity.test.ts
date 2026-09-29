// docs/setup.md に、付き添いのセッションを動かすパソコンで git の user.name・user.email を設定する手順と確かめ方があることを確かめる（Issue #180）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const setup = (): string => readFileSync(join(root, 'docs', 'setup.md'), 'utf8');

const SECTION_HEADING = '## 9. 利用者の準備';

/** `## 9. 利用者の準備` の見出しから、次の `## ` の見出し（無ければ末尾）までを切り出す。無ければ undefined */
function userPrepSection(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(SECTION_HEADING));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

const section = (): string => {
  const s = userPrepSection(setup());
  assert.ok(s !== undefined, `docs/setup.md に「${SECTION_HEADING}」で始まる見出しが無い`);
  return s;
};

test('docs/setup.md に利用者の準備の節（## 9. 利用者の準備）がある', () => {
  section();
});

test('利用者の準備の節に user.name・user.email を設定するコマンドがある', () => {
  const s = section();
  assert.ok(s.includes('git config --global user.name'), 'git config --global user.name が無い');
  assert.ok(s.includes('git config --global user.email'), 'git config --global user.email が無い');
});

test('利用者の準備の節に、メールは GitHub の noreply のメールでよいことが書かれている', () => {
  assert.ok(section().includes('noreply'), 'noreply のメールの説明が無い');
});

test('利用者の準備の節に、未設定だと commit で止まること（empty ident name）が書かれている', () => {
  assert.ok(section().includes('empty ident name'), '未設定で止まるときのメッセージ（empty ident name）が無い');
});

test('利用者の準備の節に、設定を確かめるコマンド git var GIT_AUTHOR_IDENT がある', () => {
  assert.ok(section().includes('git var GIT_AUTHOR_IDENT'), '確かめのコマンド git var GIT_AUTHOR_IDENT が無い');
});

// 既存のリンクのアンカー（docs/glossary.md の `#6-routine`、CLAUDE.md・harness/CLAUDE.harness.md・docs/security.md・
// harness/test/managed.test.ts の `#8-プラグイン全員に同じ版で入れる`）を守るため、節を足しても既存の見出しが変わっていないことを確かめる
test('既存の見出し（## 6. Routine・## 8. プラグイン（全員に同じ版で入れる））がそのまま残っている', () => {
  const lines = setup().split(/\r?\n/);
  assert.ok(lines.includes('## 6. Routine'), '見出し「## 6. Routine」が変わっている');
  assert.ok(lines.includes('## 8. プラグイン（全員に同じ版で入れる）'), '見出し「## 8. プラグイン（全員に同じ版で入れる）」が変わっている');
});
