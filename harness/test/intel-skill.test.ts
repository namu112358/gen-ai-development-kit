// Issue #394：intel の skill の書き方（控える・まとめる・既存の Issue と照らす・下書きを一覧で示して止まる・根拠つきで答える・触らないこと）と、hq の「相談・アイデアを intel に回す」節、skill の一覧（CLAUDE.md・CLAUDE.harness.md・skills の README・overview.html）への載せ方を確かめる。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';

const root = join(import.meta.dirname, '..', '..');
const HEADINGS = ['## 入力', '## 手順', '## やってはいけないこと', '## 終わりの状態'];

const skillPath = join(root, '.claude', 'skills', 'intel', 'SKILL.md');
const readRoot = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const skill = (): string => readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');

/** 先頭の `---` で囲まれた frontmatter を key: value で読む（patrol-skill.test.ts と同じ） */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** 見出し（`## ` で始まる行）から次の同じ深さの見出しまでの本文。見出しが無ければ null（patrol-skill.test.ts と同じ） */
function section(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

function mustSection(text: string, heading: string, name: string): string {
  const body = section(text, heading);
  assert.ok(body !== null, `${name} に「${heading}」がありません`);
  return body;
}

function assertWords(body: string, words: string[], where: string): void {
  for (const word of words) assert.ok(body.includes(word), `${where} に「${word}」がありません`);
}

test('intel の SKILL.md があり、frontmatter の name が intel で description がある', () => {
  assert.ok(existsSync(skillPath), 'intel/SKILL.md がありません');
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'intel');
  assert.ok(fm.description, 'description がありません');
});

test('入力・手順・やってはいけないこと・終わりの状態の見出しがある', () => {
  const lines = skill().split('\n');
  for (const h of HEADINGS) assert.ok(lines.includes(h), `「${h}」がありません`);
});

test('手順に、気づきを控えること（memo.md・日時・出どころ）がある', () => {
  assertWords(mustSection(skill(), '## 手順', 'SKILL.md'), ['memo.md', '日時', '出どころ'], '「## 手順」');
});

test('手順に、似たものをまとめること（似たもの・まとめ）がある', () => {
  assertWords(mustSection(skill(), '## 手順', 'SKILL.md'), ['似たもの', 'まとめ'], '「## 手順」');
});

test('手順に、既存の Issue と照らすこと（gh issue list・#177・#186・コメントの案・AC 案）がある', () => {
  assertWords(mustSection(skill(), '## 手順', 'SKILL.md'), ['gh issue list', '#177', '#186', 'コメントの案', 'AC 案'], '「## 手順」');
});

test('手順に、下書きを一覧で示して止まり、承認で作っても計画には進まないことがある', () => {
  assertWords(mustSection(skill(), '## 手順', 'SKILL.md'), ['一覧', '止まる', '作って', '計画には進まない', '承認', '下書き'], '「## 手順」');
});

test('手順に、人の質問に根拠つきで答えること（根拠・ファイルと行・panes.ts hq）がある', () => {
  assertWords(mustSection(skill(), '## 手順', 'SKILL.md'), ['根拠', 'ファイルと行', 'panes.ts hq'], '「## 手順」');
});

test('Issue #437：hq のペインの読み方は panes.ts hq todo で書き、ペインの名前の無い panes.ts hq を使わない', () => {
  const text = skill();
  assert.ok(text.includes('panes.ts hq todo'), 'SKILL.md に「panes.ts hq todo」がありません');
  const bare = text.match(/panes\.ts hq(?! (todo|board|log)\b)/);
  assert.equal(bare, null, `ペインの名前の無い書き方があります: ${bare?.[0]}`);
});

test('手順に、名前（ListAgents）と受け取りの返事（受け取った）、進め方の話を hq に回すことがある', () => {
  assertWords(mustSection(skill(), '## 手順', 'SKILL.md'), ['ListAgents', '受け取った', 'hq のタブで伝えてください'], '「## 手順」');
});

test('やってはいけないことに、AskUserQuestion・ラベル・着手宣言・PR・fleet に指示しないがある', () => {
  assertWords(mustSection(skill(), '## やってはいけないこと', 'SKILL.md'), ['AskUserQuestion', 'ラベル', '着手宣言', 'PR', 'fleet に指示しない'], '「## やってはいけないこと」');
});

test('skill が使う agent.ts のコマンドは使い方のコメントに実在する', () => {
  const known = documentedAgentCommands();
  const used = [...skill().matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
});

test('hq の SKILL.md に「相談・アイデアを intel に回す」節があり、SendMessage・to: intel・ListAgents・手順12の一覧がある', () => {
  const hq = readRoot('.claude', 'skills', 'hq', 'SKILL.md');
  const body = mustSection(hq, '## 相談・アイデアを intel に回す', 'hq の SKILL.md');
  assertWords(body, ['SendMessage', 'to: intel', 'ListAgents', '手順12の一覧'], 'hq の「## 相談・アイデアを intel に回す」');
});

test('harness/CLAUDE.harness.md の skill の表に intel の行がある', () => {
  const lines = readRoot('harness', 'CLAUDE.harness.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| [intel](../.claude/skills/intel/SKILL.md) |')), 'harness/CLAUDE.harness.md に intel の行がありません');
});

test('CLAUDE.md の構成の表の .claude/skills/ の行に intel がある', () => {
  const row = readRoot('CLAUDE.md').split('\n').find((l) => l.startsWith('| `.claude/skills/` |'));
  assert.ok(row, 'CLAUDE.md に `.claude/skills/` の行がありません');
  assert.ok(row.includes('intel'), `CLAUDE.md の .claude/skills/ の行に intel がありません: ${row}`);
});

test('.claude/skills/README.md の表に intel/ の行がある', () => {
  const lines = readRoot('.claude', 'skills', 'README.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| `intel/` |')), '.claude/skills/README.md に `intel/` の行がありません');
});

test('overview.html の Claude の card（<section class="card claude">）に intel がある', () => {
  const html = readRoot('overview.html');
  const start = html.indexOf('<section class="card claude">');
  assert.ok(start >= 0, 'overview.html に <section class="card claude"> がありません');
  const end = html.indexOf('</section>', start);
  assert.ok(end > start, 'overview.html の <section class="card claude"> が閉じていません');
  assert.ok(html.slice(start, end).includes('intel'), 'overview.html の Claude の card に intel がありません');
});
