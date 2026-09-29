// Issue #209：priority:*・area:* は Jev に任せ、付き添いのセッションはラベルの不足を人に聞かない。
// ship・fleet の skill の「人がすること」にラベルの不足の項が無く、label-audit を走らせる手順も無いこと、
// docs/operations.md の「足りないラベルを付ける」が新しい扱いと合っていることを確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** 見出し（`## 名前` など）から、同じか上の階層の次の見出しの前までを返す。見出しが無ければ失敗させる */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  assert.ok(start >= 0, `見出し「${heading}」が無い`);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^(#+) /);
    if (m && (m[1] ?? '').length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/** 段落・箇条・表の行ごとに分けた、空でない行 */
const nonEmptyLines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

/** `**人がすること**` を書いた手順の行の後に続く、字下げした箇条（一覧の項目）を返す。一覧が無ければ失敗させる */
function humanTodoItems(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes('**人がすること**'));
  assert.ok(start >= 0, '`**人がすること**` の一覧が無い');
  const items: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (/^\s+- /.test(l)) items.push(l.trim());
    else if (/^\s+\S/.test(l)) continue; // 項目の続きの行
    else break;
  }
  assert.ok(items.length > 0, '`**人がすること**` の一覧に項目が無い');
  return items;
}

const skills = ['.claude/skills/ship/SKILL.md', '.claude/skills/fleet/SKILL.md'];

// ---- AC2：ship・fleet の「人がすること」にラベルの不足の項が無い ----

for (const path of skills) {
  test(`${path}：「人がすること」の一覧に、ラベルの不足の項が無い`, () => {
    const items = humanTodoItems(read(path));
    const found = items.filter((l) => l.includes('ラベルの不足'));
    assert.deepEqual(found, [], `「人がすること」にラベルの不足の項が残っている：${found.join(' / ')}`);
  });

  test(`${path}：label-audit を走らせる手順が無い（ラベルは Jev に任せる）`, () => {
    const found = nonEmptyLines(read(path)).filter((l) => /agent\.ts label-audit/.test(l));
    assert.deepEqual(found, [], `label-audit を走らせる手順が残っている：${found.join(' / ')}`);
  });
}

// ---- AC3：docs/operations.md が新しい扱いと合っている ----

const labelApply = (): string => section(read('docs/operations.md'), '#### 足りないラベルを付ける');

test('operations.md「足りないラベルを付ける」：セッションはラベルの不足を人に聞かず、Jev に任せることが書かれている', () => {
  const line = nonEmptyLines(labelApply()).find((l) => l.includes('セッション') && /聞か(ない|ず)/.test(l));
  assert.ok(line, 'セッションがラベルの不足を人に聞かないことを書いた行が無い');
  assert.match(line, /Jev/, 'その行に、Jev に任せることが書かれていない');
});

test('operations.md「足りないラベルを付ける」：見つかったものを人がすることの一覧に書く、という古い文が無い', () => {
  assert.doesNotMatch(labelApply(), /人がすることの一覧に書く/, '「人がすることの一覧に書く」が残っている');
});
