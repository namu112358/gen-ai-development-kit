// fleet の入れ子の ship が段階の終わりに返す引き継ぎ（agent-handoff）のテスト（Issue #447）。
// 書式の検査（parseHandoff）、`agent.ts check` が agent-handoff ブロックを読むこと、
// ship の「サブエージェントの ship として動くとき」と fleet の「入れ子の方式（orca）」の文（語句は少なく）を確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HANDOFF_STAGES, HANDOFF_STATUSES, parseHandoff } from '../lib/handoff.ts';
import { ROOT, skillProblems } from './support/skill-text.ts';

const valid = (): Record<string, unknown> => ({
  version: 1,
  issue: 447,
  stage: 'implement',
  status: 'continue',
  next: 'judge',
  pr: 512,
  branch: 'claude/issue-447-stage-ship',
  done: 'Draft PR を出した。npm run check は通った',
  notes: ['#139 と ship の SKILL.md が重なる'],
});

test('HANDOFF_STAGES・HANDOFF_STATUSES：段階と終わりの状態の一覧', () => {
  assert.deepEqual([...HANDOFF_STAGES], ['plan', 'implement', 'judge', 'fix', 'sync', 'merged']);
  assert.deepEqual([...HANDOFF_STATUSES], ['continue', 'merge-wait', 'human-decision', 'wait', 'no-nesting', 'return-to-human', 'closed', 'not-closed']);
});

test('parseHandoff：正しい引き継ぎは通る', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['continue と next', valid()],
    ['continue 以外で next・pr・branch が null、notes が空', { ...valid(), stage: 'judge', status: 'merge-wait', next: null, pr: null, branch: null, notes: [] }],
    ['merged の段階で closed', { ...valid(), stage: 'merged', status: 'closed', next: null }],
    ['未知のキーは誤りにしない', { ...valid(), extra: 'x' }],
  ];
  for (const [name, value] of cases) {
    const r = parseHandoff(value);
    assert.equal(r.ok, true, `${name}: ${r.ok ? '' : r.errors.join(' / ')}`);
    if (r.ok) assert.equal(r.value.issue, 447, name);
  }
});

test('parseHandoff：誤りの引き継ぎは errors を返す', () => {
  const cases: Array<[string, unknown]> = [
    ['配列', []],
    ['null', null],
    ['version が 1 でない', { ...valid(), version: 2 }],
    ['continue で next が null', { ...valid(), next: null }],
    ['continue 以外で next がある', { ...valid(), status: 'wait', next: 'judge' }],
    ['continue の next が merged', { ...valid(), next: 'merged' }],
    ['continue の next が未知', { ...valid(), next: 'deploy' }],
    ['未知の stage', { ...valid(), stage: 'deploy' }],
    ['未知の status', { ...valid(), status: 'done' }],
    ['issue が 0', { ...valid(), issue: 0 }],
    ['issue が小数', { ...valid(), issue: 1.5 }],
    ['issue が文字列', { ...valid(), issue: '447' }],
    ['pr が正の整数でない', { ...valid(), pr: -1 }],
    ['branch が空', { ...valid(), branch: '' }],
    ['done が空', { ...valid(), done: '' }],
    ['done が無い', { ...valid(), done: undefined }],
    ['done が 2000 文字を超える', { ...valid(), done: 'あ'.repeat(2001) }],
    ['notes が配列でない', { ...valid(), notes: 'メモ' }],
    ['notes に文字列でない要素', { ...valid(), notes: [1] }],
    ['notes に空文字', { ...valid(), notes: [''] }],
    ['notes が 20 件を超える', { ...valid(), notes: Array.from({ length: 21 }, (_, i) => `n${i}`) }],
    ['notes の1件が 2000 文字を超える', { ...valid(), notes: ['あ'.repeat(2001)] }],
  ];
  for (const [name, value] of cases) {
    const r = parseHandoff(value);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.length > 0, name);
  }
});

test('parseHandoff：誤りは全部集めて返す', () => {
  const r = parseHandoff({ ...valid(), stage: 'deploy', status: 'done', done: '' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.length >= 3, r.errors.join(' / '));
});

/** agent-handoff ブロックのファイルを書いて `agent.ts check` を呼ぶ */
function check(value: unknown): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ship-handoff-'));
  try {
    const file = join(dir, 'handoff-447-implement.md');
    writeFileSync(file, `引き継ぎ\n\n\`\`\`agent-handoff\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
    const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'check', file], { cwd: ROOT, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('agent.ts check：agent-handoff ブロックを handoff として検査する', () => {
  const ok = check(valid());
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /OK \(handoff\)/);

  const bad = check({ ...valid(), next: null });
  assert.equal(bad.status, 2, bad.stdout);
  assert.match(bad.stderr, /書式エラー/);
});

test('ship の SKILL.md：サブエージェントの ship は1段階だけ進めて引き継ぎを確かめて返す', () => {
  assert.deepEqual(
    skillProblems({
      path: '.claude/skills/ship/SKILL.md',
      parts: [{ section: '## サブエージェントの ship として動くとき', words: ['1段階', 'agent-handoff', 'agent.ts check', '推測'] }],
    }),
    [],
  );
});

test('fleet の SKILL.md：入れ子の方式は段階ごとに新しい ship を呼び、引き継ぎを渡す', () => {
  assert.deepEqual(
    skillProblems({
      path: '.claude/skills/fleet/SKILL.md',
      parts: [{ section: '## 入れ子の方式（orca）', words: ['段階ごと', '新しい', 'fleet-status', '引き継ぎ', 'merged'] }],
    }),
    [],
  );
});
