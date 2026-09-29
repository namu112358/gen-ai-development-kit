// Issue #195：Orca のスキルの入口（.claude/skills/orca-cli・orchestration）を配る検査。
// 取り込んだファイルの sha256（改行を LF にそろえる）とコミットの固定値、MIT の表示（docs/upstream/・NOTICE）、
// managed.json に当たること、入口に素の orca のコマンドが無いこと、docs/setup.md の Orca の節と docs/security.md の受け入れているリスクの行を確かめる
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { globToRegExp } from '../lib/scope.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, ...rel.split('/')), 'utf8');

/** docs/setup.md の Orca の節の番号（人の判断待ち。変えるときはここだけ直す） */
const ORCA_SECTION_NO = 11;
const ORCA_HEADING_PREFIX = `## ${ORCA_SECTION_NO}. Orca`;

/** 取り込んだ stablyai/orca のコミット（タグ v1.4.215） */
const ORCA_COMMIT = '083f583a53e4c74a65acf420eee4ca2e0efa9df1';

/** 改行を LF にそろえた sha256 の固定値 */
const PINNED: Record<string, string> = {
  '.claude/skills/orca-cli/SKILL.md': 'aa76f86505010096e8ea9edda1705a78aae7af45e54485f3fe0460664c1d9e4a',
  '.claude/skills/orchestration/SKILL.md': 'cd1b364bf35781bad06bf75ab1766afa8d6cec69cb2060529691d89871a2098a',
  'docs/upstream/orca/LICENSE': 'ff1b611f80580d49f4b97e93a97b24eb050b0671b26b8afe16341fab699112f3',
};

const SKILLS = ['orca-cli', 'orchestration'];
const skillPath = (name: string): string => `.claude/skills/${name}/SKILL.md`;

const lfSha256 = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

/** frontmatter（先頭の --- から次の --- の行まで）と、その後の本文に分ける。改行は LF にそろえる */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const text = content.replace(/\r\n/g, '\n');
  assert.ok(text.startsWith('---\n'), 'frontmatter で始まらない');
  const end = text.indexOf('\n---\n', 3);
  assert.ok(end !== -1, 'frontmatter の終わりが無い');
  return { frontmatter: text.slice(4, end), body: text.slice(end + 5) };
}

/** docs/setup.md の Orca の節（見出しから次の ## の前まで） */
function orcaSection(): string {
  const lines = read('docs/setup.md').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(ORCA_HEADING_PREFIX));
  assert.ok(start !== -1, `docs/setup.md に「${ORCA_HEADING_PREFIX}」で始まる見出しが無い`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

// ---- 取り込んだファイル ----

test('取り込んだ入口と LICENSE の sha256（改行を LF にそろえる）が固定値と同じ', () => {
  for (const [rel, sha] of Object.entries(PINNED)) {
    assert.ok(existsSync(join(root, ...rel.split('/'))), `${rel} が無い`);
    assert.equal(lfSha256(read(rel)), sha, `${rel} の sha256 が固定値と違う`);
  }
});

test('入口の frontmatter の name がディレクトリ名と同じ', () => {
  for (const name of SKILLS) {
    const { frontmatter } = splitFrontmatter(read(skillPath(name)));
    const m = /^name:\s*(.+)$/m.exec(frontmatter);
    assert.ok(m, `${skillPath(name)} に name が無い`);
    assert.equal(m[1]?.trim().replace(/^["']|["']$/g, ''), name);
  }
});

test('入口のディレクトリには SKILL.md だけがある', () => {
  for (const name of SKILLS) {
    const entries = readdirSync(join(root, '.claude', 'skills', name), { recursive: true }).map(String);
    assert.deepEqual(entries, ['SKILL.md'], `.claude/skills/${name}/ に SKILL.md 以外がある`);
  }
});

test('docs/upstream/orca/LICENSE は MIT License で始まる', () => {
  assert.ok(read('docs/upstream/orca/LICENSE').startsWith('MIT License'));
});

test('docs/upstream/README.md と NOTICE に stablyai/orca・コミット・MIT がある', () => {
  for (const rel of ['docs/upstream/README.md', 'NOTICE']) {
    const text = read(rel);
    assert.ok(text.includes('stablyai/orca'), `${rel} に stablyai/orca が無い`);
    assert.ok(text.includes(ORCA_COMMIT), `${rel} にコミット ${ORCA_COMMIT} が無い`);
    assert.ok(text.includes('MIT'), `${rel} に MIT が無い`);
  }
});

test('入口の2つのパスが harness/managed.json の managed に当たる', () => {
  const managed = (JSON.parse(read('harness/managed.json')) as { managed: string[] }).managed;
  const matchers = managed.map(globToRegExp);
  for (const name of SKILLS) {
    const p = skillPath(name);
    assert.ok(
      matchers.some((m) => m.test(p)),
      `${p} が managed のどのパターンにも当たらない`,
    );
  }
});

// ---- 素の orca を使わない ----

/** 本文のうち、素の orca のコマンドに見えるもの（行頭が orca の語、バッククォートの中が `orca ` で始まる） */
function bareOrcaUses(body: string): string[] {
  const found: string[] = [];
  for (const line of body.split('\n')) {
    if (/^\s*(?:\$\s*)?orca(?:\s|$)/.test(line)) found.push(`行頭: ${line}`);
  }
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const code = m[1] ?? '';
    if (/^\s*orca\s/.test(code)) found.push(`コード: ${code}`);
  }
  return found;
}

test('入口の本文に素の orca で始まるコマンドが無い', () => {
  for (const name of SKILLS) {
    const { body } = splitFrontmatter(read(skillPath(name)));
    assert.deepEqual(bareOrcaUses(body), [], `${skillPath(name)} に素の orca のコマンドがある`);
  }
});

test('素の orca の検査は、行頭の orca とバッククォートの中の orca … を見つけ、`orca` 単独は見逃す', () => {
  assert.equal(bareOrcaUses('orca skills get orca-cli\n').length, 1);
  assert.equal(bareOrcaUses('  $ orca open --json\n').length, 1);
  assert.equal(bareOrcaUses('run `orca open --json` now\n').length, 1);
  assert.deepEqual(bareOrcaUses('- Otherwise, use `orca`.\n`orca-ide` and ORCA skills get x\n'), []);
});

test('入口の本文に、Linux で素の orca を使わない文がある', () => {
  for (const name of SKILLS) {
    const { body } = splitFrontmatter(read(skillPath(name)));
    const flat = body.replace(/\s+/g, ' ');
    assert.ok(flat.includes('Never run bare `orca` there'), `${skillPath(name)} に「Never run bare \`orca\` there」が無い`);
  }
});

// ---- docs ----

test(`docs/setup.md の節${ORCA_SECTION_NO}（Orca）に、Orca の必須と、Orca が無いときの退行手段が書かれている`, () => {
  const section = orcaSection();
  assert.ok(section.includes('必須'), 'Orca の節に「必須」が無い');
  assert.ok(section.includes('Orca が無いとき'), 'Orca の節に「Orca が無いとき」が無い');
});

test('docs/security.md の受け入れているリスクの表に Orca の skill の行があり、sha256 と「Issue と PR」を含む', () => {
  const lines = read('docs/security.md').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## 受け入れているリスク'));
  assert.ok(start !== -1, '「## 受け入れているリスク」の節が無い');
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  const row = lines.slice(start, end).find((l) => l.startsWith('|') && l.includes('Orca の skill'));
  assert.ok(row, '受け入れているリスクの表に「Orca の skill」の行が無い');
  assert.ok(row.includes('sha256'), `Orca の skill の行に sha256 が無い: ${row}`);
  assert.ok(row.includes('Issue と PR'), `Orca の skill の行に「Issue と PR」が無い: ${row}`);
});
