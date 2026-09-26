import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlock, renderBlock } from '../lib/blocks.ts';
import { evaluatePlanGate, parsePlan, type Plan } from '../lib/plan.ts';

const base: Plan = { version: 1, issue: 7, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['src/lib/foo.ts', 'test/**'] };

test('停止基準に該当しない計画は通過する', () => {
  assert.deepEqual(evaluatePlanGate(base, 7), { pass: true, reasons: [] });
});

test('停止基準：人の判断・AC 変更・未解決の質問・high 以上・ファイル一覧欠落・番号違い', () => {
  const cases: [Partial<Plan>, string][] = [
    [{ needsHuman: true }, '人間の判断'],
    [{ acChangeProposed: true }, 'AC の変更'],
    [{ openQuestions: ['?'] }, '未解決の質問'],
    [{ risk: 'high' }, 'high'],
    [{ risk: 'critical' }, 'critical'],
    [{ files: [] }, 'files'],
    [{ files: ['**'] }, '広すぎ'],
    [{ files: ['s*/**'] }, '広すぎ'],
    [{ files: ['../x'] }, '..'],
    [{ issue: 8 }, '一致しません'],
  ];
  for (const [patch, needle] of cases) {
    const r = evaluatePlanGate({ ...base, ...patch }, 7);
    assert.equal(r.pass, false, needle);
    assert.ok(r.reasons.some((x) => x.includes(needle)), `${needle}: ${r.reasons.join('/')}`);
  }
});

test('計画ブロックの書式検査', () => {
  const body = `<!-- agent-harness:claude -->\n## 計画\n\n${renderBlock('agent-plan', base)}\n`;
  const block = extractBlock(body, 'agent-plan');
  assert.ok(block.found && block.ok);
  assert.ok(parsePlan(block.value).ok);
  const noFiles = parsePlan({ ...base, files: undefined });
  assert.ok(noFiles.ok && noFiles.value.files.length === 0, 'files 欠落はゲートで止めるためパースは通す');
  const bad = parsePlan({ ...base, risk: 'mid', needsHuman: 'no' });
  assert.ok(!bad.ok && bad.errors.length === 2);
  const dup = extractBlock(`${body}\n${renderBlock('agent-plan', base)}`, 'agent-plan');
  assert.ok(dup.found && !dup.ok, '同じ種類のブロックが2つあれば曖昧として拒否');
  const broken = extractBlock('```agent-plan\n{oops\n```', 'agent-plan');
  assert.ok(broken.found && !broken.ok);
  assert.equal(extractBlock('no block', 'agent-plan').found, false);
});

test('MCP でエスケープされた目印も Claude のコメントとして扱う', async () => {
  const { hasClaudeMark } = await import('../lib/blocks.ts');
  assert.equal(hasClaudeMark('&lt;!-- agent-harness:claude --&gt;\n## 計画'), true);
  assert.equal(hasClaudeMark('<!-- agent-harness:claude -->'), true);
  assert.equal(hasClaudeMark('人のコメント'), false);
});
