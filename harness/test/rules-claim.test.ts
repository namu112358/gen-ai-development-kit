// Issue #164：着手宣言の段階（--stage）・引き継ぎ（--takeover）・宣言の確かめ・セッション間の分担を、
// ハーネスの規則（harness/CLAUDE.harness.md）と docs/operations.md・docs/glossary.md に書いたかを検査する。
// あわせて、priority:*・area:* を Jev に任せ、ラベルの不足を人に聞かない規則（Issue #209）と、.claude/hooks/README.md の表の説明が括弧の途中で切れていないことを確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAIM_STAGES } from '../lib/queue.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** 見出し（`## 名前` など）から、同じか上の階層の次の見出しの前までを返す。見出しが無ければ失敗させる */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  assert.ok(start >= 0, `見出し「${heading}」が無い`);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^(#+) /);
    if (m && (m[1] ?? '').length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/** 段落・箇条・表の行ごとに分けた、空でない行 */
const nonEmptyLines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

/** 文中の `--stage <名前>` の名前（`judge|fix|sync` のような並びは分ける。`<段階>` のような置き換えの印は除く） */
function stageNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/--stage ([a-z][a-z|-]*)/g)) names.push(...(m[1] ?? '').split('|').filter((s) => s !== ''));
  return names;
}

const rules = (): string => section(read('harness/CLAUDE.harness.md'), '## 進め方');
const operations = (): string => read('docs/operations.md');

// ---- AC1：規則に着手宣言の時点・--stage・--takeover・release ----

test('規則（進め方）：#155 で固定した「着手宣言は claim <番号> --manual」の行は残る', () => {
  assert.ok(
    nonEmptyLines(rules()).some((l) => l.includes('着手宣言は `node harness/scripts/agent.ts claim <番号> --manual`。')),
    '既存の着手宣言の行が消えている',
  );
});

test('規則（進め方）：段階を始める前に --stage で宣言し、段階が変わるたびに更新することが書かれている', () => {
  const text = rules();
  assert.match(text, /claim <番号> --manual --stage/, '`claim <番号> --manual --stage <段階>` の形が書かれていない');
  assert.match(text, /--stage plan(?![-\w])/, '計画の前の `--stage plan` が書かれていない');
  assert.match(text, /--stage implement/, '実装の `--stage implement` が書かれていない');
  assert.match(text, /段階が変わるたびに/, '段階が変わるたびに宣言を更新することが書かれていない');
});

test('規則（進め方）：--stage の段階の名前はすべて CLAIM_STAGES にあり、plan-critique・judge・fix・sync も書かれている', () => {
  const names = stageNames(rules());
  assert.ok(names.length > 0, '--stage の段階の名前が1つも無い');
  for (const n of names) assert.ok((CLAIM_STAGES as readonly string[]).includes(n), `--stage ${n} は CLAIM_STAGES に無い`);
  for (const n of ['plan', 'plan-critique', 'implement', 'judge', 'fix', 'sync']) {
    assert.ok(names.includes(n), `--stage ${n} が規則に無い`);
  }
});

test('規則（進め方）：judge・fix・sync は PR 番号で宣言することが書かれている', () => {
  assert.match(rules(), /claim <PR番号> --manual --stage/, 'judge・fix・sync を PR 番号で宣言することが書かれていない');
});

test('規則（進め方）：post-plan が投稿の後に plan-gate の宣言を出し直すことが書かれている', () => {
  const line = nonEmptyLines(rules()).find((l) => l.includes('post-plan') && l.includes('plan-gate'));
  assert.ok(line, '`post-plan` と `plan-gate` を同じ箇条に書いた行が無い');
});

test('規則（進め方）：セッションを終えるときの release が書かれている', () => {
  const line = nonEmptyLines(rules()).find((l) => /`[^`]*release[^`]*`/.test(l) && l.includes('着手宣言'));
  assert.ok(line, '着手宣言の箇条に `release` が無い');
});

test('規則（進め方）：ほかのセッションの宣言で claim が止まり、引き継ぐのは人が決めたときだけ --takeover', () => {
  const line = nonEmptyLines(rules()).find((l) => l.includes('--takeover'));
  assert.ok(line, '`--takeover` が規則に無い');
  assert.match(line, /ほかのセッション/, '`--takeover` の箇条に「ほかのセッション」の宣言で止まることが無い');
  assert.match(line, /人が決めた/, '`--takeover` は人が決めたときだけ、と書かれていない');
  assert.match(line, /--force/, '`--force` は領域の上限だけを飛ばす（引き継ぎではない）ことが書かれていない');
});

test('規則（進め方）：critic-input・post-plan・worktree は、このセッションの宣言が無いと止まることが書かれている', () => {
  const line = nonEmptyLines(rules()).find(
    (l) => l.includes('critic-input') && l.includes('post-plan') && l.includes('worktree') && l.includes('宣言'),
  );
  assert.ok(line, '`critic-input`・`post-plan`・`worktree` が宣言を確かめることを1つの箇条に書いた行が無い');
});

// ---- AC2：規則に、ほかのセッションと担当を決めてから段階を始めること ----

test('規則（進め方）：段階を始める前に着手宣言を確かめ、ほかのセッションと話して担当を決めることが書かれている', () => {
  const line = nonEmptyLines(rules()).find((l) => l.includes('担当'));
  assert.ok(line, '担当を決めることが規則に無い');
  assert.match(line, /ほかの(ローカルの)?セッション/, '担当の箇条に「ほかのセッション」が無い');
  assert.match(line, /段階を始める前/, '段階を始める前に確かめることが書かれていない');
  assert.match(line, /着手宣言を確かめ/, '着手宣言を確かめることが書かれていない');
  assert.match(line, /ListAgents/, 'セッション間のやり取りの手段 `ListAgents` が書かれていない');
  assert.match(line, /SendMessage/, 'セッション間のやり取りの手段 `SendMessage` が書かれていない');
});

// ---- 追加の要件（Issue #209）：priority:*・area:* は Jev に任せ、ラベルの不足を人に聞かない ----

test('規則（進め方）：priority:*・area:* は Jev に任せ、ラベルの不足を人に聞かず・伝えず・label-triage の記録が無いうちは付けない', () => {
  const line = nonEmptyLines(rules()).find((l) => l.includes('Jev') && l.includes('priority:*'));
  assert.ok(line, '`Jev` と `priority:*` を同じ箇条に書いた行が規則に無い');
  assert.match(line, /area:\*/, '`area:*` も Jev に任せることが書かれていない');
  assert.match(line, /聞か(ない|ず)/, 'ラベルの不足を人に聞かないことが書かれていない');
  assert.match(line, /伝え(ない|ず)/, 'ラベルの不足を人に伝えないことが書かれていない');
  assert.match(line, /記録が無い(うち|とき|間|Issue)[^。]*付け(ない|ず)/, 'label-triage の記録が無いうちは付けないことが書かれていない');
  assert.doesNotMatch(rules(), /人に伝える/, '規則に古い「人に伝える」が残っている');
});

// ---- AC3：docs/operations.md に --stage・--takeover・宣言の確かめ ----

test('operations.md「付き添いのセッションで進める」：--stage・--takeover・宣言の確かめ・セッション間の分担が書かれている', () => {
  const text = section(operations(), '## 付き添いのセッションで進める');
  assert.match(text, /--stage/, '`--stage` が無い');
  assert.match(text, /--takeover/, '`--takeover` が無い');
  for (const cmd of ['critic-input', 'post-plan', 'worktree']) {
    assert.ok(text.includes(cmd), `宣言を確かめるコマンド \`${cmd}\` が無い`);
  }
  assert.match(text, /担当/, 'ほかのセッションと担当を決めることが無い');
  for (const n of stageNames(text)) {
    assert.ok((CLAIM_STAGES as readonly string[]).includes(n), `--stage ${n} は CLAIM_STAGES に無い`);
  }
});

test('operations.md「人が関わる場面」：agent:plan-review の行は --stage implement で宣言してから実装する', () => {
  const table = section(operations(), '## 人が関わる場面');
  const row = nonEmptyLines(table).find((l) => l.startsWith('| `agent:plan-review` の Issue |'));
  assert.ok(row, '`agent:plan-review` の行が無い');
  assert.match(row, /claim <番号> --manual --stage implement/, '`claim <番号> --manual --stage implement` になっていない');
});

test('operations.md「人が関わる場面」：ほかのセッションの着手宣言がある場面の行があり、人が決めたら --takeover', () => {
  const table = section(operations(), '## 人が関わる場面');
  const row = nonEmptyLines(table).find((l) => l.startsWith('|') && l.includes('ほかのセッション') && l.includes('着手宣言'));
  assert.ok(row, '「ほかのセッションの着手宣言がある」行が無い');
  assert.match(row, /--takeover/, 'その行に `--takeover` が無い');
});

test('operations.md「同時に開ける PR の数」：claim はほかのセッションの宣言でも止まり、引き継ぐなら --takeover と書かれている', () => {
  const text = section(operations(), '## 同時に開ける PR の数');
  const line = nonEmptyLines(text).find((l) => l.includes('claim <番号> --manual'));
  assert.ok(line, '`claim <番号> --manual` の箇条が無い');
  assert.match(line, /ほかのセッション/, 'ほかのセッションの宣言で止まることが書かれていない');
  assert.match(line, /--takeover/, '`--takeover` が書かれていない');
  assert.match(line, /--force/, '領域の上限を飛ばす `--force` が消えている');
});

// ---- 用語集 ----

test('glossary.md「付き添いのセッション」：着手は claim <番号> --manual --stage <段階>', () => {
  const text = section(read('docs/glossary.md'), '### 付き添いのセッション');
  assert.match(text, /claim <番号> --manual --stage <段階>/);
});

// ---- 追加の要件：README の表の説明が括弧の途中で切れない ----

/** 全角・半角の丸括弧の開きと閉じの数が釣り合っているか */
function balancedParens(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

test('.claude/hooks/README.md：session-env.ts の行の説明は括弧が閉じている', () => {
  const row = nonEmptyLines(read('.claude/hooks/README.md')).find((l) => l.startsWith('| `session-env.ts` |'));
  assert.ok(row, '`session-env.ts` の行が無い');
  const description = row.split('|')[2] ?? '';
  assert.ok(balancedParens(description), `説明が括弧の途中で切れている：${description.trim()}`);
});

test('.claude/hooks/README.md：生成した表のどの行も、説明の括弧が閉じている', () => {
  const text = read('.claude/hooks/README.md');
  const start = text.indexOf('<!-- readme:generated start -->');
  const end = text.indexOf('<!-- readme:generated end -->');
  assert.ok(start >= 0 && end > start, '生成した表の目印が無い');
  const rows = nonEmptyLines(text.slice(start, end)).filter((l) => l.startsWith('| `'));
  assert.ok(rows.length > 0);
  for (const row of rows) assert.ok(balancedParens(row.split('|')[2] ?? ''), `説明が括弧の途中で切れている：${row}`);
});
