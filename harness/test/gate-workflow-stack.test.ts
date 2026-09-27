import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const yml = readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8');

/** App 自身が Ready にしたときは起動しない項（トップレベルの && でつなぐ独立の項） */
const READY_CLAUSE = "(github.event_name != 'pull_request_target' || github.event.action != 'ready_for_review' || github.event.sender.login != format('{0}[bot]', vars.AGENT_APP_SLUG))";

/** jobs.gate.if（`if: >-` の続きの行）を行ごとに返す */
function ifLines(): string[] {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^\s+if: >-\s*$/.test(l));
  assert.ok(start >= 0, 'gate.yml に `if: >-` がありません');
  const indent = lines[start]!.match(/^\s*/)![0].length;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && l.match(/^\s*/)![0].length <= indent) break;
    out.push(l);
  }
  return out;
}

/** 引用符（'...'）の中を除いた括弧の深さの増減 */
function parenDelta(line: string): number {
  let depth = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
  }
  return depth;
}

test('gate.yml：pull_request_target の types に ready_for_review と stacked がある（既存の types も残る）', () => {
  const m = yml.match(/pull_request_target:\s*\n\s+types:\s*\[([^\]]*)\]/);
  assert.ok(m, 'pull_request_target の types が読めません');
  const types = m[1]!.split(',').map((s) => s.trim());
  for (const t of ['ready_for_review', 'stacked']) assert.ok(types.includes(t), `${t} がありません: ${types.join(', ')}`);
  for (const t of ['opened', 'reopened', 'synchronize', 'edited', 'labeled', 'unlabeled', 'auto_merge_enabled', 'auto_merge_disabled']) assert.ok(types.includes(t), `既存の ${t} が消えた`);
});

test('gate.yml：App 自身の ready_for_review では起動しない項が、トップレベルの && でつながる独立の項としてある', () => {
  const lines = ifLines();
  const at = lines.findIndex((l) => l.trim().replace(/\s*&&$/, '') === READY_CLAUSE);
  assert.ok(at > 0, `if に次の項の行がありません: ${READY_CLAUSE}`);
  assert.ok(lines[at - 1]!.trimEnd().endsWith('&&'), '直前の行が && で終わっていません');
  const depth = lines.slice(0, at).reduce((d, l) => d + parenDelta(l), 0);
  assert.equal(depth, 0, '項が括弧の中（pull_request_target の OR の並びなど）にあります');
  assert.equal(parenDelta(lines[at]!), 0, '項の括弧が閉じていません');
  const rest = lines.slice(at + 1).filter((l) => l.trim() !== '');
  if (rest.length > 0) assert.ok(lines[at]!.trimEnd().endsWith('&&'), '後ろに項が続くなら && でつなぐ');
});
