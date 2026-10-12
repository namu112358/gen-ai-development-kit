// Issue #340：付き添いのセッションが聞かずに決めてよい場面と基準・人に上げる場面の一覧（harness/CLAUDE.harness.md）と、
// plan・ship・fleet・implement の skill の人に聞く箇所がその基準に沿っていること（agent:plan-review は plan-review-check の riskOnly で決め、
// ガードレールに触れる計画は人に上げる。決めたことは post-judgment で残し、ship・fleet の最後の一覧に「決めたこと（覆すなら）」で載せる）を、
// 文言を固定しすぎずにキーワードの有無で確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

/** 字下げの無い箇条（- か 番号. で始まる行）ごとに分ける。下の字下げした行・入れ子の箇条は親に含める */
const topItems = (text: string): string[] => text.split(/\n(?=(?:-|\d+\.) )/);
/** 節（## 見出しから次の ## 見出しの前まで） */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `節「${heading}」がありません`);
  const next = text.indexOf('\n## ', start + heading.length);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}
function itemWith(text: string, ...keys: string[]): string {
  const item = topItems(text).find((b) => keys.every((k) => b.includes(k)));
  assert.ok(item, `${keys.join('・')} を含む箇条がありません`);
  return item;
}
const includesAll = (text: string, keys: string[], where: string) => {
  for (const k of keys) assert.ok(text.includes(k), `${where} に「${k}」がありません`);
};

const RULES = 'harness/CLAUDE.harness.md';
const progress = () => section(read(RULES), '## 進め方');

test('規則：聞かずに決める場面と基準（plan-review-check の riskOnly・批評の止める条件・files の外・領域の上限・記録済みの決定）がある', () => {
  const item = itemWith(progress(), 'plan-review-check', 'riskOnly');
  includesAll(item, ['agent:plan-review', 'plan-review-check', 'riskOnly', 'ガードレール', 'delegateMergeExclude', 'harness.config.json', 'implement'], '聞かずに決める箇条');
  // ほかの聞かずに決める場面
  includesAll(item, ['plan-critic', '止める条件', 'files', '領域の上限', '記録'], '聞かずに決める箇条');
});

test('規則：人に上げる場面の一覧がある（ガードレールに触れる計画の plan-review・守り・データ・AC の変更・決まらない質問・引き継ぎ・食い違い）', () => {
  const item = itemWith(progress(), '人に上げる場面', '--takeover');
  includesAll(
    item,
    ['agent:plan-review', 'ガードレール', 'delegateMergeExclude', 'harness.config.json', '守り', 'データ', 'acChangeProposed', 'Planner の質問', '--takeover', '食い違', '1行'],
    '人に上げる場面の箇条',
  );
});

test('規則：聞かずに決めたことを post-judgment で残し、ship・fleet の最後の一覧に「決めたこと（覆すなら）」で載せる', () => {
  const item = itemWith(progress(), 'post-judgment', '決めたこと（覆すなら）');
  includesAll(item, ['セッションの判定', 'ship', 'fleet'], 'セッションの判定の記録の箇条');
});

test('plan・ship：agent:plan-review の手順は plan-review-check の riskOnly で決め、進めたら post-judgment、ガードレールに触れる計画は人に上げる', () => {
  for (const path of ['.claude/skills/plan/SKILL.md', '.claude/skills/ship/SKILL.md']) {
    const item = itemWith(read(path), 'agent:plan-review', 'plan-review-check');
    includesAll(item, ['riskOnly', 'post-judgment', 'implement', 'ガードレール', '人に上げる', 'AskUserQuestion'], `${path} の agent:plan-review の手順`);
  }
});

test('ship：人に返す条件の agent:plan-review は、ガードレールに触れる計画などの人に上げる場面に絞る', () => {
  const returns = section(read('.claude/skills/ship/SKILL.md'), '## 人に返す条件');
  const line = returns.split('\n').find((l) => l.includes('agent:plan-review'));
  assert.ok(line, 'ship の人に返す条件に agent:plan-review の行がありません');
  includesAll(line, ['ガードレール'], 'ship の人に返す条件の agent:plan-review の行');
});

test('implement：files の外・scope-check の終了コード1は、人に上げる場面に当たらなければ計画を出し直すと決めて post-judgment', () => {
  const skill = read('.claude/skills/implement/SKILL.md');
  const outside = itemWith(skill, '計画に無い設計の判断');
  includesAll(outside, ['人に上げる', '出し直', 'post-judgment'], 'implement の files の外の手順');
  const exit1 = skill.split(/\n(?=\s*(?:-|\d+\.) )/).find((b) => b.includes('終了コード 1') && b.includes('outside'));
  assert.ok(exit1, 'implement の scope-check の終了コード 1 の箇条がありません');
  includesAll(exit1, ['人に上げる', '出し直', 'post-judgment'], 'implement の scope-check の終了コード 1 の箇条');
});

test('implement：領域の上限で claim が止まったら「待つ」と決める（--force は人が急ぐと言ったときだけ）', () => {
  const step1 = itemWith(read('.claude/skills/implement/SKILL.md'), '--stage implement', '上限');
  includesAll(step1, ['待つ', '--force'], 'implement の手順1');
});

test('ship・fleet：最後の一覧と、入れ子の ship が返すものに「決めたこと（覆すなら）」がある', () => {
  const ship = read('.claude/skills/ship/SKILL.md');
  includesAll(itemWith(ship, '**人がすること**'), ['決めたこと（覆すなら）'], 'ship の人がすることの一覧');
  const nested = section(ship, '## サブエージェントの ship として動くとき');
  includesAll(itemWith(nested, '返すもの'), ['決めたこと（覆すなら）'], 'サブエージェントの ship の返すもの');
  includesAll(nested, ['人に上げる場面'], 'サブエージェントの ship の聞かずに止まる場面');
  const fleet = read('.claude/skills/fleet/SKILL.md');
  includesAll(itemWith(fleet, '**人がすること**'), ['決めたこと（覆すなら）'], 'fleet の人がすることの一覧');
  includesAll(fleet, ['人に上げる場面'], 'fleet の人の判断待ちをまとめて聞く手順');
});
