// Issue #778：auto mode の保留の検討会は、fleet が開くかを人に聞かずに開く（付き添いでも hq の worker でも聞かない）ことが
// fleet の skill と規則（harness/CLAUDE.harness.md の聞かずに決めてよい場面）に書いてあり、保留を解かない・`agent:plan-review` を外さない・
// 結論を3行で人に上げる、は変わらないことを、文言を固定しすぎずにキーワードの有無で確かめる。
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

const FLEET = '.claude/skills/fleet/SKILL.md';
const RULES = 'harness/CLAUDE.harness.md';
const council = () => section(read(FLEET), '## auto mode の保留の検討会');

test('fleet：検討会は開くかを人に聞かずに開き（hq の worker のときも ask しない）、人に上げるのは結論の3行だけ', () => {
  const item = itemWith(council(), '**開くのは fleet**');
  includesAll(item, ['聞かずに開く', 'ask', '結論の3行だけ'], 'fleet の検討会の「開くのは fleet」の箇条');
});

test('fleet：検討会の守り（保留を解かない・agent:plan-review を外さない・結論を3行で人に上げる）は残る', () => {
  const sec = council();
  includesAll(itemWith(sec, '**しないこと**'), ['保留を解かない', '`agent:plan-review` を外さない'], 'fleet の検討会の「しないこと」の箇条');
  includesAll(itemWith(sec, '**人に上げる3行の形**'), ['保留：', '結論：', '見落とし：'], 'fleet の検討会の「人に上げる3行の形」の箇条');
});

test('規則：聞かずに決めてよい場面に、検討会を聞かずに開くことがある', () => {
  const item = itemWith(section(read(RULES), '## 進め方'), 'plan-review-check', 'riskOnly');
  includesAll(item, ['検討会', '聞かずに開く'], '聞かずに決める箇条');
});
