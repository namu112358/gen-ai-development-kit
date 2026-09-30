// Issue #287：hq の skill（.claude/skills/hq/SKILL.md）に、テーマの案 → 人の承認 → fleet の起動 → 人の判断をまとめて聞く → 片付け の手順、
// 同時に動く fleet の上限と起こし直しの条件、プライマリで動く・書き換えない・印を置くこと、進んでいない fleet の見つけ方が書かれ、
// 規則・CLAUDE.md・docs・overview.html・skill の README に hq があることを確かめる。語句は要点ごとにまとめて確かめる。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';

const root = join(import.meta.dirname, '..', '..');
const HQ_SKILL = '.claude/skills/hq/SKILL.md';
const HEADINGS = ['## 入力', '## 手順', '## 終わりの状態', '## 人に返す条件'];

const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const skill = (): string => {
  assert.ok(existsSync(join(root, HQ_SKILL)), `${HQ_SKILL} がありません`);
  return read(HQ_SKILL);
};

/** 先頭の `---` で囲まれた frontmatter を key: value で読む（skills.test.ts と同じ） */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split(/\r?\n/).map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** 語句がすべて text の中にあることを確かめる */
function assertWords(text: string, words: string[], what: string): void {
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

// ---- 形（skills.test.ts の SKILLS に hq は入らないので、同じ検査をここで行う） ----

test('hq の skill：frontmatter の name が hq で、description がある', () => {
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'hq');
  assert.ok(fm.description, 'description がありません');
});

test('hq の skill：入力・手順・終わりの状態・人に返す条件の見出しがある', () => {
  const lines = skill().split(/\r?\n/);
  for (const h of HEADINGS) assert.ok(lines.includes(h), `「${h}」がありません`);
});

// ---- AC1：テーマの案 → 人の承認 → fleet の起動 → 人の判断をまとめて聞く → 片付け ----

test('hq の skill：テーマの案を作り、人の承認をもらう（AskUserQuestion）', () => {
  assertWords(skill(), ['テーマの案', '人の承認', 'AskUserQuestion'], 'hq の skill ');
});

test('hq の skill：fleet を worker-start と new-top-level で起こし、セッション ID の控え hq-fleets.json を持つ', () => {
  assertWords(skill(), ['worker-start', 'new-top-level', 'hq-fleets.json'], 'hq の skill ');
});

test('hq の skill：fleet の question をまとめて聞き、reply で人の答えだけを返し、答えが無ければ「答え無し」', () => {
  assertWords(skill(), ['question', 'reply', '答え無し'], 'hq の skill ');
});

test('hq の skill：片付けは Epic が Close したときだけ', () => {
  assertWords(skill(), ['Epic が Close'], 'hq の skill ');
});

/** 見出しの行から、同じか上の階層の次の見出しの前までを切り出す */
function section(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start < 0) return '';
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

test('hq の skill：「## 手順」の中の順番が テーマの案 < worker-start < reply < 片付け（Epic が Close）', () => {
  const text = section(skill(), '## 手順');
  assert.ok(text !== '', '「## 手順」の節がありません');
  const at = (w: string): number => text.indexOf(w);
  const order = ['テーマの案', 'worker-start', 'reply', 'Epic が Close'];
  for (const w of order) assert.ok(at(w) >= 0, `「${w}」がありません`);
  for (let i = 1; i < order.length; i++) {
    assert.ok(at(order[i - 1]!) < at(order[i]!), `「${order[i - 1]}」が「${order[i]}」より前に出てきません`);
  }
});

// ---- AC2：同時に動く fleet の上限と、起こし直しの条件 ----

test('hq の skill：同時に動く fleet を hq.maxFleets までにする', () => {
  assertWords(skill(), ['hq.maxFleets'], 'hq の skill ');
});

test('hq の skill：起こし直しは exited のときだけ（unverifiable は止まった証拠にしない）・1時間に2回まで・超えたら人に知らせる', () => {
  assertWords(skill(), ['exited', 'unverifiable', '1時間に2回', '人に知らせる'], 'hq の skill ');
});

test('hq の skill：起こし直しの回数を Epic の記録のコメント（目印 agent-harness:hq-restart）で数える', () => {
  assertWords(skill(), ['agent-harness:hq-restart'], 'hq の skill ');
});

test('hq の skill：前の fleet の着手宣言を引き継ぐときは --takeover で出し直す', () => {
  assertWords(skill(), ['--takeover'], 'hq の skill ');
});

// ---- AC4：プライマリで動く・書き換えない・印 ----

test('hq の skill：本体（プライマリ）で動くことを isMainWorktree で確かめる', () => {
  assertWords(skill(), ['isMainWorktree'], 'hq の skill ');
});

test('hq の skill：hq はファイルを書き換えず、fleet のワークスペースに印 .agent-harness-workspace を置く', () => {
  assertWords(skill(), ['書き換えない', '.agent-harness-workspace'], 'hq の skill ');
});

test('.gitignore に .agent-harness-workspace がある', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes('.agent-harness-workspace'), '.gitignore に .agent-harness-workspace の行がありません');
});

// ---- 進んでいない fleet（人の決定） ----

test('hq の skill：進んでいない fleet を panes.ts fleets --session で読む', () => {
  assertWords(skill(), ['panes.ts fleets --session'], 'hq の skill ');
});

test('hq の skill：node harness/scripts/panes.ts fleets の実行は必ず --session 付きで書く（古いスナップショットを数えない）', () => {
  const uses = [...skill().matchAll(/node harness\/scripts\/panes\.ts fleets([^\n]{0,12})/g)].map((m) => m[1]!);
  assert.ok(uses.length > 0, 'node harness/scripts/panes.ts fleets がありません');
  const bare = uses.filter((rest) => !rest.startsWith(' --session'));
  assert.deepEqual(bare, [], '--session の無い node harness/scripts/panes.ts fleets があります');
});

// ---- Orca が無い環境 ----

test('hq の skill：Orca が無い環境では hq を使わず fleet・ship を使う', () => {
  assertWords(skill(), ['Orca が無い'], 'hq の skill ');
});

// ---- 使うコマンドが実在する ----

test('hq の skill：使う agent.ts のコマンドは使い方のコメントに実在し、完全な形で書かれている', () => {
  const known = documentedAgentCommands();
  assert.ok(known.has('fleet-status') && known.has('usage'), '使い方のコメントからコマンドを読めていません');
  const text = skill();
  const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  assert.ok(used.length > 0, 'agent.ts のコマンドがありません');
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
  assert.equal(text.split('agent.ts ').length - 1, used.length, 'agent.ts のコマンドは完全な形（node harness/scripts/agent.ts <コマンド>）で書く');
});

test('hq の skill：使う panes.ts のサブコマンドは panes.ts の先頭のコメントに実在する（fleets を含む）', () => {
  const header = read('harness/scripts/panes.ts').match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? '';
  const known = new Set([...header.matchAll(/^\s*\*\s+node harness\/scripts\/panes\.ts ([a-z|]+)/gm)].flatMap((m) => m[1]!.split('|')));
  assert.ok(known.has('fleets'), 'panes.ts の先頭のコメントに fleets がありません');
  const used = [...skill().matchAll(/panes\.ts ([a-z]+)/g)].map((m) => m[1]!);
  assert.ok(used.length > 0, 'panes.ts のサブコマンドがありません');
  for (const cmd of used) assert.ok(known.has(cmd), `panes.ts ${cmd} は panes.ts の先頭のコメントにありません`);
});

// ---- AC3：規則・CLAUDE.md・docs・overview.html・skill の README に hq がある ----

test('harness/CLAUDE.harness.md の skill の表に hq の行がある', () => {
  const text = read('harness/CLAUDE.harness.md');
  assert.ok(text.includes('[hq](../.claude/skills/hq/SKILL.md)'), 'skill の表に hq の行がありません');
});

test('CLAUDE.md の構成の表の .claude/skills/ の行に hq がある', () => {
  const line = read('CLAUDE.md').split(/\r?\n/).find((l) => l.startsWith('| `.claude/skills/`'));
  assert.ok(line, '.claude/skills/ の行がありません');
  assert.match(line, /\bhq\b/, '.claude/skills/ の行に hq がありません');
});

test('.claude/skills/README.md の表に hq/ の行がある', () => {
  assert.ok(read('.claude/skills/README.md').includes('| `hq/` |'), 'skill の README の表に hq/ の行がありません');
});

test('overview.html の skills/ の一覧に hq がある', () => {
  const line = read('overview.html').split(/\r?\n/).find((l) => l.includes('<code>skills/</code>'));
  assert.ok(line, 'overview.html に skills/ の行がありません');
  const list = line.match(/（([^）]*)）/)?.[1] ?? '';
  assert.ok(list.split('・').map((s) => s.trim()).includes('hq'), `skills/ の一覧（${list}）に hq がありません`);
});

test('docs/operations.md に hq の説明がある', () => {
  assertWords(read('docs/operations.md'), ['hq', 'isMainWorktree', '答え無し', 'exited'], 'docs/operations.md ');
});

test('docs/operations.md に hq・fleet・panes の設定と既定値がある', () => {
  const lines = read('docs/operations.md').split(/\r?\n/);
  const defaults: [string, string][] = [
    ['hq.staleSnapshotMinutes', '30'],
    ['hq.stuckMinutes', '120'],
    ['hq.maxFleets', '2'],
    ['fleet.shipMode', 'subagent'],
    ['panes.collectIntervalSeconds', '180'],
  ];
  for (const [key, def] of defaults) {
    const hits = lines.filter((l) => l.includes(key));
    assert.ok(hits.length > 0, `docs/operations.md に ${key} がありません`);
    assert.ok(hits.some((l) => l.includes(def)), `docs/operations.md の ${key} の行に既定値 ${def} がありません`);
  }
});
