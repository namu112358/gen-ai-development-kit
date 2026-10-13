import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frontmatter, readText } from './support/skill-text.ts';

// 判定の担当が自分の出力を渡されたパスに書き、呼び出し元は写さない（Issue #175）。
// 残すのは、担当の定義の frontmatter（Claude Code が読む name・tools）と、review-panel.ts が読む担当の出力の決まったファイル名（コードが名前で指す）。
// 担当の定義・skill・routine.md・docs の文の語の有無は固定しない（#1007）

const PANEL_SKILL = '.claude/skills/review-panel/SKILL.md';

/** 判定の担当7つ */
const AGENTS = ['reviewer', 'risk-agent', 'review-intake', 'review-lens', 'review-ac-scope', 'review-safety', 'review-scorer', 'review-overbuild'];
const agentPath = (name: string): string => `.claude/agents/${name}.md`;

test('担当の定義：7つの tools はちょうど Read, Grep, Glob, Bash, Write で、外に出るツールが無い', () => {
  for (const name of AGENTS) {
    const fm = frontmatter(readText(agentPath(name)));
    assert.equal(fm.name, name, `${name}: name`);
    assert.equal(fm.tools, 'Read, Grep, Glob, Bash, Write', `${name}: tools`);
    assert.ok(!/WebFetch|WebSearch|mcp/i.test(fm.tools ?? ''), `${name}: 外に出るツールが無い`);
  }
});

test('呼び出し元：review-panel の skill は担当に review-panel.ts が読む決まった名前のパスを渡す', () => {
  const text = readText(PANEL_SKILL);
  for (const file of ['<dir>/intake.json', '<dir>/lens1.json', '<dir>/lens5.json', '<dir>/ac-scope.json', '<dir>/safety.json', '<dir>/score-<id>.json']) {
    assert.ok(text.includes(file), `${file} がありません`);
  }
});

test('呼び出し元：review-panel の skill は⑨の担当に review-panel.ts が読む <dir>/overbuild.json を出力のパスとして渡す（Issue #325）', () => {
  assert.ok(readText(PANEL_SKILL).includes('<dir>/overbuild.json'), '<dir>/overbuild.json がありません');
});
