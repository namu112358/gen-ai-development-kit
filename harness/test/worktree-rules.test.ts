// Issue #196：ハーネスの規則（harness/CLAUDE.harness.md）の worktree の優先順位の行（agent.ts worktree で作り、Orca は起動と監視。
// Orca が無い・動かないときは入口の skill より優先して今の手順）と、docs/operations.md の置き場所の段落を語句で確かめる（全文の固定一致にはしない）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');

const EXISTING = '- 作業は常に worktree で行う（`node harness/scripts/agent.ts worktree <ブランチ>`。置き場所はリポジトリの外）。作業ツリーを複数の作業で共有しない。';

test('規則：既存の「作業は常に worktree で行う」の行はそのままで、その直後に Orca との優先順位の行が1行ある', () => {
  const lines = read('harness/CLAUDE.harness.md').split('\n');
  const i = lines.indexOf(EXISTING);
  assert.ok(i >= 0, '既存の行が1文字も変わらずにある');
  const next = lines[i + 1] ?? '';
  assert.ok(next.startsWith('- '), `直後が箇条書きの1行: ${next}`);
  for (const phrase of [
    '`node harness/scripts/agent.ts worktree',
    '起動と監視',
    'orca-cli',
    'orchestration',
    '`claude/`',
    '#番号 短い名前',
    '親子は付けない',
    'Orca が無い・動かない',
    '`ORCA open`',
    '起動しない',
  ]) {
    assert.ok(next.includes(phrase), `「${phrase}」を含む: ${next}`);
  }
  assert.equal(lines.filter((l) => l.includes('起動と監視') && l.includes('orca-cli')).length, 1, '優先順位の行は1行だけ');
});

test('docs/operations.md：worktree の置き場所と Orca の表示名の段落がある', () => {
  const blocks = read('docs/operations.md').split(/\n\s*\n/);
  const block = blocks.find((b) => b.includes('AGENT_HARNESS_WORKTREE_ROOT'));
  assert.ok(block, 'AGENT_HARNESS_WORKTREE_ROOT を書いた段落がある');
  for (const phrase of ['worktreeRoot', 'AGENT_HARNESS_WORKTREE_ROOT', '{repo}', '~/', 'agent.ts worktree', '#番号 短い名前', 'worktree-remove']) {
    assert.ok(block.includes(phrase), `「${phrase}」を含む`);
  }
  assert.match(block, /リポジトリの中[^。]*拒む/, 'リポジトリの中になる値は拒む');
});

test('harness.config.json と雛形には worktreeRoot を足さない', () => {
  for (const file of ['harness.config.json', 'harness/templates/harness.config.json']) {
    assert.ok(!('worktreeRoot' in JSON.parse(read(file))), file);
  }
});
