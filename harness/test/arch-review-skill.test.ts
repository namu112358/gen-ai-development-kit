import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_OVERWRITE_RULE, WRITE_RULES } from './support/output-file-rules.ts';
import { documentedAgentCommands } from './support/agent-source.ts';
import { namesInTable, uncoveredTests } from '../scripts/readme.ts';

// Issue #184：arch-review の skill と arch-reviewer の定義、一覧への掲載

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

const SKILL = '.claude/skills/arch-review/SKILL.md';
const AGENT = '.claude/agents/arch-reviewer.md';
const HEADINGS = ['## 入力', '## 観点', '## 手順', '## 出力', '## 終わりの状態', '## 人に返す条件'];
const FORBIDDEN_LABELS = ['agent:ready', 'agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped', 'agent:delegate-merge'];

/** 先頭の `---` で囲まれた frontmatter を key: value で読む */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

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

/** 句点と改行で文に分ける */
const sentences = (text: string): string[] => text.split(/[。\n]/).map((s) => s.trim()).filter((s) => s !== '');

/** agent.ts とサブコマンド（harness/scripts/agent/commands/）の使い方のコメントに書かれたコマンド名 */
function documentedCommands(): Set<string> {
  return documentedAgentCommands();
}

/** 「やってはいけないこと」の見出しの節、または「やってはいけないこと」を含む行（見出しでなければその行と続く箇条書き） */
function forbiddenPart(text: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes('やってはいけないこと'));
  if (i < 0) return '';
  const heading = lines[i]!.match(/^(#+) /);
  if (heading) return section(text, lines[i]!);
  const out = [lines[i]!];
  for (const l of lines.slice(i + 1)) {
    if (!/^\s+[-*]|^\s*[-*]\s/.test(l) || l.trim() === '') break;
    out.push(l);
  }
  return out.join('\n');
}

// ---- SKILL.md（AC1） ----

test('arch-review の SKILL.md があり、frontmatter の name がディレクトリ名と同じで、description に頼まれ方がある', () => {
  assert.ok(existsSync(join(root, SKILL)), `${SKILL} がありません`);
  const fm = frontmatter(read(SKILL));
  assert.equal(fm.name, 'arch-review');
  assert.ok(fm.description, 'description がありません');
  for (const phrase of ['設計を見直して', '最近の変更をまとめて見て']) assert.ok(fm.description!.includes(phrase), `description に「${phrase}」がありません`);
});

test('arch-review に入力・観点・手順・出力・終わりの状態・人に返す条件の見出しがある', () => {
  const lines = read(SKILL).split('\n');
  for (const h of HEADINGS) assert.ok(lines.includes(h), `「${h}」がありません`);
});

test('arch-review の入力：既定は前回の arch-review 以降、前回が無ければ直近 10 本で、--since・--until・--last で変えられる', () => {
  const input = section(read(SKILL), '## 入力');
  for (const word of ['前回', '10', '--since', '--until', '--last']) assert.ok(input.includes(word), `「## 入力」に「${word}」がありません`);
});

test('arch-review の観点：4つの観点（重複・置き場所・docs との食い違い・コードの書き方）がある', () => {
  const view = section(read(SKILL), '## 観点');
  for (const word of ['重複', 'harness/lib/', 'docs', 'コードの書き方']) assert.ok(view.includes(word), `「## 観点」に「${word}」がありません`);
});

test('arch-review が使う agent.ts のコマンドは使い方のコメントに実在し、範囲・下書き・記録の3つを使う', () => {
  const known = documentedCommands();
  assert.ok(known.has('worktree') && known.has('claim'), '使い方のコメントからコマンドを読めていません');
  const text = read(SKILL);
  const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  for (const cmd of ['arch-review-range', 'arch-review-drafts', 'arch-review-record']) {
    assert.ok(known.has(cmd), `agent.ts の使い方のコメントに ${cmd} がありません`);
    assert.ok(used.includes(cmd), `skill が ${cmd} を使っていません`);
  }
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
  assert.equal(text.split('agent.ts ').length - 1, used.length, 'agent.ts のコマンドは完全な形で書く');
});

test('arch-review は見る main を worktree（--detach）で SHA に固定し、終わりに消す', () => {
  const text = read(SKILL);
  assert.ok(/node harness\/scripts\/agent\.ts worktree \S+ --detach/.test(text), 'worktree <SHA> --detach がありません');
  assert.ok(text.includes('node harness/scripts/agent.ts worktree-remove'), 'worktree-remove がありません');
});

test('arch-review は観点ごとに arch-reviewer を呼び、PR の説明・判定コメントを渡さない', () => {
  const text = read(SKILL);
  assert.ok(text.includes('arch-reviewer'), 'arch-reviewer への言及がありません');
  const ss = sentences(text);
  assert.ok(ss.some((s) => s.includes('PR の説明') && s.includes('渡さない')), 'PR の説明を渡さない文がありません');
  assert.ok(ss.some((s) => s.includes('判定コメント') && s.includes('渡さない')), '判定コメントを渡さない文がありません');
});

// ---- Issue の作成（AC3） ----

test('arch-review：Issue を作るのは人が選んだものだけで、AskUserQuestion で聞く', () => {
  const text = read(SKILL);
  assert.ok(text.includes('人が選んだもの'), '「人が選んだもの」がありません');
  assert.ok(text.includes('AskUserQuestion'), 'AskUserQuestion で聞く手順がありません');
  const create = sentences(text).filter((s) => s.includes('gh issue create'));
  assert.ok(create.length > 0, 'gh issue create の手順がありません');
  assert.ok(create.some((s) => s.includes('人が選んだ')), `gh issue create の文に「人が選んだ」がありません：${create.join(' / ')}`);
});

test('arch-review：gh issue create の行に --label が無く、agent:ready を付けないと書かれている', () => {
  const text = read(SKILL);
  const lines = text.split('\n').filter((l) => l.includes('gh issue create'));
  assert.ok(lines.length > 0, 'gh issue create の行がありません');
  for (const l of lines) assert.ok(!/--label\b|\s-l\s/.test(l), `gh issue create の行にラベルの指定があります：${l}`);
  assert.ok(sentences(text).some((s) => s.includes('agent:ready') && s.includes('付けない')), 'agent:ready を付けない文がありません');
});

test('arch-review：開いた Issue に同じものがあれば新しく立てずコメントの案にする', () => {
  const ss = sentences(read(SKILL));
  assert.ok(ss.some((s) => s.includes('同じもの') && s.includes('コメント')), '同じものがあればコメントの案にする文がありません');
});

test('arch-review の「やってはいけないこと」：その場で直す・PR や判定コメントへの投稿・判定の担当に渡す・ラベルの付け外し・本文の書き換え・Merge', () => {
  const part = forbiddenPart(read(SKILL));
  assert.ok(part !== '', '「やってはいけないこと」がありません');
  for (const label of FORBIDDEN_LABELS) assert.ok(part.includes(label), `「やってはいけないこと」に ${label} がありません`);
  for (const word of ['直す', '判定コメント', 'reviewer', 'risk-agent', 'review-panel', '本文', 'Merge', '*:exempt']) {
    assert.ok(part.includes(word), `「やってはいけないこと」に「${word}」がありません`);
  }
});

test('arch-review は PR へのコメント・レビューを投稿する手順を持たない', () => {
  const text = read(SKILL);
  for (const cmd of ['gh pr comment', 'gh pr review', 'gh pr merge', 'gh issue edit', 'post-verdict']) assert.ok(!text.includes(cmd), `「${cmd}」があります`);
});

// ---- arch-reviewer の定義（AC1） ----

test('arch-reviewer の定義：frontmatter の name・description・tools（Read, Grep, Glob, Bash, Write）', () => {
  assert.ok(existsSync(join(root, AGENT)), `${AGENT} がありません`);
  const fm = frontmatter(read(AGENT));
  assert.equal(fm.name, 'arch-reviewer');
  assert.ok(fm.description, 'description がありません');
  assert.equal(fm.tools, 'Read, Grep, Glob, Bash, Write');
  assert.ok(!/WebFetch|WebSearch|mcp/i.test(fm.tools ?? ''), '外に出るツールがあります');
});

test('arch-reviewer の定義：判定の担当と同じ言い回しで、渡された出力のパスに Write で書き、既にあれば上書きしない', () => {
  const text = read(AGENT);
  for (const rule of WRITE_RULES) assert.ok(text.includes(rule), `「${rule}」がありません`);
  assert.ok(text.includes(NO_OVERWRITE_RULE), '既にあるファイルを上書きしない文がありません');
});

test('arch-reviewer の定義：PR の説明・判定コメントを根拠にせず、GitHub を読まない', () => {
  const ss = sentences(read(AGENT));
  assert.ok(ss.some((s) => s.includes('PR の説明') && s.includes('根拠にしない')), 'PR の説明を根拠にしない文がありません');
  assert.ok(ss.some((s) => s.includes('判定コメント') && s.includes('根拠にしない')), '判定コメントを根拠にしない文がありません');
  assert.ok(ss.some((s) => s.includes('GitHub') && s.includes('読まない')), 'GitHub を読まない文がありません');
});

test('arch-reviewer の定義：渡された SHA の main のコードとマージコミットの diff（git show）から判断する', () => {
  const text = read(AGENT);
  assert.ok(text.includes('git show'), 'git show がありません');
  assert.ok(text.includes('SHA'), '見る SHA への言及がありません');
});

test('arch-reviewer の定義：観点①〜④がある', () => {
  const text = read(AGENT);
  for (const n of ['①', '②', '③', '④']) assert.ok(text.includes(n), `観点${n}がありません`);
  for (const word of ['重複', 'harness/lib/', 'harness/gates/', 'harness/scripts/', 'operations.md', 'formats.md', 'glossary.md', 'コードの書き方']) {
    assert.ok(text.includes(word), `観点の「${word}」がありません`);
  }
});

test('arch-reviewer の定義：出力は観点・要約・根拠・なぜずれか・直し方の案を持つ JSON', () => {
  const out = section(read(AGENT), '## 出力');
  assert.ok(out !== '', '「## 出力」がありません');
  for (const word of ['観点', '要約', '根拠', '直し方']) assert.ok(out.includes(word), `「## 出力」に「${word}」がありません`);
  assert.ok(out.includes('```json'), '「## 出力」に JSON の例がありません');
});

// ---- 一覧への掲載（AC4） ----

test('CLAUDE.md の構成の表の .claude/skills/ の行に arch-review、.claude/agents/ の行に arch-reviewer がある', () => {
  const lines = read('CLAUDE.md').split('\n');
  const skills = lines.find((l) => l.startsWith('| `.claude/skills/` |'));
  const agents = lines.find((l) => l.startsWith('| `.claude/agents/` |'));
  assert.ok(skills?.includes('arch-review'), `skills の行に arch-review がありません：${skills}`);
  assert.ok(agents?.includes('arch-reviewer'), `agents の行に arch-reviewer がありません：${agents}`);
});

test('harness/CLAUDE.harness.md の skill の表に arch-review がある', () => {
  const row = read('harness/CLAUDE.harness.md').split('\n').find((l) => l.startsWith('| [arch-review](../.claude/skills/arch-review/SKILL.md) |'));
  assert.ok(row, 'skill の表に arch-review の行がありません');
});

test('.claude/skills/README.md と .claude/agents/README.md の表に載っている', () => {
  assert.ok(read('.claude/skills/README.md').split('\n').some((l) => l.startsWith('| `arch-review/` |')), '.claude/skills/README.md に arch-review/ の行がありません');
  assert.ok(read('.claude/agents/README.md').split('\n').some((l) => l.startsWith('| `arch-reviewer.md` |')), '.claude/agents/README.md に arch-reviewer.md の行がありません');
});

// #389：harness/test/README.md はファイル名を並べずパターンで書くので、表のパターンに当たることで「載っている」を確かめる
test('harness/test/README.md に arch-review のテストが載っている', () => {
  const patterns = namesInTable(read('harness/test/README.md'));
  assert.deepEqual(uncoveredTests(patterns, ['arch-review-skill.test.ts', 'arch-review.test.ts']), []);
});
