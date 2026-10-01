// Issue #396：hq が相談・アイデアを intel に回し（分け方・回す手順・人への案内・intel のタブの起こし方・いないときの扱い）、fleet が範囲の外の気づきを intel に送り、docs/operations.md と overview.html に回し方があることを確かめる。
// 語句は要点ごとに少なく絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const readRoot = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const hqSkill = (): string => readRoot('.claude', 'skills', 'hq', 'SKILL.md');
const fleetSkill = (): string => readRoot('.claude', 'skills', 'fleet', 'SKILL.md');

/** 見出しの行から、次の `## ` の行の前までを切り出す。見出しが無ければ空文字 */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** 行頭が `<n>. ` の番号付きの項から、行頭が `<n+1>. ` か `## ` の行の前までを切り出す（hq-sweep-skill.test.ts と同じ） */
function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith(`${n + 1}. `) || l.startsWith('## '));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** 語句がすべて text の中にあることを確かめる（hq-sweep-skill.test.ts と同じ） */
function assertWords(text: string, words: string[], what: string): void {
  assert.ok(text !== '', `${what}がありません`);
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

const HQ_INTEL = '## 相談・アイデアを intel に回す';
const hqIntel = (): string => section(hqSkill(), HQ_INTEL);

// ---- AC1：hq の「相談・アイデアを intel に回す」節 ----

test('hq の skill：分け方（人に上げるもの・intel に回すもの。今すぐの判断が要らないものは intel、question・plan-review は人）', () => {
  assertWords(hqIntel(), ['人に上げる', 'intel に回す', '今すぐの判断が要らない', 'question', 'plan-review'], 'hq の skill の「相談・アイデアを intel に回す」');
});

test('hq の skill：回す手順は SendMessage（to: intel）', () => {
  assertWords(hqIntel(), ['SendMessage', 'to: intel'], 'hq の skill の「相談・アイデアを intel に回す」');
});

test('hq の skill：人への案内（intel のタブに直接送ってください）', () => {
  assertWords(hqIntel(), ['intel のタブに直接送ってください'], 'hq の skill の「相談・アイデアを intel に回す」');
});

test('hq の skill：intel のタブの起こし方（ListAgents で既にいるかを見て、terminal create --title intel、--name intel）', () => {
  assertWords(hqIntel(), ['ListAgents', '既にいる', 'terminal create', '--title intel', '--name intel'], 'hq の skill の「相談・アイデアを intel に回す」');
});

test('hq の skill：intel がいないときの扱い（auto mode・手順12の一覧）', () => {
  assertWords(hqIntel(), ['auto mode', '手順12の一覧'], 'hq の skill の「相談・アイデアを intel に回す」');
});

test('hq の skill 手順12：一覧に intel に回せなかった気づきを出す', () => {
  assertWords(step(hqSkill(), 12), ['intel に回せなかった気づき'], 'hq の skill の手順12');
});

test('hq の skill 手順2：するのは…だけに、SendMessage と terminal create がある', () => {
  assertWords(step(hqSkill(), 2), ['SendMessage', 'terminal create'], 'hq の skill の手順2');
});

// ---- AC2：fleet が範囲の外の気づきを intel に送る ----

test('fleet の skill「Orca の worker として動くとき」：範囲の外の気づきを hq を通さず SendMessage（to: intel）で送り、worker_done に intel への送信を含める', () => {
  assertWords(
    section(fleetSkill(), '## Orca の worker として動くとき'),
    ['範囲の外の気づき', 'SendMessage', 'to: intel', 'hq を通さず', 'worker_done', 'intel への送信'],
    'fleet の skill の「Orca の worker として動くとき」',
  );
});

// ---- AC3：docs/operations.md と overview.html ----

/** docs/operations.md の「### hq（テーマごとの fleet をまとめる）」から、次の `## `・`### ` の見出しか行頭 `fleet と hq の設定` の前まで */
function operationsHq(): string {
  const lines = readRoot('docs', 'operations.md').split('\n');
  const start = lines.indexOf('### hq（テーマごとの fleet をまとめる）');
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## ') || l.startsWith('### ') || l.startsWith('fleet と hq の設定'));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

test('docs/operations.md の hq の節に、intel に回すことと intel のタブがある', () => {
  assertWords(operationsHq(), ['intel', '回す', 'intel のタブ'], 'docs/operations.md の「### hq（テーマごとの fleet をまとめる）」');
});

test('overview.html の Claude（付き添いのセッション）の section に intel に回すがある', () => {
  const html = readRoot('overview.html');
  const h3 = html.indexOf('<h3>Claude（付き添いのセッション）</h3>');
  assert.ok(h3 >= 0, 'overview.html に <h3>Claude（付き添いのセッション）</h3> がありません');
  const start = html.lastIndexOf('<section', h3);
  assert.ok(start >= 0, 'overview.html の Claude（付き添いのセッション）を含む <section> がありません');
  const end = html.indexOf('</section>', h3);
  assert.ok(end > h3, 'overview.html の Claude（付き添いのセッション）の <section> が閉じていません');
  assertWords(html.slice(start, end), ['intel に回す'], 'overview.html の Claude（付き添いのセッション）の section');
});
