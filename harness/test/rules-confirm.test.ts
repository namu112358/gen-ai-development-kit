// Issue #952：人の判断が要る場面で確認事項を書いてほかの Issue を進める規則と手順があることを確かめる。
// harness/CLAUDE.harness.md の「進め方」に確認事項の箇条（post-confirm で書き、release して、答えは step・fleet-status だけを根拠にする）があり、
// 「やってはいけないこと」にセッションが答え（agent-confirm-answer・/answer）を書かない規則があること、
// ship・fleet・implement・fix・sync の skill に確認事項の手順があること（ship・fleet は「確認事項の答え待ち」）、
// security.md・glossary.md・overview.html に確認事項の記述があることを、文言を固定しすぎずにキーワードの有無で確かめる。
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

test('規則：進め方に、確認事項を post-confirm で書いて release し、答えは step・fleet-status だけを根拠にする箇条がある', () => {
  const item = itemWith(section(read(RULES), '## 進め方'), 'post-confirm');
  includesAll(item, ['post-confirm', 'release', 'step', 'fleet-status'], '確認事項の箇条');
});

test('規則：やってはいけないことに、セッションが確認事項の答え（agent-confirm-answer・/answer）を書かない規則がある', () => {
  const item = itemWith(section(read(RULES), '## やってはいけないこと'), 'agent-confirm-answer');
  includesAll(item, ['agent-confirm-answer', '/answer'], '答えを書かない箇条');
});

test('skill：ship・fleet・implement・fix・sync に確認事項の手順がある', () => {
  for (const name of ['ship', 'fleet', 'implement', 'fix', 'sync']) {
    const path = `.claude/skills/${name}/SKILL.md`;
    includesAll(read(path), ['確認事項'], path);
  }
});

test('skill：ship・fleet に「確認事項の答え待ち」がある', () => {
  for (const name of ['ship', 'fleet']) {
    const path = `.claude/skills/${name}/SKILL.md`;
    includesAll(read(path), ['確認事項の答え待ち'], path);
  }
});

test('文書：security.md に答えの名義、glossary.md に確認事項の項、overview.html に確認事項がある', () => {
  for (const [path, key] of [
    ['harness/docs/security.md', '確認事項の答えの名義'],
    ['harness/docs/glossary.md', '### 確認事項'],
    ['overview.html', '確認事項'],
  ] as const) {
    includesAll(read(path), [key], path);
  }
});
