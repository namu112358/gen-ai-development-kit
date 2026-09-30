// Issue #409：hq がいない間の fleet の退行（見なす条件・人の判断待ち・二重に聞かない・hq が戻ったとき）、hq の控えの置き場所と引き継ぎ、
// 閉じる handle が hq 自身の端末でないことの確かめが fleet・hq の skill と docs/operations.md に書かれていることを、語句のまとまりごとに確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HQ_STATE_COMMANDS } from '../scripts/hq-state.ts';

const root = join(import.meta.dirname, '..', '..');
const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const HQ_SKILL = '.claude/skills/hq/SKILL.md';
const OPERATIONS = 'docs/operations.md';

const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** 語句がすべて text の中にあることを確かめる */
function assertWords(text: string, words: string[], what: string): void {
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

/** 見出しの行から、同じか上の階層の次の見出しの前までを切り出す */
function section(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `「${heading}」の節がありません`);
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** 「<n>. 」で始まる番号の段落（下の字下げした行を含む）を、次の番号の行か見出しの前まで切り出す */
function numbered(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  assert.ok(start >= 0, `手順${n}の段落がありません`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || /^#+ /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const fleetWorker = (): string => section(read(FLEET_SKILL), '## Orca の worker として動くとき');
const hqSkill = (): string => read(HQ_SKILL);

// ---- fleet：hq がいないと見なす条件と退行 ----

test('fleet の skill（Orca の worker として動くとき）：hq がいないと見なす条件', () => {
  assertWords(fleetWorker(), ['hq がいない', 'terminal show', 'hqHandle', '5分', '2回', 'ORCA status'], 'fleet の「Orca の worker として動くとき」');
});

test('fleet の skill（Orca の worker として動くとき）：hq がいない間は聞いた Issue だけ release し、ほかの Issue は進め、控えとペインに出す', () => {
  assertWords(fleetWorker(), ['release <番号>', 'ほかの Issue は進める', 'hq-state.ts pending-add', 'panes.ts todo'], 'fleet の「Orca の worker として動くとき」');
});

test('fleet の skill（Orca の worker として動くとき）：同じ質問を二重に出さない', () => {
  assertWords(fleetWorker(), ['二重に出さない'], 'fleet の「Orca の worker として動くとき」');
});

test('fleet の skill（Orca の worker として動くとき）：hq が戻ったときは hq-back で知らせ、--resume で待ち直し、控えを答え済みにするか外す', () => {
  assertWords(fleetWorker(), ['hq-back', '--resume', 'hq-state.ts pending-remove', 'hq-state.ts pending-answer'], 'fleet の「Orca の worker として動くとき」');
});

test('fleet の skill（Orca の worker として動くとき）の4：fleet が使ってよいものに hq-state.ts pending がある', () => {
  const p = numbered(fleetWorker(), 4);
  assert.ok(p.includes('指揮と読むことだけ'), '4 が「fleet は指揮と読むことだけ」の段落ではありません');
  assertWords(p, ['hq-state.ts pending'], 'fleet の「Orca の worker として動くとき」の4 ');
});

// ---- hq：控えの置き場所と引き継ぎ ----

test('hq の skill：控えは git の共通ディレクトリの agent-harness/hq/hq-fleets.json に hq-state.ts で読み書きする', () => {
  assertWords(hqSkill(), ['agent-harness/hq/hq-fleets.json', 'hq-state.ts ledger', 'hq-state.ts ledger-save'], 'hq の skill ');
});

test('hq の skill：新しい hq は最初に前の hq の控えを読んで引き継ぐ（run-use・pending --all・hq-back）', () => {
  assertWords(hqSkill(), ['前の hq の引き継ぎ', 'run-use', 'hq-state.ts pending --all', 'hq-back'], 'hq の skill ');
});

test('hq の skill の手順2：控えは git の共通ディレクトリに書き、書き換えに数えない', () => {
  const p = numbered(section(hqSkill(), '## 手順'), 2);
  assert.ok(p.includes('hq は書き換えない'), '手順2が「hq は書き換えない」の段落ではありません');
  assertWords(p, ['git の共通ディレクトリ', '書き換えに数えない'], 'hq の skill の手順2 ');
});

test('hq の skill：入力の控えを scratchpad の hq-fleets.json と言わない', () => {
  assert.ok(!hqSkill().includes('scratchpad の `hq-fleets.json`'), '控えの置き場所が scratchpad のままです');
});

// ---- hq：閉じる handle が hq 自身の端末でないことの確かめ ----

test('hq の skill：ORCA terminal close の前に、閉じる handle が hqHandle（hq 自身の端末）でないことを確かめる', () => {
  const text = hqSkill();
  assertWords(text, ['hqHandle', '--tab', '--all', 'ORCA terminal close'], 'hq の skill ');
  const lines = text.split(/\r?\n/).filter((l) => l.includes('閉じる handle が') && l.includes('hqHandle'));
  assert.ok(lines.length > 0, '「閉じる handle が」と hqHandle を含む文がありません');
});

// ---- docs/operations.md ----

test('docs/operations.md の hq の節：hq がいない間の見方と戻し方', () => {
  const text = section(read(OPERATIONS), '### hq（テーマごとの fleet をまとめる）');
  assertWords(text, ['hq がいない間', 'あなたがすること', 'fleet のタブで答える', 'intel', '/hq', 'hq-fleets.json', '書き換えに数えない'], 'docs/operations.md の hq の節');
});

// ---- skill に出る hq-state.ts のコマンドが実在する ----

test('fleet・hq の skill に出る hq-state.ts のコマンドは、すべて HQ_STATE_COMMANDS にある', () => {
  const used = new Set<string>();
  for (const path of [FLEET_SKILL, HQ_SKILL]) {
    for (const m of read(path).matchAll(/hq-state\.ts\s+([a-z][a-z-]*)/g)) used.add(m[1]!);
  }
  assert.ok(used.size > 0, 'skill に hq-state.ts のコマンドがありません');
  const unknown = [...used].filter((c) => !HQ_STATE_COMMANDS.includes(c));
  assert.deepEqual(unknown, [], `HQ_STATE_COMMANDS に無いコマンド：${unknown.join('、')}`);
});
