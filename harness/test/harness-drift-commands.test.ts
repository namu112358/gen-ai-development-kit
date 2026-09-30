// Issue #199：コマンドの配線をソースで確かめる（止める判断そのものは harness-drift.test.ts と harness-drift-step.test.ts）。
// claim.ts は postClaim に渡す before の最初（Assignee の確かめより前）で judgeBlock を呼ぶ。fleet-status.ts は表の後に driftLine を足し、
// step は decideStep に harnessStale を渡す。harness-drift のコマンドがあり、使い方のコメントに書かれている。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentSourceFiles, documentedAgentCommands } from './support/agent-source.ts';

const root = join(import.meta.dirname, '..', '..');
const CLAIM = 'harness/scripts/agent/commands/claim.ts';
const FLEET_STATUS = 'harness/scripts/agent/commands/fleet-status.ts';
const DRIFT = 'harness/scripts/agent/commands/harness-drift.ts';

function source(file: string): string {
  assert.ok(agentSourceFiles().includes(file), `${file} がありません`);
  return readFileSync(join(root, file), 'utf8');
}

/** open（例：`const before = async`）から始まる、波かっこの対応が取れるまでの本体 */
function block(text: string, open: string): string {
  const start = text.indexOf(open);
  assert.ok(start >= 0, `「${open}」がありません`);
  const brace = text.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  assert.fail(`「${open}」の本体が閉じていません`);
}

test('claim.ts：lib/harness-drift.ts の judgeBlock を import している', () => {
  assert.match(source(CLAIM), /import \{[^}]*\bjudgeBlock\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/harness-drift\.ts'/);
});

test('claim.ts：before（postClaim に渡す関数）の中で、Assignee の確かめより前に judgeBlock を呼ぶ', () => {
  const before = block(source(CLAIM), 'const before = async');
  const judge = before.indexOf('judgeBlock(');
  const assignee = before.indexOf('checkAssignee(');
  assert.ok(judge >= 0, 'before の中で judgeBlock を呼んでいない');
  assert.ok(assignee >= 0, 'before の中に checkAssignee が無い');
  assert.ok(judge < assignee, 'judgeBlock が checkAssignee より後にある');
  // --force・--takeover・manual の分岐より前（どの宣言でも judge は止める）
  const firstIf = before.search(/\bif \((manual|!manual|force|takeover)/);
  assert.ok(firstIf < 0 || judge < firstIf, 'judgeBlock が manual・force の分岐の後にある');
});

test('claim.ts：使い方のコメントに、読み込みが古いと --stage judge は止まることが書かれている', () => {
  const usage = (source(CLAIM).match(/\/\*\*[\s\S]*?\*\//g) ?? []).filter((c) => c.includes('node harness/scripts/agent.ts claim')).join('\n');
  assert.ok(usage.includes('judge') && usage.includes('読み込み'), '使い方のコメントに judge と読み込みの記述がありません');
});

test('fleet-status.ts：表（renderFleetStatus）の後に driftLine を足す。--json の出力には足さない', () => {
  const text = block(source(FLEET_STATUS), 'async function fleetStatusText');
  assert.ok(text.includes('driftLine('), 'fleetStatusText で driftLine を呼んでいない');
  const jsonLine = text.split('\n').find((l) => l.includes('fleetStatusData('));
  assert.ok(jsonLine, 'fleetStatusData の行がありません');
  assert.ok(!jsonLine.includes('driftLine'), '--json の出力に driftLine を混ぜている');
});

test('fleet-status.ts：step は decideStep の入力に harnessStale を渡し、judgeBlock で作る', () => {
  const src = source(FLEET_STATUS);
  const call = block(src, 'decideStep({');
  assert.match(call, /\bharnessStale\b/, 'decideStep に harnessStale を渡していない');
  assert.ok(src.includes('judgeBlock('), 'judgeBlock で文を作っていない');
});

test('harness-drift のコマンドがあり、使い方のコメントに書かれている', () => {
  const src = source(DRIFT);
  assert.match(src, /name: 'harness-drift'/);
  assert.ok(documentedAgentCommands().has('harness-drift'), '使い方のコメントに node harness/scripts/agent.ts harness-drift がありません');
  for (const key of ['judged', 'stale', 'changed', 'added', 'removed', 'base', 'mergeBase', 'recordedAt', 'note']) {
    assert.ok(src.includes(key), `出力の ${key} がソースにありません`);
  }
});

test('cli.ts：harnessDrift() が origin の版と merge-base の版を読んで compareHarness に渡す', () => {
  const cli = source('harness/scripts/agent/cli.ts');
  assert.match(cli, /export (async )?function harnessDrift\(/);
  for (const w of ['compareHarness(', 'harnessVersionsAt(', 'merge-base', 'fetch', 'readLoadedRecord(']) assert.ok(cli.includes(w), `cli.ts に ${w} がありません`);
});
