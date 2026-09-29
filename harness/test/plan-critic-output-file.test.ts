import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_OVERWRITE_RULE, WRITE_RULES } from './support/output-file-rules.ts';

// plan-critic も渡された出力のパスに自分で JSON を書き、呼び出し元（plan の skill）は写さない（Issue #217）

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const CRITIC = '.claude/agents/plan-critic.md';
const PLAN_SKILL = '.claude/skills/plan/SKILL.md';

/** 先頭の `---` で囲まれた frontmatter を key: value で読む */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** 見出しの行（前方一致）から、同じか上の階層の次の見出しの前までを切り出す */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return '';
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** 句点と改行で文に分ける */
const sentences = (text: string): string[] => text.split(/[。\n]/).map((s) => s.trim()).filter((s) => s !== '');

// ---- plan-critic の定義（AC1） ----

test('plan-critic の定義：tools はちょうど Read, Grep, Glob, Bash, Write で、WebFetch・MCP が無い', () => {
  const fm = frontmatter(read(CRITIC));
  assert.equal(fm.name, 'plan-critic');
  assert.equal(fm.tools, 'Read, Grep, Glob, Bash, Write');
  assert.ok(!/WebFetch|WebSearch|mcp/i.test(fm.tools ?? ''), '外に出るツールが無い');
});

test('plan-critic の定義：判定の担当と同じ言い回しで、渡された出力のパスに Write で書く文がある', () => {
  const text = read(CRITIC);
  for (const rule of WRITE_RULES) assert.ok(text.includes(rule), `「${rule}」がありません`);
});

test('plan-critic の定義：判定の担当と同じ言い回しで、渡されたパスにファイルが既にあれば上書きしない文がある', () => {
  assert.ok(read(CRITIC).includes(NO_OVERWRITE_RULE), '既にあるファイルを上書きしない文がありません');
});

test('plan-critic の定義：「## 入力」に出力のパスがある', () => {
  const input = section(read(CRITIC), '## 入力');
  assert.ok(input !== '', '「## 入力」がありません');
  assert.ok(input.includes('出力のパス'), '「## 入力」に出力のパスがありません');
});

test('plan-critic の定義：「リポジトリのファイルを変更しない」があり、素の「ファイルを変更しない。」が残っていない', () => {
  const text = read(CRITIC);
  assert.ok(text.includes('リポジトリのファイルを変更しない'), '「リポジトリのファイルを変更しない」がありません');
  const bare = text.split('リポジトリのファイルを変更しない').join('');
  assert.ok(!bare.includes('ファイルを変更しない。'), 'Write と食い違う素の「ファイルを変更しない。」が残っています');
});

// ---- plan の skill（AC2） ----

test('plan の skill：出力のパス critic-<番号>-<回数>.json を渡し、ファイルが JSON として読めるかを確かめ、代わりに書かない', () => {
  const text = read(PLAN_SKILL);
  for (const word of ['critic-<番号>-<回数>.json', '出力のパス', 'JSON として読める', '代わりに書かない']) {
    assert.ok(text.includes(word), `「${word}」がありません`);
  }
});

test('plan の skill：--previous に plan-critic が書いたファイル（critic-<番号>-）を渡す', () => {
  const previous = sentences(read(PLAN_SKILL)).filter((s) => s.includes('--previous'));
  assert.ok(previous.length > 0, '--previous の文がありません');
  assert.ok(previous.some((s) => s.includes('critic-<番号>-')), `--previous の文に critic-<番号>- のファイルがありません：${previous.join(' / ')}`);
});

test('plan の skill：呼ぶ前に出力のパスにファイルが無いことを確かめ、あれば回数を進め、回数を 1 に戻さない', () => {
  const ss = sentences(read(PLAN_SKILL));
  assert.ok(ss.some((s) => s.includes('呼ぶ前') && s.includes('ファイルが無い')), '呼ぶ前にファイルが無いことを確かめる文がありません');
  assert.ok(ss.some((s) => s.includes('回数を進め')), 'ファイルがあれば回数を進める文がありません');
  assert.ok(ss.some((s) => s.includes('1 に戻さない')), '回数を 1 に戻さない文がありません');
});

test('plan の skill：返事の本文とファイルの中身が食い違ったら、ファイルの中身を使う', () => {
  const ss = sentences(read(PLAN_SKILL));
  assert.ok(ss.some((s) => s.includes('食い違') && s.includes('ファイルの中身を使う')), '食い違ったらファイルの中身を使う文がありません');
});

test('plan の skill：plan-critic の出力を呼び出し元がファイルに保存する（写す）文が無い', () => {
  for (const s of sentences(read(PLAN_SKILL))) {
    assert.ok(!/書き換えずに[^。]*保存/.test(s), `書き換えずに保存する文が残っています：${s}`);
    assert.ok(!/ファイル[^。]*に保存/.test(s), `ファイルに保存する文が残っています：${s}`);
  }
});

test('plan の skill：ファイルが無いときは同じパスで1回だけ呼び直し、別名のファイルを作らない', () => {
  const text = read(PLAN_SKILL);
  const retry = sentences(text).filter((s) => s.includes('同じパス') && s.includes('1回だけ') && s.includes('呼び直'));
  assert.ok(retry.length > 0, '同じパスで1回だけ呼び直す文がありません');
  assert.ok(!text.includes('-retry'), '「-retry」の別名のファイルがあります');
});

test('plan の skill：plan-critic を呼ぶ前と呼んだ後の git status --porcelain --untracked-files=all を比べ、「空」を条件にしない', () => {
  const text = read(PLAN_SKILL);
  assert.ok(text.includes('git status --porcelain --untracked-files=all'), 'git status --porcelain --untracked-files=all がありません');
  for (const word of ['呼ぶ前', '呼んだ後', '比べる']) assert.ok(text.includes(word), `「${word}」がありません`);
  assert.ok(!text.includes('が空'), '「が空」を条件にする文があります');
});

test('plan の skill：「## 人に返す条件」に、書いたファイルが JSON として読めないときがある', () => {
  const giveBack = section(read(PLAN_SKILL), '## 人に返す条件');
  assert.ok(giveBack !== '', '「## 人に返す条件」がありません');
  assert.ok(giveBack.includes('JSON として読めない'), '人に返す条件に、ファイルが JSON として読めないときがありません');
});
