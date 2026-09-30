// ワークフローの起動条件（gate.yml の issue_comment の対象、ci.yml の on と concurrency）のテスト
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (name: string): string[] => readFileSync(join(root, '.github', 'workflows', name), 'utf8').split(/\r?\n/);

const indentOf = (l: string): number => l.match(/^\s*/)![0].length;
const isBlankOrComment = (l: string): boolean => l.trim() === '' || l.trim().startsWith('#');

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

/** jobs.gate.if（`if: >-` の続きの行） */
function gateIfLines(): string[] {
  const lines = read('gate.yml');
  const start = lines.findIndex((l) => /^\s+if: >-\s*$/.test(l));
  assert.ok(start >= 0, 'gate.yml に `if: >-` がありません');
  const indent = indentOf(lines[start]!);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && indentOf(l) <= indent) break;
    out.push(l);
  }
  return out;
}

/** if の issue_comment の項（`(github.event_name != 'issue_comment'` で始まり、括弧が閉じるまで） */
function issueCommentClause(): string {
  const lines = gateIfLines();
  const at = lines.findIndex((l) => l.trim().startsWith("(github.event_name != 'issue_comment'"));
  assert.ok(at >= 0, "if に `(github.event_name != 'issue_comment'` の項がありません");
  const out: string[] = [];
  let depth = 0;
  for (const l of lines.slice(at)) {
    out.push(l.trim());
    depth += parenDelta(l);
    if (depth <= 0) break;
  }
  assert.equal(depth, 0, 'issue_comment の項の括弧が閉じていません');
  return out.join(' ');
}

/** トップレベルのキーの下のブロック（コメント・空行を除く） */
function topBlock(lines: string[], key: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  assert.ok(start >= 0, `トップレベルに ${key}: がありません`);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (isBlankOrComment(l)) continue;
    if (indentOf(l) === 0) break;
    out.push(l);
  }
  return out;
}

test('gate.yml：issue_comment の項に agent-plan・agent-verdict・agent-decision の contains があり、agent-claim は無い', () => {
  const clause = issueCommentClause();
  for (const kind of ['agent-plan', 'agent-verdict', 'agent-decision']) {
    assert.ok(clause.includes(`contains(github.event.comment.body, '\`\`\`${kind}')`), `${kind} の contains がありません: ${clause}`);
  }
  assert.ok(!clause.includes('agent-claim'), `agent-claim が残っています: ${clause}`);
});

test('ci.yml：on の直下のキーは pull_request だけ（main への push では起動しない）', () => {
  const block = topBlock(read('ci.yml'), 'on');
  assert.ok(block.length > 0, 'on: の下が空です');
  const childIndent = Math.min(...block.map(indentOf));
  const keys = block.filter((l) => indentOf(l) === childIndent).map((l) => l.trim().replace(/:.*$/, ''));
  assert.deepEqual(keys, ['pull_request']);
});

test('ci.yml：concurrency は PR 番号のグループで、古い実行を取り消す', () => {
  const block = topBlock(read('ci.yml'), 'concurrency');
  const group = block.find((l) => /^\s+group:/.test(l));
  assert.ok(group, 'concurrency に group がありません');
  assert.ok(group.includes('github.event.pull_request.number'), `group に PR 番号がありません: ${group.trim()}`);
  const cancel = block.find((l) => /^\s+cancel-in-progress:/.test(l));
  assert.ok(cancel, 'concurrency に cancel-in-progress がありません');
  assert.equal(cancel.trim().replace(/\s+#.*$/, ''), 'cancel-in-progress: true');
});

test('ci.yml：コメント行を除いて github.event_name を使わない（pull_request だけで起動するので分岐が要らない）', () => {
  const found = read('ci.yml').filter((l) => !isBlankOrComment(l) && l.includes('github.event_name'));
  assert.deepEqual(found, []);
});
