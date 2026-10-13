// gate.yml の push のきっかけ（Issue #867）：全ブランチの push で評価し、ジョブ gate の if で既定ブランチ以外を skipped にする。checkout・environment・concurrency は既定ブランチの実行を守る形のまま
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const lines = readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8').split(/\r?\n/);

const indentOf = (l: string): number => l.match(/^\s*/)![0].length;
const isBlankOrComment = (l: string): boolean => l.trim() === '' || l.trim().startsWith('#');

/**
 * 既定ブランチ以外への push を skipped にする項（トップレベルの && でつなぐ独立の項）。
 * ref を refs/heads/ を前置きした既定ブランチと比べるので、タグ（refs/tags/*）の push も一致せず skipped になる
 */
const PUSH_CLAUSE = "(github.event_name != 'push' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch))";

/** 行 at の下で、それより深く字下げされたブロック（空行・コメント行を除く） */
function blockBelow(at: number): string[] {
  const indent = indentOf(lines[at]!);
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (isBlankOrComment(l)) continue;
    if (indentOf(l) <= indent) break;
    out.push(l);
  }
  return out;
}

/** jobs の直下のジョブの行番号 */
function jobLine(name: string): number {
  const jobs = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  assert.ok(jobs >= 0, 'jobs: がありません');
  const at = lines.findIndex((l, i) => i > jobs && new RegExp(`^  ${name}:\\s*(#.*)?$`).test(l));
  assert.ok(at >= 0, `ジョブ ${name} がありません`);
  return at;
}

/** ジョブの直下のキーの行（無ければ undefined） */
function jobKeyLine(name: string, key: string): string | undefined {
  const body = blockBelow(jobLine(name));
  const childIndent = Math.min(...body.map(indentOf));
  return body.find((l) => indentOf(l) === childIndent && new RegExp(`^\\s*${key}:`).test(l));
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

/** jobs.gate.if（`if: >-` の続きの行） */
function gateIfLines(): string[] {
  const start = lines.findIndex((l, i) => i > jobLine('gate') && /^\s+if: >-\s*$/.test(l));
  assert.ok(start >= 0, 'ジョブ gate に `if: >-` がありません');
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && indentOf(l) <= indentOf(lines[start]!)) break;
    out.push(l);
  }
  return out;
}

test('gate.yml：on.push に branches が無い（どのブランチへの push でもワークフローが評価される）', () => {
  const on = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  assert.ok(on >= 0, 'on: がありません');
  const block = blockBelow(on);
  const childIndent = Math.min(...block.map(indentOf));
  const at = block.findIndex((l) => indentOf(l) === childIndent && /^\s*push:/.test(l));
  assert.ok(at >= 0, 'on に push がありません');
  const push: string[] = [];
  for (const l of block.slice(at + 1)) {
    if (indentOf(l) <= childIndent) break;
    push.push(l.trim());
  }
  assert.ok(!push.some((l) => l.startsWith('branches')), `push に branches があります: ${push.join(' ')}`);
  assert.ok(!/branches/.test(block[at]!), `push に branches があります: ${block[at]!.trim()}`);
});

test('gate.yml：ジョブ gate の if に、refs/heads/ を前置きした既定ブランチ以外への push を除く項が、トップレベルの && でつながる独立の項としてある', () => {
  // タグの push（refs/tags/*）は refs/heads/<既定ブランチ> と一致しないので、この項でジョブ gate が skipped になる
  const ifs = gateIfLines();
  const at = ifs.findIndex((l) => l.trim().replace(/\s*&&$/, '') === PUSH_CLAUSE);
  assert.ok(at > 0, `if に次の項の行がありません: ${PUSH_CLAUSE}`);
  assert.ok(ifs[at - 1]!.trimEnd().endsWith('&&'), '直前の行が && で終わっていません');
  const depth = ifs.slice(0, at).reduce((d, l) => d + parenDelta(l), 0);
  assert.equal(depth, 0, '項が括弧の中（ほかのイベントの OR の並びなど）にあります');
  assert.equal(parenDelta(ifs[at]!), 0, '項の括弧が閉じていません');
  const rest = ifs.slice(at + 1).filter((l) => l.trim() !== '');
  if (rest.length > 0) assert.ok(ifs[at]!.trimEnd().endsWith('&&'), '後ろに項が続くなら && でつなぐ');
});

test('gate.yml：ジョブ gate・rerun-failed は既定ブランチを checkout し、environment が gate', () => {
  for (const name of ['gate', 'rerun-failed']) {
    const body = blockBelow(jobLine(name)).map((l) => l.trim());
    const refs = body.filter((l) => l.startsWith('ref:'));
    assert.deepEqual(refs, ['ref: ${{ github.event.repository.default_branch }}'], `${name} の checkout の ref`);
    assert.equal(jobKeyLine(name, 'environment')?.trim(), 'environment: gate', `${name} の environment`);
  }
});

test('gate.yml：ワークフローの最上位とジョブ gate に concurrency が無い（skipped になる他ブランチの push が、既定ブランチの gate の実行を取り消し・待たせない）', () => {
  // ジョブ rerun-failed の concurrency（gate-rerun-failed・cancel-in-progress: false）は gates-rerun-failed.test.ts が確かめている
  assert.ok(!lines.some((l) => /^concurrency:/.test(l)), 'ワークフローの最上位に concurrency があります');
  assert.equal(jobKeyLine('gate', 'concurrency'), undefined, 'ジョブ gate に concurrency があります');
});
