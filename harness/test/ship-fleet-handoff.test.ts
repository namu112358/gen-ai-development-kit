// Issue #199：ship・fleet の SKILL.md の「ハーネスが更新されたときの交代」の文。読み込みが古いかを harness-drift・fleet-status の行で見る、
// 段階の切れ目（release の後）でだけ交代する、judge を古いセッションで始めない、AskUserQuestion で交代を聞く、本体を pull --ff-only で追いつかせて
// claude --permission-mode auto "/fleet …" を起動し auto mode を確かめる、Orca が無いときは渡す1行を示して止まる、入れ子の ship は「待つ（読み込みが古い）」で返す。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const SHIP_SKILL = '.claude/skills/ship/SKILL.md';
const HANDOFF = '## ハーネスが更新されたときの交代';

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

function mustSection(path: string, heading: string): string {
  const sub = section(read(path), heading);
  assert.ok(sub !== '', `${path} に「${heading}」の節がありません`);
  return sub;
}

function assertWords(where: string, text: string, words: string[]): void {
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${where} に次の語句がありません：${missing.join('、')}`);
}

/** 同じ行にすべての語句がある行 */
function lineWith(text: string, words: (string | RegExp)[]): string | undefined {
  return text.split('\n').find((l) => words.every((w) => (typeof w === 'string' ? l.includes(w) : w.test(l))));
}

/** バッククォートのコード（インラインの `…` と、``` で囲んだブロックの各行）を取り出す */
function codeSpans(text: string): string[] {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) out.push(...m[1]!.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  const inline = text.replace(fence, '');
  for (const m of inline.matchAll(/`([^`\n]+)`/g)) out.push(m[1]!.trim());
  return out;
}

const handoff = (): string => mustSection(FLEET_SKILL, HANDOFF);

// ---- fleet：古いかを見る ----

test('fleet の交代の節：fleet-status の「このセッションの読み込みは古い」の行と harness-drift で古いかを見る', () => {
  assertWords('fleet の交代の節', handoff(), ['このセッションの読み込みは古い', 'node harness/scripts/agent.ts harness-drift', 'fleet-status']);
});

// ---- fleet：段階の切れ目でだけ交代 ----

test('fleet の交代の節：新しい段階・ship を始めず、宣言を release で全部解除した後（段階の切れ目）でだけ交代し、段階の途中では交代しない', () => {
  const sub = handoff();
  assertWords('fleet の交代の節', sub, ['release <番号>', '段階の切れ目', '段階の途中では交代しない']);
  assert.ok(lineWith(sub, ['新しい段階', '始めない']), '「新しい段階…を始めない」の文がありません');
});

test('fleet の交代の節：judge の段階は古いセッションでは始めない（claim --stage judge・step も止める）', () => {
  const sub = handoff();
  assert.ok(lineWith(sub, ['judge', /古いセッション(で|では)始めない/]), 'judge を古いセッションで始めない、の文がありません');
  assertWords('fleet の交代の節', sub, ['claim --stage judge', 'step']);
});

// ---- fleet：人に聞く ----

test('fleet の交代の節：AskUserQuestion で「交代しますか」を聞き（おすすめは交代する）、拒まれたら繰り返さず渡す1行を示して止まる', () => {
  const sub = handoff();
  assertWords('fleet の交代の節', sub, ['AskUserQuestion', '交代しますか']);
  assert.ok(lineWith(sub, ['拒', '1行']), '拒まれたときに1行を示して止まる文がありません');
});

// ---- fleet：Orca があるとき ----

test('fleet の交代の節：Orca の CLI は orca-cli の skill の「Resolve the CLI」で選び、terminal create で本体に claude --permission-mode auto "/fleet …" を起動する', () => {
  assertWords('fleet の交代の節', handoff(), ['orca-cli', 'Resolve the CLI', 'terminal create', 'claude --permission-mode auto "/fleet']);
});

test('fleet の交代の節：本体（--git-common-dir の親）を git -C <本体> pull --ff-only で追いつかせてから起動し、できなければ起動しない', () => {
  const sub = handoff();
  assertWords('fleet の交代の節', sub, ['--git-common-dir', 'git -C <本体> pull --ff-only']);
  assert.ok(lineWith(sub, ['できなければ', '起動']), '追いつかせられないときに起動しない文がありません');
});

test('fleet の交代の節：起動後に画面のモード表示が auto mode かを確かめ、確かめられないときは人に返す。確かめたら引き継ぎの要約を示して元のセッションは終える', () => {
  const sub = handoff();
  assertWords('fleet の交代の節', sub, ['auto mode', '引き継ぎの要約']);
  assert.ok(lineWith(sub, ['auto mode', '確かめられない']), 'auto mode を確かめられないときの文がありません');
});

// ---- fleet：Orca が無いとき ----

test('fleet の交代の節：Orca が無い・動かないときは、渡す1行（/fleet <番号…>）と始め方（pull --ff-only・claude --permission-mode auto・auto mode）を示して止まる', () => {
  const sub = handoff();
  const line = lineWith(sub, ['Orca が無い']);
  assert.ok(line, '「Orca が無い」の文がありません');
  assertWords('fleet の交代の節', sub, ['/fleet <番号…>', 'pull --ff-only', 'claude --permission-mode auto', 'auto mode']);
});

// ---- fleet：人に返す条件 ----

test('fleet の人に返す条件：交代を拒まれたとき・auto mode を確かめられないとき', () => {
  const sub = mustSection(FLEET_SKILL, '## 人に返す条件');
  assertWords('fleet の人に返す条件', sub, ['交代を拒まれた', 'auto mode']);
});

// ---- ship ----

test('ship：単独の ship は各段階の claim の前に harness-drift で古いかを見て、古ければ段階を終えてから release し、fleet の交代の節と同じ手順で交代する（渡す1行は /fleet <自分の Issue 番号>）', () => {
  assertWords('ship の SKILL.md', read(SHIP_SKILL), ['harness-drift', 'ハーネスが更新されたときの交代', '/fleet <自分の Issue 番号>', 'release <番号>']);
});

test('ship：judge は古いセッションで始めない', () => {
  assert.ok(lineWith(read(SHIP_SKILL), ['judge', /古いセッション(で|では)始めない/]), 'ship に judge を古いセッションで始めない文がありません');
});

test('ship の「サブエージェントの ship として動くとき」：自分では交代せず、古いと分かったら進めずに「待つ（読み込みが古い）」として fleet に返す', () => {
  const sub = mustSection(SHIP_SKILL, '## サブエージェントの ship として動くとき');
  assertWords('ship のサブエージェントの節', sub, ['待つ（読み込みが古い）']);
  assert.ok(lineWith(sub, ['交代', /しない|せず/]), '自分では交代しない、の文がありません');
});

test('ship の人に返す条件：古いセッションで judge に当たったとき・交代を拒まれたとき', () => {
  const sub = mustSection(SHIP_SKILL, '## 人に返す条件');
  assert.ok(lineWith(sub, ['古い', 'judge']), '読み込みが古いセッションで judge に当たったとき、の条件がありません');
  assertWords('ship の人に返す条件', sub, ['交代を拒まれた']);
});

// ---- 素の orca を書かない ----

test('fleet・ship の SKILL.md に、素の orca で始まるコマンドが無い', () => {
  for (const path of [FLEET_SKILL, SHIP_SKILL]) {
    // orca-skills.test.ts の bareOrcaUses と同じ見方：`orca …` はコマンド、`orca` 単独は語として許す
    const bare = codeSpans(read(path)).filter((c) => /^orca\s/.test(c));
    assert.deepEqual(bare, [], `${path} に素の orca のコマンドがあります`);
  }
});
