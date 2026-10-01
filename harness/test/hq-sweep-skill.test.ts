// Issue #407：hq の skill（.claude/skills/hq/SKILL.md）の手順8に「止まったタスクの見回し」（読むもの・見つけるもの4つ・割り振り・Epic の案）があり、
// 手順2に人が承認した案だけ Epic の作成と sub-issues への付け足しをすること、手順12の一覧に割り振ったもの・案として聞いたもの・人が決めなかったものがあることを確かめる。
// 語句は要点ごとに少なく絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const HQ_SKILL = '.claude/skills/hq/SKILL.md';

const skill = (): string => readFileSync(join(root, HQ_SKILL), 'utf8');

/** 行頭が `<n>. ` の番号付きの項から、行頭が `<next>. ` か `## ` の行の前までを切り出す */
function step(n: number): string {
  const lines = skill().split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith(`${n + 1}. `) || l.startsWith('## '));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** 語句がすべて text の中にあることを確かめる（hq-skill.test.ts と同じ） */
function assertWords(text: string, words: string[], what: string): void {
  assert.ok(text !== '', `${what}がありません`);
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

// ---- AC1：手順8の見回し（読むもの・見つけるもの4つ） ----

test('hq の skill 手順8：見出しは「進んでいない fleet を見つける」のままで、小項目「止まったタスクの見回し」がある', () => {
  assertWords(step(8), ['進んでいない fleet を見つける', '止まったタスクの見回し'], 'hq の skill の手順8');
});

test('hq の skill 手順8：読むのはダッシュボードの節・patrol・fleet-status', () => {
  assertWords(step(8), ['ダッシュボード', 'patrol', 'fleet-status'], 'hq の skill の手順8');
});

test('hq の skill 手順8：見つけるもの4つ（担当のいない PR・止まった宣言・どの fleet にも入っていない Issue・Epic に入っていない Issue（sub-issues））', () => {
  assertWords(step(8), ['担当のいない PR', '止まった宣言', 'どの fleet にも入っていない', 'Epic に入っていない', 'sub-issues'], 'hq の skill の手順8');
});

// ---- AC2：割り振りの決め方 ----

test('hq の skill 手順8：今の fleet には send で渡し、入らないものは hq.maxFleets の空きで新しい fleet の案（人の承認の後に起こす）', () => {
  assertWords(step(8), ['send', 'hq.maxFleets', '人の承認'], 'hq の skill の手順8');
});

test('hq の skill 手順8：止まった宣言・担当のいない PR は引き継ぐかは人が決める', () => {
  assertWords(step(8), ['引き継ぐかは人が決める'], 'hq の skill の手順8');
});

// ---- AC3：Epic の案と、承認の後に誰が作り・子に付けるか ----

test('hq の skill 手順8：Epic の案を AskUserQuestion で1回に聞き、Epic の Issue は intel か hq が作り、子の付け足しは承認した案だけ', () => {
  assertWords(step(8), ['AskUserQuestion', '1回', 'intel', '承認した案だけ'], 'hq の skill の手順8');
});

test('hq の skill 手順2：するのは…だけに、承認した案だけ Epic の作成と sub-issues への付け足しがある', () => {
  assertWords(step(2), ['承認した案だけ', 'sub-issues'], 'hq の skill の手順2');
});

// ---- 手順12の一覧 ----

test('hq の skill 手順12：一覧に割り振ったもの・案として聞いたもの・人が決めなかったものを出す', () => {
  assertWords(step(12), ['割り振ったもの', '案として聞いたもの', '人が決めなかったもの'], 'hq の skill の手順12');
});
