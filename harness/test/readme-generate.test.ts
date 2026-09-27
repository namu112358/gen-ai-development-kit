import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Issue #132：README の表（名前・内容・ガードレール）を各ディレクトリの先頭のコメントから生成する
//
// harness/scripts/readme.ts（未実装）から import する。実装が無い間はここで失敗する。
import {
  extractComment,
  extractDirComment,
  firstSentence,
  toCell,
  guardrailMarkForFile,
  guardrailMarkForDir,
  renderTable,
  readmeFileFor,
  currentBlock,
  writeReadme,
  checkAll,
  TARGET_DIRS,
  NO_GENERATE_DIRS,
  NO_COMMENT_ALLOWLIST,
} from '../scripts/readme.ts';
import { loadConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');

// ---- 抽出：.ts（import の後の JSDoc） ----

test('.ts：複数行の import と空行の後の JSDoc の1文目を取り出す', () => {
  const content = [
    "import { a } from './a.ts';",
    'import {',
    '  b,',
    '  c,',
    "} from './b.ts';",
    '',
    '/**',
    ' * 説明の1文目です。2文目は無視されます。',
    ' * @param x 引数の説明',
    ' */',
    'export function f(x: number): void {}',
    '',
  ].join('\n');
  const raw = extractComment('foo.ts', content);
  assert.ok(raw !== null);
  assert.ok(raw!.includes('説明の1文目です'));
  assert.ok(!raw!.includes('@param'));
  assert.equal(firstSentence(raw!), '説明の1文目です。');
});

test('.ts：先頭に JSDoc が無ければ「先頭のコメントが無い」扱い（null）', () => {
  const content = ["import { a } from './a.ts';", '', 'export function f(): void {}', ''].join('\n');
  assert.equal(extractComment('foo.ts', content), null);
});

test('.ts：import の前にコードがある場合も JSDoc が無いのと同じ扱い', () => {
  const content = ['const x = 1;', '', '/**', ' * これは説明にならない。', ' */', 'export function f(): void {}'].join('\n');
  assert.equal(extractComment('foo.ts', content), null);
});

// ---- 抽出：.md（frontmatter / 見出しの次の段落） ----

test('.md：frontmatter に description があればそれを使う', () => {
  const content = ['---', 'name: foo', 'description: 説明本文です。詳細は後で。', '---', '', '# 見出し', '', '本文はここ。'].join('\n');
  const raw = extractComment('foo.md', content);
  assert.equal(firstSentence(raw!), '説明本文です。');
});

test('.md：frontmatter が無ければ最初の見出しの次の段落を使い、リンクは文字だけ、** は外す', () => {
  const content = ['# タイトル', '', '**重要**：[文字列](https://example.com)の続きの文章。', '', '次の段落は無視。'].join('\n');
  const raw = extractComment('foo.md', content);
  assert.ok(raw !== null);
  assert.ok(!raw!.includes('['), 'リンクの記法が残っていない');
  assert.ok(!raw!.includes('**'), '** が外れている');
  assert.equal(firstSentence(raw!), '重要：文字列の続きの文章。');
});

// ---- 抽出：.yml（先頭の連続した # の行） ----

test('.yml：ファイル先頭の連続した # の行を取り出す', () => {
  const content = ['# 見出しの説明', '# 続きの説明。', 'name: CI', 'on: push'].join('\n');
  const raw = extractComment('foo.yml', content);
  assert.ok(raw !== null);
  assert.ok(raw!.includes('見出しの説明'));
  assert.ok(raw!.includes('続きの説明'));
});

test('.yml：先頭に # が無ければ null', () => {
  const content = ['name: CI', '# ここはファイルの先頭ではない', 'on: push'].join('\n');
  assert.equal(extractComment('foo.yml', content), null);
});

// ---- 抽出：ディレクトリ（README.md / SKILL.md） ----

test('ディレクトリ：README.md があればその先頭のコメント（.md の規則）を使う', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'readme-test-'));
  try {
    const dir = join(tmp, 'sub');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), ['# sub/', '', 'これは sub の説明。', ''].join('\n'));
    const raw = extractDirComment(tmp, 'sub');
    assert.equal(firstSentence(raw!), 'これは sub の説明。');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ディレクトリ：README.md が無く SKILL.md があれば frontmatter の description を使う', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'readme-test-'));
  try {
    const dir = join(tmp, 'skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), ['---', 'name: skill', 'description: skill の説明です。詳しくは本文。', '---', '', '# skill', ''].join('\n'));
    const raw = extractDirComment(tmp, 'skill');
    assert.equal(firstSentence(raw!), 'skill の説明です。');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- 1文目の切り方 ----

test('1文目の切り方：最初の 。 まで', () => {
  assert.equal(firstSentence('これは1文目。これは2文目。'), 'これは1文目。');
});

test('1文目の切り方：。 が無ければ段落全体', () => {
  assert.equal(firstSentence('句点を含まない説明'), '句点を含まない説明');
});

test('1文目の切り方：箇条書きの手前で段落を止める', () => {
  assert.equal(firstSentence('説明の文章\n- 項目1\n- 項目2'), '説明の文章');
  assert.equal(firstSentence('説明の文章\n* 項目1'), '説明の文章');
  assert.equal(firstSentence('説明の文章\n1. 項目1'), '説明の文章');
});

test('1文目の切り方：空行で段落を止める', () => {
  assert.equal(firstSentence('1段落目の文章\n\n2段落目は無視。'), '1段落目の文章');
});

test('1文目の切り方：行の継ぎ目は両側が ASCII なら空白1つ、それ以外は空白なしでつなぐ', () => {
  assert.equal(firstSentence('日本語の行\n続きの行。'), '日本語の行続きの行。');
  assert.equal(firstSentence('English line\ncontinues.'), 'English line continues.');
  assert.equal(firstSentence('日本語 English\ncontinues.'), '日本語 English continues.');
});

// ---- 表セルの扱い（| と ``` のエスケープ） ----

test('表セル：| はエスケープする', () => {
  assert.equal(toCell('a | b'), 'a \\| b');
});

test('表セル：``` で始まる語は4つのバッククォートで囲む', () => {
  assert.equal(toCell('```agent-plan``` の構造化コメント'), '````agent-plan```` の構造化コメント');
});

// ---- ガードレールの列 ----

test('ガードレールの列（ファイル）：guardrailPaths に当たれば ○', () => {
  const config = { guardrailPaths: ['harness/lib/**'], guardrailExclude: [] };
  assert.equal(guardrailMarkForFile(config, 'harness/lib/config.ts'), '○');
});

test('ガードレールの列（ファイル）：guardrailExclude に当たれば 対象外', () => {
  const config = { guardrailPaths: ['harness/lib/**'], guardrailExclude: ['harness/lib/usage.ts'] };
  assert.equal(guardrailMarkForFile(config, 'harness/lib/usage.ts'), '対象外');
});

test('ガードレールの列（ファイル）：guardrailPaths に当たらなければ空', () => {
  const config = { guardrailPaths: ['harness/lib/**'], guardrailExclude: [] };
  assert.equal(guardrailMarkForFile(config, 'harness/scripts/agent.ts'), '');
});

test('ガードレールの列（ディレクトリ）：配下すべてが当たれば ○、一部なら 一部、無ければ空', () => {
  const config = { guardrailPaths: ['harness/lib/**'], guardrailExclude: [] };
  assert.equal(guardrailMarkForDir(config, ['harness/lib/a.ts', 'harness/lib/b.ts']), '○');
  assert.equal(guardrailMarkForDir(config, ['harness/lib/a.ts', 'harness/scripts/b.ts']), '一部');
  assert.equal(guardrailMarkForDir(config, ['harness/scripts/a.ts', 'harness/scripts/b.ts']), '');
});

// ---- 一時ディレクトリを使った一連の流れ：生成 → 一致 → 改ざん → 食い違い → write で直る ----

test('一連の流れ：生成結果と README が一致し、先頭のコメントを変えると check が食い違いを出し、write で直る', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'readme-test-'));
  try {
    mkdirSync(join(tmp, 'sample'), { recursive: true });
    writeFileSync(
      join(tmp, 'sample', 'a.ts'),
      ['/**', ' * a の説明。', ' */', 'export const a = 1;', ''].join('\n'),
    );
    writeFileSync(
      join(tmp, 'sample', 'README.md'),
      ['# sample/', '', 'sample の説明。', '', '<!-- readme:generated start -->', '<!-- readme:generated end -->', ''].join('\n'),
    );

    // 生成した表をマーカーの間に書く
    writeReadme(tmp, 'sample');
    const generated = readFileSync(join(tmp, 'sample', 'README.md'), 'utf8');
    assert.equal(currentBlock(tmp, 'sample'), renderTable(tmp, 'sample'));
    assert.ok(generated.includes('a.ts'));
    assert.ok(generated.includes('a の説明'));

    // 先頭のコメントを変えると、書き直す前は食い違う
    writeFileSync(join(tmp, 'sample', 'a.ts'), ['/**', ' * a の新しい説明。', ' */', 'export const a = 1;', ''].join('\n'));
    assert.notEqual(currentBlock(tmp, 'sample'), renderTable(tmp, 'sample'));

    // write で直る
    writeReadme(tmp, 'sample');
    assert.equal(currentBlock(tmp, 'sample'), renderTable(tmp, 'sample'));
    assert.ok(readFileSync(join(tmp, 'sample', 'README.md'), 'utf8').includes('a の新しい説明'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readmeFileFor：.github は root の README.md、他は dir 直下の README.md', () => {
  assert.equal(readmeFileFor(root, '.github'), join(root, 'README.md'));
  assert.equal(readmeFileFor(root, 'harness/lib'), join(root, 'harness', 'lib', 'README.md'));
});

// ---- 実リポジトリに対する検査（AC2） ----

test('実リポジトリ：対象ディレクトリすべてで README の表が生成結果と一致する（AC2）', () => {
  const result = checkAll(root);
  assert.deepEqual(result.mismatches, [], `生成結果と食い違う: ${result.mismatches.join(', ')}`);
});

test('実リポジトリ：先頭のコメントが無いファイルは手書きの一覧の4件だけで、一覧はすべて実在し、実際に先頭のコメントが無い', () => {
  const result = checkAll(root);
  assert.deepEqual(result.noCommentIssues, [], `手書きの一覧との食い違い: ${result.noCommentIssues.join(', ')}`);
  assert.deepEqual(
    [...NO_COMMENT_ALLOWLIST].sort(),
    ['.claude/settings.json', 'harness/templates/claude-settings.deny.json', '.github/ISSUE_TEMPLATE/', '.github/pull_request_template.md'].sort(),
  );
});

test('対象ディレクトリの一覧は14件、生成の対象外（Non-goal）は harness/test と harness/test/support', () => {
  assert.equal(TARGET_DIRS.length, 14);
  assert.deepEqual([...NO_GENERATE_DIRS].sort(), ['harness/test', 'harness/test/support'].sort());
});

// 設定の読み込みが問題なく行えることの確認（checkAll がガードレールの列を計算するために使う）
test('harness.config.json が読め、guardrailPaths を持つ', () => {
  const config = loadConfig();
  assert.ok(Array.isArray(config.guardrailPaths));
});
