// Issue #289：plan の skill で、批評と投稿の前に openQuestions・needsHumanReasons を AskUserQuestion で聞き、答えを計画に書き込む手順
// Issue #299：fleet の入れ子の ship は投稿の前の質問で投稿せずに止まって fleet に返し、fleet がまとめて聞いて ship を呼び直す
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const PLAN_SKILL = '.claude/skills/plan/SKILL.md';
const SHIP_SKILL = '.claude/skills/ship/SKILL.md';
const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
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

// ---- AC4：Routine は聞かない（Issue #299 で入れ子の ship は例外でなくなった）----

test('plan の skill：聞く箇条に、Routine はこの手順で聞かず、申告を残して投稿することがある', () => {
  const item = askItem();
  assert.ok(item.includes('Routine'), '聞く箇条に「Routine」がありません');
  assert.ok(item.includes('聞かない'), '聞く箇条に「聞かない」がありません');
  assert.ok(item.includes('残して投稿'), '聞く箇条に「残して投稿」がありません');
});

// ---- Issue #299：入れ子の ship は投稿の前の質問で投稿せずに止まり、fleet に返す ----

/** ship の skill の「## サブエージェントの ship として動くとき」の節の箇条（節が無ければ assert で落とす） */
function nestedShipItems(): string[] {
  const sub = section(read(SHIP_SKILL), '## サブエージェントの ship として動くとき');
  assert.ok(sub !== '', '「## サブエージェントの ship として動くとき」の節がありません');
  return bullets(sub);
}

test('ship の skill：サブエージェントの ship として動くときの節に、投稿の前の質問では投稿せずに止まり、質問・選択肢・計画のパスを fleet に返す箇条がある', () => {
  const words = ['投稿の前', '投稿せず', 'fleet に返す', '選択肢', 'パス'];
  const item = nestedShipItems().find((b) => words.every((w) => b.includes(w)));
  assert.ok(item, `節に「${words.join('」「')}」をすべて含む箇条がありません`);
});

test('ship の skill：サブエージェントの ship として動くときの節の「投稿の前」の箇条に、止まらずに申告を残して投稿する古い例外が残っていない', () => {
  const items = nestedShipItems().filter((b) => b.includes('投稿の前'));
  for (const b of items) {
    assert.ok(!b.includes('止まらない'), `「投稿の前」の箇条に「止まらない」が残っています（${b.trim().slice(0, 40)}）`);
    assert.ok(!b.includes('申告を残して投稿し、聞くこと'), `「投稿の前」の箇条に「申告を残して投稿し、聞くこと」が残っています（${b.trim().slice(0, 40)}）`);
  }
});

test('ship の skill：サブエージェントの ship として動くときの節に、呼び直されたら答えを計画に書き込み、解消したものを申告から除いてから批評に進む箇条がある', () => {
  const words = ['呼び直され', '書き込', '除', '批評'];
  const item = nestedShipItems().find((b) => words.every((w) => b.includes(w)));
  assert.ok(item, `節に「${words.join('」「')}」をすべて含む箇条がありません`);
});

test('plan の skill：聞く箇条に、入れ子の ship は投稿せずに返し、呼び直されたら答えを書き込むことがある', () => {
  const item = askItem();
  assert.ok(item.includes('投稿せず'), '聞く箇条に「投稿せず」がありません');
  assert.ok(item.includes('呼び直され'), '聞く箇条に「呼び直され」がありません');
});

/** fleet の skill の「## 入れ子の方式」の節の箇条（節が無ければ assert で落とす） */
function fleetNestedItems(): string[] {
  const sub = section(read(FLEET_SKILL), '## 入れ子の方式');
  assert.ok(sub !== '', 'fleet の skill に「## 入れ子の方式」の節がありません');
  return bullets(sub);
}

test('fleet の skill：入れ子の方式の節に、返った投稿の前の質問を AskUserQuestion でまとめて聞き、答えを渡して ship を呼び直す箇条がある', () => {
  const words = ['投稿の前', 'AskUserQuestion', '呼び直す'];
  const item = fleetNestedItems().find((b) => words.every((w) => b.includes(w)));
  assert.ok(item, `fleet の skill の「## 入れ子の方式」に「${words.join('」「')}」をすべて含む箇条がありません`);
});

test('fleet の skill：入れ子の方式の節に、投稿の前の質問に答えの無い Issue の着手宣言を release <番号> で解除する箇条がある', () => {
  const item = fleetNestedItems().find((b) => b.includes('投稿の前') && b.includes('release <番号>'));
  assert.ok(item, 'fleet の skill の「## 入れ子の方式」に「投稿の前」と「release <番号>」を含む箇条がありません');
});

test('fleet の skill：入れ子の ship が申告を残して投稿してから質問を返す、という古い書き方が残っていない', () => {
  const item = bullets(read(FLEET_SKILL)).find((b) => b.includes('申告を残して投稿して質問を返す'));
  assert.ok(!item, `fleet の skill に「申告を残して投稿して質問を返す」が残っています（${item?.trim().slice(0, 40)}）`);
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

test('harness/CLAUDE.harness.md：進め方の投稿の前に聞く箇条に、入れ子の ship は投稿せずに fleet に返すことがある', () => {
  const rules = read(RULES);
  const start = rules.indexOf('## 進め方');
  const end = rules.indexOf('## 立場');
  assert.ok(start >= 0 && end > start, '「## 進め方」「## 立場」がありません');
  const item = bullets(rules.slice(start, end)).find((b) => b.includes('投稿の前') && b.includes('openQuestions') && b.includes('AskUserQuestion'));
  assert.ok(item, '進め方に「投稿の前」・openQuestions・AskUserQuestion を含む箇条がありません');
  for (const w of ['入れ子', '投稿せず', 'fleet']) assert.ok(item.includes(w), `投稿の前に聞く箇条に「${w}」がありません`);
});
