// issue-creator の skill（.claude/skills/issue-creator/SKILL.md）の要点の語・frontmatter・使うコマンドの実在と、
// skill の一覧（CLAUDE.harness.md・skills の README・overview.html）への掲載を確かめる（Issue #787）。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';
import { frontmatter, readText, ROOT, skillProblems, type SkillSpec } from './support/skill-text.ts';

const SKILL = '.claude/skills/issue-creator/SKILL.md';
const skill = (): string => readText(SKILL);

/** issue-creator の skill の構造の表 */
const ISSUE_CREATOR_SPEC: SkillSpec = {
  path: SKILL,
  headings: ['## 入力', '## 下書き', '## 作成', '## してはいけないこと', '## 呼び出し方', '## 終わりの状態'],
  parts: [
    {
      section: '## 下書き',
      words: [
        // 二段の重複の検索（開いた・閉じた Issue を言い換えでも探し、候補を読んで照らす）
        'gh issue list', '--state closed', '言い換え', 'gh issue view', 'issue-overlap check',
        // 出どころの目印
        'agent-harness:issue-source', '"kind"',
      ],
    },
    { section: '## 作成', words: ['--author @me', 'gh issue create', '名指し', 'ラベルを付けない'] },
    { section: '## してはいけないこと', words: ['GitHub に書かない', '名指し', '計画に進まない', 'AskUserQuestion'] },
    { section: '## 呼び出し方', words: ['general-purpose', 'model: sonnet', 'Agent ツールが無い'] },
  ],
};

test('issue-creator の skill の構造の表', () => {
  assert.deepEqual(skillProblems(ISSUE_CREATOR_SPEC), []);
});

test('issue-creator の SKILL.md があり、frontmatter の name が issue-creator で description がある', () => {
  assert.ok(existsSync(join(ROOT, SKILL)), 'issue-creator/SKILL.md がありません');
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'issue-creator');
  assert.ok(fm.description, 'description がありません');
});

test('skill が使う agent.ts のコマンドは使い方のコメントに実在する', () => {
  const known = documentedAgentCommands();
  const used = [...skill().matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
});

test('issue-creator が skill の一覧（CLAUDE.harness.md の表・skills の README・overview.html の Claude の card）に載っている', () => {
  const harnessLines = readText('harness/CLAUDE.harness.md').split('\n');
  assert.ok(
    harnessLines.some((l) => l.startsWith('| [issue-creator](../.claude/skills/issue-creator/SKILL.md) |')),
    'harness/CLAUDE.harness.md に issue-creator の行がありません',
  );
  const readmeLines = readText('.claude/skills/README.md').split('\n');
  assert.ok(readmeLines.some((l) => l.startsWith('| `issue-creator/` |')), '.claude/skills/README.md に `issue-creator/` の行がありません');
  const html = readText('overview.html');
  const start = html.indexOf('<section class="card claude">');
  assert.ok(start >= 0, 'overview.html に <section class="card claude"> がありません');
  const end = html.indexOf('</section>', start);
  assert.ok(end > start, 'overview.html の <section class="card claude"> が閉じていません');
  assert.ok(html.slice(start, end).includes('issue-creator'), 'overview.html の Claude の card に issue-creator がありません');
});
