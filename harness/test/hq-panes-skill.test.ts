// Issue #402：hq の SKILL.md の手順6に、hq のペインの並び（左に hq の Claude と人待ち → Epic/Issue → ログ、右に intel）と開き方
// （ORCA terminal split と panes.ts hq todo・board・log。セッションを渡さない）、intel が起こせないときの扱いが書かれ、
// 手順12が人待ちのペインの一覧（panes.ts hq todo --once）を使うことを確かめる。語句は要点ごとに少なく絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const hqSkill = (): string => readFileSync(join(root, '.claude', 'skills', 'hq', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

/** 行頭が `<n>. ` の番号付きの項から、行頭が `<n+1>. ` か `## ` の行の前までを切り出す（hq-intel-skill.test.ts と同じ） */
function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith(`${n + 1}. `) || l.startsWith('## '));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

function assertWords(text: string, words: string[], what: string): void {
  assert.ok(text !== '', `${what}がありません`);
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

/** 語句が text の中にこの順で出てくることを確かめる */
function assertOrder(text: string, words: string[], what: string): void {
  const at = words.map((w) => text.indexOf(w));
  assert.ok(at.every((i) => i >= 0), `${what}：${words.filter((_, k) => at[k]! < 0).join('、')} がありません`);
  for (let k = 1; k < at.length; k++) assert.ok(at[k - 1]! < at[k]!, `${what}：「${words[k - 1]}」が「${words[k]}」より前にありません`);
}

test('hq の手順6：ORCA terminal split で縦・横に分けてペインを開く', () => {
  assertWords(step(hqSkill(), 6), ['ORCA terminal split', '--direction vertical', '--direction horizontal'], 'hq の手順6');
});

test('hq の手順6：panes.ts hq todo → board → log の順に開く', () => {
  assertOrder(step(hqSkill(), 6), [
    'node harness/scripts/panes.ts hq todo', 'node harness/scripts/panes.ts hq board', 'node harness/scripts/panes.ts hq log',
  ], 'hq の手順6');
});

test('hq の手順6：左に人待ち → Epic/Issue → ログ、右に intel', () => {
  const s = step(hqSkill(), 6);
  assertWords(s, ['左', '右', '人待ち', 'Epic/Issue', 'ログ', 'intel'], 'hq の手順6');
  assertOrder(s, ['人待ち', 'Epic/Issue', 'ログ'], 'hq の手順6の並び');
});

test('hq の手順6：intel が起こせないときは intel のペインを開かずに進める', () => {
  assertWords(step(hqSkill(), 6), ['intel のペインを開かずに進める'], 'hq の手順6');
});

test('hq の手順6：ペインにセッションを渡さない（控えから fleet を見つける）', () => {
  const s = step(hqSkill(), 6);
  assert.ok(s !== '', 'hq の手順6がありません');
  assert.ok(!s.includes('--session'), 'hq の手順6に --session が残っている');
});

test('hq の手順12：人待ちの一覧を panes.ts hq todo --once で読む', () => {
  assertWords(step(hqSkill(), 12), ['panes.ts hq todo --once'], 'hq の手順12');
});
