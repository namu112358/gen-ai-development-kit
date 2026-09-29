import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_OVERWRITE_RULE, WRITE_RULES } from './support/output-file-rules.ts';

// 判定の担当が自分の出力を渡されたパスに書き、呼び出し元は写さない（Issue #175）

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const JUDGE_SKILL = '.claude/skills/judge/SKILL.md';
const PANEL_SKILL = '.claude/skills/review-panel/SKILL.md';
const ROUTINE = '.claude/routine.md';

/** 判定の担当7つ */
const AGENTS = ['reviewer', 'risk-agent', 'review-intake', 'review-lens', 'review-ac-scope', 'review-safety', 'review-scorer'];
const agentPath = (name: string): string => `.claude/agents/${name}.md`;

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

/** routine.md の judge の節だけ */
const routineJudge = (): string => section(read(ROUTINE), '### judge（判定）');

/** 呼び出し元の手順3つ（名前 → 本文） */
function callers(): Record<string, string> {
  return {
    [JUDGE_SKILL]: read(JUDGE_SKILL),
    [PANEL_SKILL]: read(PANEL_SKILL),
    [`${ROUTINE} の judge`]: routineJudge(),
  };
}

/** 句点と改行で文に分ける */
const sentences = (text: string): string[] => text.split(/[。\n]/).map((s) => s.trim()).filter((s) => s !== '');

// ---- 担当の定義（AC1） ----

test('担当の定義：7つの tools はちょうど Read, Grep, Glob, Bash, Write で、外に出るツールが無い', () => {
  for (const name of AGENTS) {
    const fm = frontmatter(read(agentPath(name)));
    assert.equal(fm.name, name, `${name}: name`);
    assert.equal(fm.tools, 'Read, Grep, Glob, Bash, Write', `${name}: tools`);
    assert.ok(!/WebFetch|WebSearch|mcp/i.test(fm.tools ?? ''), `${name}: 外に出るツールが無い`);
  }
});

test('担当の定義：7つに、渡された出力のパスに Write で書く文と、書いてよいのはそのパスだけの文が同じ言い回しである', () => {
  for (const name of AGENTS) {
    const text = read(agentPath(name));
    for (const rule of WRITE_RULES) assert.ok(text.includes(rule), `${name}: 「${rule}」がありません`);
  }
});

test('担当の定義：7つの「## 入力」に出力のパスがある', () => {
  for (const name of AGENTS) {
    const input = section(read(agentPath(name)), '## 入力');
    assert.ok(input !== '', `${name}: 「## 入力」がありません`);
    assert.ok(input.includes('出力のパス'), `${name}: 「## 入力」に出力のパスがありません`);
  }
});

test('担当の定義：7つに、渡されたパスにファイルが既にあれば上書きしない文がある', () => {
  for (const name of AGENTS) {
    const text = read(agentPath(name));
    assert.ok(text.includes(NO_OVERWRITE_RULE), `${name}: 既にあるファイルを上書きしない文がありません`);
  }
});

// ---- 呼び出し元（AC2） ----

test('呼び出し元：routine.md から judge の節を切り出せる', () => {
  const judge = routineJudge();
  assert.ok(judge.startsWith('### judge（判定）'));
  assert.ok(!judge.includes('### fix（修正）'), 'judge の節に次の節が混ざっています');
});

test('呼び出し元：担当の出力を呼び出し元がファイルに保存する文が無い（review-panel の⑧の check.json の文だけ除く）', () => {
  for (const [name, text] of Object.entries(callers())) {
    for (const s of sentences(text)) {
      if (name === PANEL_SKILL && s.includes('check.json')) continue;
      assert.ok(!/書き換えずに[^。]*保存/.test(s), `${name}: 書き換えずに保存する文が残っています：${s}`);
      assert.ok(!/ファイル[^。]*に保存/.test(s), `${name}: ファイルに保存する文が残っています：${s}`);
    }
  }
});

test('呼び出し元：judge の skill は reviewer・risk-agent に出力のパスを渡し、ファイルが JSON として読めるかを確かめる', () => {
  const text = read(JUDGE_SKILL);
  assert.ok(text.includes('出力のパス'), '出力のパスがありません');
  for (const file of ['reviewer-<PR番号>-<head7>.json', 'risk-<PR番号>-<head7>.json']) assert.ok(text.includes(file), `${file} がありません`);
  assert.ok(text.includes('JSON として読める'), 'ファイルが JSON として読めるかを確かめる文がありません');
  assert.ok(text.includes('代わりに書かない'), '呼び出し元が代わりに書かない文がありません');
  const giveBack = section(text, '## 人に返す条件');
  assert.ok(giveBack.includes('JSON として読めない'), '人に返す条件に、ファイルが JSON として読めないときがありません');
});

test('呼び出し元：review-panel の skill は担当に review-panel.ts が読む決まった名前のパスを渡し、ファイルが読めるかを確かめる', () => {
  const text = read(PANEL_SKILL);
  assert.ok(text.includes('出力のパス'), '出力のパスがありません');
  for (const file of ['<dir>/intake.json', '<dir>/lens1.json', '<dir>/lens5.json', '<dir>/ac-scope.json', '<dir>/safety.json', '<dir>/score-<id>.json']) {
    assert.ok(text.includes(file), `${file} がありません`);
  }
  assert.ok(text.includes('JSON として読める'), 'ファイルが JSON として読めるかを確かめる文がありません');
  assert.ok(text.includes('代わりに書かない'), '呼び出し元が代わりに書かない文がありません');
});

test('呼び出し元：routine.md の judge は一時ディレクトリに出力のパスを決めて渡し、ファイルが JSON として読めるかを確かめる', () => {
  const text = routineJudge();
  assert.ok(text.includes('mktemp -d'), '一時ディレクトリを mktemp -d で作る文がありません');
  assert.ok(text.includes('出力のパス'), '出力のパスがありません');
  for (const file of ['reviewer-<PR番号>-<head7>.json', 'risk-<PR番号>-<head7>.json']) assert.ok(text.includes(file), `${file} がありません`);
  assert.ok(text.includes('JSON として読める'), 'ファイルが JSON として読めるかを確かめる文がありません');
  assert.ok(text.includes('サブエージェントの答えを書き換えない'), 'サブエージェントの答えを書き換えない文が無くなっています');
});

test('呼び出し元：3つとも担当を呼ぶ前と呼んだ後の git status --porcelain --untracked-files=all を比べ、「空」を条件にしない', () => {
  for (const [name, text] of Object.entries(callers())) {
    assert.ok(text.includes('git status --porcelain --untracked-files=all'), `${name}: git status --porcelain --untracked-files=all がありません`);
    for (const word of ['呼ぶ前', '呼んだ後', '比べる']) assert.ok(text.includes(word), `${name}: 「${word}」がありません`);
    assert.ok(!text.includes('が空'), `${name}: 「が空」を条件にする文があります`);
  }
});

test('呼び出し元：3つとも、ファイルが無いときは同じパスで1回だけ呼び直し、別名のファイルを作らない', () => {
  for (const [name, text] of Object.entries(callers())) {
    const retry = sentences(text).filter((s) => s.includes('同じパス') && s.includes('1回だけ') && s.includes('呼び直'));
    assert.ok(retry.length > 0, `${name}: 同じパスで1回だけ呼び直す文がありません`);
    assert.ok(!text.includes('-retry'), `${name}: 「-retry」の別名のファイルがあります`);
  }
});

// ---- 説明 ----

test('docs/review-panel.md：担当の tools は Write を含み、古い「Read, Grep, Glob, Bash だけ」の言い方が無い', () => {
  const text = read('docs/review-panel.md');
  assert.ok(!text.includes('`Read, Grep, Glob, Bash` だけ'), '古い言い方が残っています');
  assert.ok(text.includes('`Read, Grep, Glob, Bash, Write`'), '担当の tools に Write がありません');
  assert.ok(text.includes('呼び出し元が渡した出力のパスだけ'), 'Write で書いてよいのは渡された出力のパスだけの文がありません');
});
