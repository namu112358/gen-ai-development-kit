// Issue #289：plan の skill で、批評と投稿の前に openQuestions・needsHumanReasons を AskUserQuestion で聞き、答えを計画に書き込む手順
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const PLAN_SKILL = '.claude/skills/plan/SKILL.md';
const SHIP_SKILL = '.claude/skills/ship/SKILL.md';
const RULES = 'harness/CLAUDE.harness.md';

/** 箇条（- か「数字.」で始まる行と、その下の続きの行）ごとに分ける */
const bullets = (text: string): string[] => text.split(/\n(?=\s*(?:-|\d+\.) )/);

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

/** plan の skill の「## 手順」の箇条 */
const planSteps = (): string[] => bullets(section(read(PLAN_SKILL), '## 手順'));

/** 投稿の前に聞く箇条：openQuestions・needsHumanReasons・AskUserQuestion をすべて含む */
const isAskItem = (b: string): boolean => b.includes('openQuestions') && b.includes('needsHumanReasons') && b.includes('AskUserQuestion');

/** 投稿の前に聞く箇条を返す（無ければ assert で落とす） */
function askItem(): string {
  const item = planSteps().find(isAskItem);
  assert.ok(item, 'plan の skill の「## 手順」に、openQuestions・needsHumanReasons・AskUserQuestion をすべて含む箇条がありません');
  return item;
}

// ---- AC1：投稿の前に聞く手順の位置 ----

test('plan の skill：聞く箇条は手順3の中の字下げした小項目で、critic-input の手順と post-plan の手順より前にある', () => {
  const steps = planSteps();
  const ask = steps.findIndex(isAskItem);
  assert.ok(ask >= 0, 'openQuestions・needsHumanReasons・AskUserQuestion をすべて含む箇条がありません');
  assert.match(steps[ask]!, /^\s+- /, '聞く箇条が字下げした小項目（「- 」）になっていません');

  // 直前の番号付きの手順（字下げしない「数字.」）が手順3であること
  const parent = steps.slice(0, ask).reverse().find((b) => /^\s*\d+\. /.test(b) && !/^\s+\d/.test(b));
  assert.ok(parent, '聞く箇条の親の手順がありません');
  assert.match(parent, /^\s*3\. /, `聞く箇条が手順3の中にありません（親：${parent.slice(0, 20)}）`);

  const criticInput = steps.findIndex((b) => b.includes('critic-input'));
  const postPlan = steps.findIndex((b) => b.includes('post-plan'));
  assert.ok(criticInput >= 0, 'critic-input の手順がありません');
  assert.ok(postPlan >= 0, 'post-plan の手順がありません');
  assert.ok(ask < criticInput, '聞く箇条が critic-input の手順より後にあります');
  assert.ok(ask < postPlan, '聞く箇条が post-plan の手順より後にあります');
});

test('plan の skill：聞く箇条に、答えを計画の本文に書き込み、解消したものを申告から除くことがある', () => {
  const item = askItem();
  assert.match(item, /本文/, '答えを計画の本文に書き込むこと（「本文」）がありません');
  assert.match(item, /除[くき]/, '解消したものを申告から除くこと（「除く」）がありません');
});

// ---- AC2：答えなかった・拒んだものは申告に残して投稿する ----

test('plan の skill：聞く箇条に、答えなかった・拒んだ質問は申告に残して投稿することがある', () => {
  const item = askItem();
  assert.match(item, /答えなかった/, '「答えなかった」がありません');
  assert.match(item, /拒んだ/, '「拒んだ」がありません');
  assert.match(item, /残して投稿/, '「残して投稿」がありません');
});

// ---- AC3：答えで計画が変わったら書き直した計画を批評に渡す ----

test('plan の skill：聞く箇条に、答えで変わった計画を批評に渡すことがある', () => {
  const item = askItem();
  assert.ok(item.includes('批評に渡す') || item.includes('plan-critic'), '答えで変わった計画を批評に渡すこと（「批評に渡す」か plan-critic）がありません');
});

// ---- AC4：Routine と入れ子の ship は聞かない ----

test('plan の skill：Routine と入れ子の ship はこの手順で聞かないことが、同じ箇条にある', () => {
  const item = bullets(read(PLAN_SKILL)).find((b) => b.includes('Routine') && b.includes('入れ子') && b.includes('聞かない'));
  assert.ok(item, 'plan の skill に「Routine」「入れ子」「聞かない」を同じ箇条に含むものがありません');
});

test('ship の skill：サブエージェントの ship として動くときの節に、投稿の前の質問は聞くことを fleet に返す箇条がある', () => {
  const sub = section(read(SHIP_SKILL), '## サブエージェントの ship として動くとき');
  assert.ok(sub !== '', '「## サブエージェントの ship として動くとき」の節がありません');
  const item = bullets(sub).find((b) => b.includes('投稿の前') && b.includes('fleet に返す'));
  assert.ok(item, '節に「投稿の前」と「fleet に返す」を含む箇条がありません');
});

// ---- AC5：acChangeProposed の扱いは変えない ----

test('plan の skill：聞く箇条に、acChangeProposed の扱いは変えない（消さない／今までどおり）ことがある', () => {
  const item = askItem();
  assert.ok(item.includes('acChangeProposed'), '聞く箇条に acChangeProposed がありません');
  assert.ok(item.includes('消さない') || item.includes('今までどおり'), '聞く箇条に「消さない」か「今までどおり」がありません');
});

// ---- ハーネスの規則（進め方）----

test('harness/CLAUDE.harness.md：進め方に、投稿の前に openQuestions を AskUserQuestion で聞く箇条が、既存の AskUserQuestion の箇条より後にある', () => {
  const rules = read(RULES);
  const start = rules.indexOf('## 進め方');
  const end = rules.indexOf('## 立場');
  assert.ok(start >= 0 && end > start, '「## 進め方」「## 立場」がありません');
  const items = bullets(rules.slice(start, end));
  const existing = items.findIndex((b) => b.includes('AskUserQuestion') && b.includes('選択肢') && b.includes('4問'));
  assert.ok(existing >= 0, '「選択肢」「4問」を含む既存の AskUserQuestion の箇条がありません');
  const added = items.findIndex((b, i) => i !== existing && b.includes('投稿の前') && b.includes('openQuestions') && b.includes('AskUserQuestion'));
  assert.ok(added >= 0, '進め方に「投稿の前」・openQuestions・AskUserQuestion を含む箇条がありません');
  assert.ok(added > existing, '投稿の前に聞く箇条が、既存の AskUserQuestion の箇条より前にあります');
});
