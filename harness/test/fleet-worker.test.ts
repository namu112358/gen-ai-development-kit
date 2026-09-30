// Issue #285：fleet の skill の「## Orca の worker として動くとき」の節（hq に ask で聞き答えで続ける・ペインの作成と片付け・shipMode の読み分け・書き換えないこと）を検査する
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const WORKER_HEADING = '## Orca の worker として動くとき';

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

/** worker の節（無ければ assert で落とす） */
function workerSection(): string {
  const sub = section(read(FLEET_SKILL), WORKER_HEADING);
  assert.ok(sub !== '', `fleet の skill に「${WORKER_HEADING}」の節がありません`);
  return sub;
}

/** 語句がすべて節の中にあることを確かめる */
function assertWords(sub: string, words: string[]): void {
  const missing = words.filter((w) => !sub.includes(w));
  assert.deepEqual(missing, [], `「${WORKER_HEADING}」の節に次の語句がありません：${missing.join('、')}`);
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

// ---- AC1：worker のときに hq に ask で聞く手順と、答えで続ける手順 ----

test('fleet の skill：worker の節に、hq に orchestration ask で聞き、答え（reply）を受けて --resume で続ける手順がある', () => {
  assertWords(workerSection(), ['orchestration ask', '--resume', 'reply']);
});

test('fleet の skill：worker の節に、worker のときは AskUserQuestion を使わないことが書かれている', () => {
  const sub = workerSection();
  const line = sub.split('\n').find((l) => l.includes('AskUserQuestion') && /使わ/.test(l));
  assert.ok(line, '「AskUserQuestion」を使わない、という文（同じ行に「AskUserQuestion」と「使わ」）がありません');
});

test('fleet の skill：worker の節に、終わりに worker_done を送ることと、release <番号> で着手宣言を解除することがある', () => {
  assertWords(workerSection(), ['worker_done', 'release <番号>']);
});

// ---- AC2：ワークスペースのペインを作る・片付ける ----

test('fleet の skill：worker の節に、terminal split と terminal send でペインを作り、panes.ts collect・todo・prs を表示する手順がある', () => {
  assertWords(workerSection(), ['terminal split', 'terminal send', 'panes.ts collect', 'panes.ts todo', 'panes.ts prs']);
});

test('fleet の skill：worker の節に、terminal close でペインを片付け、空のシェルのペインを残さない手順がある', () => {
  assertWords(workerSection(), ['terminal close', '空のシェルのペイン']);
});

// ---- shipMode の読み分け ----

test('fleet の skill：worker の節に、node harness/scripts/panes.ts config で shipMode を読み、worker と subagent を読み分ける手順がある', () => {
  assertWords(workerSection(), ['node harness/scripts/panes.ts config', 'worker', 'subagent']);
});

// ---- 書き換えないこと ----

test('fleet の skill：worker の節に、書き換えないことと、Issue の worktree の中でだけ作業することがある', () => {
  assertWords(workerSection(), ['書き換えない', 'Issue の worktree の中でだけ']);
});

// ---- Orca のコマンドの書き方 ----

test('fleet の skill：worker の節のバッククォートのコードに素の orca で始まるものが無く、ORCA で始まる形がある', () => {
  const spans = codeSpans(workerSection());
  const bare = spans.filter((s) => s.startsWith('orca '));
  assert.deepEqual(bare, [], `素の「orca 」で始まるコードがあります：${bare.join('、')}`);
  assert.ok(spans.some((s) => s.startsWith('ORCA ')), '「ORCA 」で始まるコードがありません');
});

// ---- AC3：hq を使わないときの手順が変わらない ----

test('fleet の skill：「## 手順」と「## 入れ子の方式」の節に orchestration ask も worker_done も出てこない', () => {
  const skill = read(FLEET_SKILL);
  for (const heading of ['## 手順', '## 入れ子の方式']) {
    const sub = section(skill, heading);
    assert.ok(sub !== '', `fleet の skill に「${heading}」の節がありません`);
    for (const w of ['orchestration ask', 'worker_done']) {
      assert.ok(!sub.includes(w), `「${heading}」の節に「${w}」が出てきます`);
    }
  }
});

// ---- 節の順番 ----

test('fleet の skill：節の順番が「## 入れ子の方式」<「## Orca の worker として動くとき」<「## 終わりの状態」になっている', () => {
  const lines = read(FLEET_SKILL).split('\n');
  const at = (h: string): number => lines.findIndex((l) => l.startsWith(h));
  const nested = at('## 入れ子の方式');
  const worker = at(WORKER_HEADING);
  const end = at('## 終わりの状態');
  assert.ok(nested >= 0, '「## 入れ子の方式」の節がありません');
  assert.ok(worker >= 0, `「${WORKER_HEADING}」の節がありません`);
  assert.ok(end >= 0, '「## 終わりの状態」の節がありません');
  assert.ok(nested < worker, `「${WORKER_HEADING}」が「## 入れ子の方式」より前にあります`);
  assert.ok(worker < end, `「${WORKER_HEADING}」が「## 終わりの状態」より後にあります`);
});
