// Issue #197：fleet の skill の「## Orca の worker で ship を動かすとき」の節（Orca の有無の確かめ・worker の起こし方と条件・今の手順に戻る分かれ道・claim の --force と failed の worker_done・コマンドの書き方）を検査する
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const SHIP_WORKER_HEADING = '## Orca の worker で ship を動かすとき';
const WORKER_HEADING = '## Orca の worker として動くとき';

/** 見出しの行（前方一致）から、同じか上の階層の次の見出しの前までを切り出す */
function section(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
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

/** 節の中の番号つきの手順（`n. ` の行から次の `n+1. ` の行の前まで）を切り出す */
function step(sub: string, n: number): string {
  const lines = sub.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** ship を worker で動かす節（無ければ assert で落とす） */
function shipWorkerSection(): string {
  const sub = section(read(FLEET_SKILL), SHIP_WORKER_HEADING);
  assert.ok(sub !== '', `fleet の skill に「${SHIP_WORKER_HEADING}」の節がありません`);
  return sub;
}

/** 語句がすべて text の中にあることを確かめる */
function assertWords(text: string, words: string[], what = `「${SHIP_WORKER_HEADING}」の節`): void {
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

/** 語句をすべて含む行があることを確かめる（1つの文として書かれているか） */
function assertLine(text: string, words: (string | RegExp)[], what = `「${SHIP_WORKER_HEADING}」の節`): void {
  const hit = text.split('\n').some((l) => words.every((w) => (typeof w === 'string' ? l.includes(w) : w.test(l))));
  assert.ok(hit, `${what}に、次の語句を同じ行に含む文がありません：${words.map(String).join('、')}`);
}

/** バッククォートのコード（インラインの `…` と、``` で囲んだブロックの各行）を取り出す */
function codeSpans(text: string): string[] {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) out.push(...m[1]!.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== ''));
  const inline = text.replace(fence, '');
  for (const m of inline.matchAll(/`([^`\n]+)`/g)) out.push(m[1]!.trim());
  return out;
}

// ---- AC1：Orca の有無の確かめ・worker-start・worker_done・fleet-status の読み直し・状態の正 ----

test('fleet の skill：ship を worker で動かす節で、panes.ts config の shipMode が worker のとき ORCA status と ORCA skills get orchestration で Orca の有無を確かめる', () => {
  const s1 = step(shipWorkerSection(), 1);
  assert.ok(s1 !== '', '節に手順 1 がありません');
  assertWords(s1, ['node harness/scripts/panes.ts config', 'shipMode', '`worker`', 'ORCA status', 'ORCA skills get orchestration'], '節の手順 1 ');
});

test('fleet の skill：ship を worker で動かす節に、worker-start で起こし、worker_done を受けて fleet-status を読み直す手順がある', () => {
  const sub = shipWorkerSection();
  assertWords(sub, ['ORCA orchestration worker-start', 'worker_done', 'node harness/scripts/agent.ts fleet-status']);
  assertLine(sub, ['worker_done', 'node harness/scripts/agent.ts fleet-status', '読み直']);
});

test('fleet の skill：ship を worker で動かす節に、状態の正は GitHub・人の判断の正はラベル（decision gate は正にしない）とある', () => {
  const sub = shipWorkerSection();
  assertLine(sub, [/状態の正は\s*GitHub/]);
  assertLine(sub, [/判断の正は\s*ラベル/]);
  assertLine(sub, ['decision gate', '正にしない']);
});

// ---- AC2：今の手順に戻る分かれ道・入口の skill より優先・ORCA open を試さない・見出しが残る ----

test('fleet の skill：Orca が無い・動かないときは今の手順（「手順」「入れ子の方式（orca）」）で進める', () => {
  const s1 = step(shipWorkerSection(), 1);
  assertLine(s1, ['失敗', 'Orca が無い', '今の手順'], '節の手順 1 ');
  assertWords(s1, ['「手順」', '入れ子の方式（orca）'], '節の手順 1 ');
});

test('fleet の skill：worker の起動に失敗したら出し直さず、このセッションで今の手順で進める', () => {
  const s7 = step(shipWorkerSection(), 7);
  assert.ok(s7 !== '', '節に手順 7 がありません');
  assertLine(s7, ['worker-start', '0 以外', '今の手順'], '節の手順 7 ');
  assertWords(s7, ['出し直さ'], '節の手順 7 ');
});

test('fleet の skill：今の手順に戻る分かれ道を入口の skill の指示より優先し、ORCA open を試さない', () => {
  const sub = shipWorkerSection();
  assertLine(sub, ['入口の skill', '優先']);
  assertLine(sub, ['`ORCA open`', '試さない']);
});

test('fleet の skill：hq に起こされた fleet が起動に失敗したら、入れ子の方式に戻るか、入れ子にできなければ escalation で止める', () => {
  const s7 = step(shipWorkerSection(), 7);
  assertLine(s7, ['hq に起こされた fleet', '入れ子の方式に戻る'], '節の手順 7 ');
  assertLine(s7, ['入れ子にできなければ', 'escalation', '止める'], '節の手順 7 ');
});

test('fleet の skill：今の手順の見出し「## 手順」「## 入れ子の方式（orca）」が残る', () => {
  const lines = read(FLEET_SKILL).split(/\r?\n/);
  for (const h of ['## 手順', '## 入れ子の方式（orca）']) assert.ok(lines.includes(h), `見出し「${h}」がありません`);
});

// ---- AC3：worker の claim の --force と、failed の worker_done ----

test('fleet の skill：worker の claim が領域の上限で止まれば --force で宣言し直す', () => {
  assertLine(shipWorkerSection(), ['領域の上限', '`--force`']);
});

test('fleet の skill：worker の claim がほかのセッションの宣言で止まれば、worker_done を --outcome failed で送る', () => {
  assertLine(shipWorkerSection(), ['ほかのセッションの宣言で止まったら', 'worker_done', '--outcome failed']);
});

// ---- AC4：素の orca が無い・agent.ts のコマンドは完全な形 ----

test('fleet の skill：バッククォートのコードに素の orca で始まるものが無く、ship を worker で動かす節に ORCA で始まる形がある', () => {
  const bare = codeSpans(read(FLEET_SKILL)).filter((s) => /^orca\s/.test(s));
  assert.deepEqual(bare, [], `素の「orca 」で始まるコードがあります：${bare.join('、')}`);
  assert.ok(codeSpans(shipWorkerSection()).some((s) => s.startsWith('ORCA ')), '「ORCA 」で始まるコードがありません');
});

test('fleet の skill：agent.ts のコマンドは node harness/scripts/agent.ts <コマンド> の完全な形で書かれ、使い方のコメントに実在する', () => {
  const known = documentedAgentCommands();
  assert.ok(known.has('claim') && known.has('fleet-status'), '使い方のコメントからコマンドを読めていません');
  const text = read(FLEET_SKILL);
  const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  assert.ok(used.length > 0, 'agent.ts のコマンドがありません');
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
  assert.equal(text.split('agent.ts ').length - 1, used.length, 'agent.ts のコマンドは完全な形（node harness/scripts/agent.ts <コマンド>）で書く');
});

test('fleet の skill：ship を worker で動かす節で、agent.ts のコマンドを引数つきで書くときは node harness/scripts/agent.ts で始まる', () => {
  // check は Orca の orchestration のサブコマンドと同じ名前なので除く
  const known = new Set([...documentedAgentCommands()].filter((c) => c !== 'check'));
  const bare = codeSpans(shipWorkerSection()).filter((s) => {
    const [first, ...args] = s.split(/\s+/);
    return known.has(first!) && args.length > 0;
  });
  assert.deepEqual(bare, [], `完全な形でない agent.ts のコマンドがあります：${bare.join('、')}`);
});

// ---- 起動のしかた（権限モード） ----

test('fleet の skill：worker は claude --permission-mode auto で起動し、画面が auto mode かを確かめ、bypass なら起こさない', () => {
  const s4 = step(shipWorkerSection(), 4);
  assert.ok(s4 !== '', '節に手順 4 がありません');
  assertWords(s4, ['claude --permission-mode auto', 'ORCA terminal read', 'auto mode'], '節の手順 4 ');
  assertLine(s4, ['bypass', '起こさず'], '節の手順 4 ');
});

test('fleet の skill：worker の起こし方は claim → worktree → release → worker-start の順', () => {
  const s4 = step(shipWorkerSection(), 4);
  const order = [
    'node harness/scripts/agent.ts claim',
    'node harness/scripts/agent.ts worktree',
    'node harness/scripts/agent.ts release',
    'ORCA orchestration worker-start',
  ];
  const at = order.map((w) => s4.indexOf(w));
  order.forEach((w, i) => assert.ok(at[i]! >= 0, `節の手順 4 に「${w}」がありません`));
  for (let i = 1; i < order.length; i++) assert.ok(at[i - 1]! < at[i]!, `「${order[i - 1]}」が「${order[i]}」より前にありません`);
});

// ---- worker を起こす条件と Run ----

test('fleet の skill：worker を起こすのは、次にやることが段階で、settle していない Dispatch が無い Issue だけ', () => {
  const s3 = step(shipWorkerSection(), 3);
  assert.ok(s3 !== '', '節に手順 3 がありません');
  assertLine(s3, ['次にやること', '段階', 'settle していない Dispatch が無い'], '節の手順 3 ');
  assertWords(s3, ['同時に動かす ship は'], '節の手順 3 ');
});

test('fleet の skill：ship の worker の worker-start・worker-list・check のコマンドには fleet の Run の --run を付ける', () => {
  const sub = shipWorkerSection();
  assertWords(sub, ['ORCA orchestration run-create']);
  const cmds = codeSpans(sub).filter((s) => /^ORCA orchestration (worker-start|worker-list|check)\b/.test(s));
  assert.ok(cmds.some((s) => s.startsWith('ORCA orchestration worker-start')), 'worker-start のコマンドがありません');
  const noRun = cmds.filter((s) => !s.includes('--run '));
  assert.deepEqual(noRun, [], `--run の無いコマンドがあります：${noRun.join('、')}`);
});

// ---- worker として動くときの節との関係 ----

test('fleet の skill：worker として動くときの節の手順 4（fleet がしてよいこと）に node harness/scripts/agent.ts worktree と worker-start がある', () => {
  const sub = section(read(FLEET_SKILL), WORKER_HEADING);
  assert.ok(sub !== '', `fleet の skill に「${WORKER_HEADING}」の節がありません`);
  const s4 = step(sub, 4);
  assert.ok(s4 !== '', `「${WORKER_HEADING}」の節に手順 4 がありません`);
  assertWords(s4, ['node harness/scripts/agent.ts worktree', 'worker-start', 'Orca の worker で ship を動かすとき'], `「${WORKER_HEADING}」の節の手順 4 `);
});

test('fleet の skill：節の順番が「## 入れ子の方式」<「## Orca の worker で ship を動かすとき」<「## Orca の worker として動くとき」', () => {
  const lines = read(FLEET_SKILL).split(/\r?\n/);
  const at = (h: string): number => lines.findIndex((l) => l.startsWith(h));
  const order = ['## 入れ子の方式', SHIP_WORKER_HEADING, WORKER_HEADING];
  for (const h of order) assert.ok(at(h) >= 0, `「${h}」の節がありません`);
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]!) < at(order[i]!), `「${order[i - 1]}」が「${order[i]}」より前にありません`);
});
