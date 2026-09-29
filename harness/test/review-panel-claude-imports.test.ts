// Issue #166：合体版のレビューが CLAUDE.md の読み込み先（@<パス>）の規則も読む（review-intake の段階1・review-lens の①・review-scorer）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const INTAKE = '.claude/agents/review-intake.md';
const LENS = '.claude/agents/review-lens.md';
const SCORER = '.claude/agents/review-scorer.md';
const IMPORTED = 'harness/CLAUDE.harness.md';

/** 番号付きの手順の N 番目の項目（次の番号の項目の前まで） */
function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  assert.ok(start >= 0, `手順 ${n} がある`);
  const rest = lines.slice(start + 1).findIndex((l) => /^\d+\. /.test(l));
  return lines.slice(start, rest < 0 ? undefined : start + 1 + rest).join('\n');
}

/** 出力の例の ```json ブロック */
function jsonExample(text: string): unknown {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, '出力の例の json ブロックがある');
  return JSON.parse(m[1]!);
}

/** review-intake の段階1の規則どおりに、CLAUDE.md の @ の行（行頭が @、コードブロックの外）が指すパスを返す（1段だけ） */
function imports(claudeMdPath: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of read(claudeMdPath).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = line.match(/^@(\S+)\s*$/);
    if (m) out.push(join(dirname(claudeMdPath), m[1]!).replace(/\\/g, '/'));
  }
  return out;
}

// ---- review-intake の段階1 ----

test('review-intake の段階1：CLAUDE.md が @<パス> で読み込むファイルも claudeMd に並べると書いてある', () => {
  const s = step(read(INTAKE), 2);
  assert.match(s, /段階1/);
  assert.match(s, /git ls-files '\*CLAUDE\.md'/, '探す形は今のまま');
  assert.match(s, /`@<パス>`|`@`/, '@ の行に触れている');
  assert.match(s, /読み込む/, '読み込み先をたどる');
  assert.match(s, /claudeMd/, '読み込み先も claudeMd に入れる');
});

test('review-intake の段階1：@ の行の条件（行の先頭が @・コードブロックの外・1段だけ・CLAUDE.md のディレクトリから見た相対・存在するもの）', () => {
  const s = step(read(INTAKE), 2);
  assert.match(s, /行の先頭が `@`/);
  assert.match(s, /コードブロックの外/);
  assert.match(s, /1段/);
  assert.match(s, /相対/);
  assert.match(s, /存在する/);
});

test('review-intake の出力の例：claudeMd に CLAUDE.md と harness/CLAUDE.harness.md の両方がある', () => {
  const example = jsonExample(read(INTAKE)) as { claudeMd?: unknown };
  assert.deepEqual(example.claudeMd, ['CLAUDE.md', IMPORTED]);
});

// ---- review-lens の①・review-scorer ----

test('review-lens の①：渡されたパスには CLAUDE.md が @ で読み込むファイルも含まれ、その規則も根拠にでき、rule にそのファイルのパスを書く', () => {
  const text = read(LENS);
  const line = text.split('\n').find((l) => l.startsWith('- ①（Agent #1）'));
  assert.ok(line, '①の説明の行がある');
  assert.match(line, /`@`/);
  assert.match(line, /読み込む/);
  assert.match(line, /根拠/);
  assert.match(line, /rule/);
  assert.match(line, /パス/);
});

test('review-lens：公式の Agent #1 の写しの行は変えない', () => {
  assert.ok(read(LENS).includes('a. Agent #1: Audit the changes to make sure they compily with the CLAUDE.md. Note that CLAUDE.md is guidance for Claude as it writes code, so not all instructions will be applicable during code review.'));
});

test('review-scorer：入力と手順2に、CLAUDE.md が @ で読み込むファイルも含み、その規則も CLAUDE.md の規則として確かめると書いてある', () => {
  const text = read(SCORER);
  const input = text.slice(text.indexOf('## 入力'), text.indexOf('## 手順'));
  assert.match(input, /`@`/, '入力の説明に @ の読み込み先');
  assert.match(input, /読み込む/);
  const s2 = step(text, 2);
  assert.match(s2, /`@`/, '手順2に @ の読み込み先');
  assert.match(s2, /読み込む/);
  assert.match(s2, /CLAUDE\.md の規則として/);
});

test('review-scorer：公式の採点基準の写しの行は変えない', () => {
  assert.ok(read(SCORER).includes('d. 75: Highly confident. The agent double checked the issue, and verified that it is very likely it is a real issue that will be hit in practice. The existing approach in the PR is insufficient. The issue is very important and will directly impact the code\'s functionality, or it is an issue that is directly mentioned in the relevant CLAUDE.md.'));
});

// ---- 今のリポジトリで手順どおりにたどれる ----

test('今のリポジトリ：root の CLAUDE.md の @ の行が harness/CLAUDE.harness.md を指し、そのファイルがある', () => {
  const found = imports('CLAUDE.md');
  assert.ok(found.includes(IMPORTED), `見つけた読み込み先: ${found.join(', ')}`);
  for (const p of found) assert.ok(existsSync(join(root, p)), `${p} がある`);
  assert.match(read(IMPORTED), /やってはいけないこと/, '読み込み先に観点①の根拠になる規則がある');
});

test('今のリポジトリ：git ls-files の CLAUDE.md の @ の読み込み先はどれも存在し、*CLAUDE.md の形には当たらない（たどらないと拾えない）', () => {
  const r = spawnSync('git', ['ls-files', '*CLAUDE.md'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const listed = r.stdout.split('\n').filter(Boolean);
  assert.ok(listed.includes('CLAUDE.md'));
  assert.ok(!listed.includes(IMPORTED), `${IMPORTED} は git ls-files '*CLAUDE.md' に当たらない`);
  for (const md of listed) for (const p of imports(md)) assert.ok(existsSync(join(root, p)), `${md} の @${p} がある`);
});
