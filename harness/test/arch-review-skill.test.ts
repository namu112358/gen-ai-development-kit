// arch-review の skill（.claude/skills/arch-review/SKILL.md）の文を、support/skill-text.ts の構造の表で確かめる（Issue #184。#490 で個別の test() を表にまとめた）。
// 表（ARCH_REVIEW_SPEC）は1つの test() で、足りないものを全部一度に示す。frontmatter・使うコマンドの実在と書き方・
// arch-reviewer の定義（.claude/agents/）・一覧（CLAUDE.md・CLAUDE.harness.md・README）への掲載は、表にせず個別の test() に残す。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_OVERWRITE_RULE, WRITE_RULES } from './support/output-file-rules.ts';
import { documentedAgentCommands } from './support/agent-source.ts';
import { frontmatter, readText, ROOT, section, skillProblems, type SkillSpec } from './support/skill-text.ts';

const read = readText;

const SKILL = '.claude/skills/arch-review/SKILL.md';
const AGENT = '.claude/agents/arch-reviewer.md';

/** 句点と改行で文に分ける */
const sentences = (text: string): string[] => text.split(/[。\n]/).map((s) => s.trim()).filter((s) => s !== '');

/** arch-review の skill の構造の表 */
const ARCH_REVIEW_SPEC: SkillSpec = {
  path: SKILL,
  headings: ['## 入力', '## 観点', '## 手順', '## 出力', '## 終わりの状態', '## 人に返す条件'],
  words: ['arch-reviewer', '人が選んだもの', 'AskUserQuestion'],
  parts: [
    // 既定は前回の arch-review 以降、前回が無ければ直近 10 本で、--since・--until・--last で変えられる
    { section: '## 入力', words: ['前回', '10', '--since', '--until', '--last'] },
    // 4つの観点
    { section: '## 観点', words: ['重複', 'harness/lib/', 'docs', 'コードの書き方'] },
    // 見る main を worktree（--detach）で SHA に固定し、終わりに消す
    { section: '## 手順', step: 2, words: ['node harness/scripts/agent.ts worktree <headSha> --detach'] },
    // 観点ごとに arch-reviewer を呼び、PR の説明・判定コメントを渡さない
    { section: '## 手順', step: 3, words: ['arch-reviewer', 'PR の説明は渡さない', '判定コメント', 'も渡さない'] },
    // 開いた Issue に同じものがあれば新しく立てずコメントの案にする
    { section: '## 手順', step: 5, words: ['同じもの', 'コメントの案'] },
    // Issue を作るのは人が選んだものだけ。ラベルは付けない
    { section: '## 手順', step: 8, words: ['人が選んだものだけ', 'gh issue create', '`agent:ready` は付けない'] },
    { section: '## 手順', step: 11, words: ['node harness/scripts/agent.ts worktree-remove'] },
    // やってはいけないこと：その場で直す・PR や判定コメントへの投稿・判定の担当に渡す・ラベルの付け外し・本文の書き換え・Merge
    {
      section: '## 人に返す条件',
      words: [
        'agent:ready', 'agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped', 'agent:delegate-merge',
        '直す', '判定コメント', 'reviewer', 'risk-agent', 'review-panel', '本文', 'Merge', '*:exempt',
      ],
    },
    // PR へのコメント・レビューを投稿する手順を持たない。Issue にラベルを付ける指定もしない
    { absent: ['gh pr comment', 'gh pr review', 'gh pr merge', 'gh issue edit', 'post-verdict', '--label', ' -l '] },
  ],
};

// ---- SKILL.md ----

test('arch-review の skill の構造の表', () => {
  assert.deepEqual(skillProblems(ARCH_REVIEW_SPEC), []);
});

test('arch-review の SKILL.md があり、frontmatter の name がディレクトリ名と同じで、description に頼まれ方がある', () => {
  assert.ok(existsSync(join(ROOT, SKILL)), `${SKILL} がありません`);
  const fm = frontmatter(read(SKILL));
  assert.equal(fm.name, 'arch-review');
  assert.ok(fm.description, 'description がありません');
  for (const phrase of ['設計を見直して', '最近の変更をまとめて見て']) assert.ok(fm.description!.includes(phrase), `description に「${phrase}」がありません`);
});

test('arch-review が使う agent.ts のコマンドは使い方のコメントに実在し、範囲・下書き・記録の3つを使う', () => {
  const known = documentedAgentCommands();
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

// ---- arch-reviewer の定義 ----

test('arch-reviewer の定義：frontmatter の name・description・tools（Read, Grep, Glob, Bash, Write）', () => {
  assert.ok(existsSync(join(ROOT, AGENT)), `${AGENT} がありません`);
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

// ---- 一覧への掲載 ----

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

test('harness/test/README.md に arch-review のテストが載っている', () => {
  const text = read('harness/test/README.md');
  assert.ok(text.includes('arch-review-skill.test.ts'), 'arch-review-skill.test.ts がありません');
});
