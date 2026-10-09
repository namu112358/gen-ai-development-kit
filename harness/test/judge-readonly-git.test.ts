// 判定の担当が worktree のブランチや HEAD を動かさない（Issue #413）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** 読むだけの担当（判定の8つ＋plan-critic） */
const AGENTS = ['reviewer', 'risk-agent', 'review-intake', 'review-lens', 'review-ac-scope', 'review-safety', 'review-scorer', 'review-overbuild', 'plan-critic'];
const agentPath = (name: string): string => `.claude/agents/${name}.md`;

/** 担当を呼ぶ skill */
const CALLERS = ['.claude/skills/judge/SKILL.md', '.claude/skills/review-panel/SKILL.md', '.claude/skills/plan/SKILL.md'];

const NO_MOVE_RULE = 'ブランチ・HEAD・作業ツリーを動かす git の操作（';
const READ_OTHER_RULE = '別の版のファイルを読むときは `git show <rev>:<path>` か `git diff` を使う';
const MOVING_OPS = ['checkout', 'switch', 'reset', 'stash', 'restore', 'merge', 'rebase'];

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

test('担当の定義：9つに、ブランチ・HEAD を動かす操作をしない文と、別の版の読み方の文がある', () => {
  for (const name of AGENTS) {
    const text = read(agentPath(name));
    assert.ok(text.includes(NO_MOVE_RULE), `${name}: 「${NO_MOVE_RULE}」がありません`);
    assert.ok(text.includes(READ_OTHER_RULE), `${name}: 「${READ_OTHER_RULE}」がありません`);
    const line = text.split('\n').find((l) => l.includes(NO_MOVE_RULE)) ?? '';
    for (const op of MOVING_OPS) assert.ok(line.includes(`\`${op}\``), `${name}: 動かさない操作に ${op} がありません`);
  }
});

test('呼び出し元：3つとも、担当が返った後に HEAD とブランチを確かめ、ずれていたら戻さない', () => {
  for (const path of CALLERS) {
    const text = read(path);
    assert.ok(text.includes('git rev-parse HEAD'), `${path}: git rev-parse HEAD がありません`);
    assert.ok(text.includes('git branch --show-current'), `${path}: git branch --show-current がありません`);
    const check = text.split('\n').filter((l) => l.includes('git rev-parse HEAD') && l.includes('戻さず'));
    assert.ok(check.length > 0, `${path}: git rev-parse HEAD と「戻さず」を含む行がありません`);
  }
});

test('呼び出し元：3つとも「## 人に返す条件」に HEAD のずれがある', () => {
  for (const path of CALLERS) {
    const giveBack = section(read(path), '## 人に返す条件');
    assert.ok(giveBack !== '', `${path}: 「## 人に返す条件」がありません`);
    assert.ok(giveBack.includes('git rev-parse HEAD'), `${path}: 人に返す条件に git rev-parse HEAD がありません`);
  }
});
