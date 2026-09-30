// Issue #415：fleet のペインの並び（左に fleet の Claude、右に上から あなたがすること → 進み具合 → PR と費用）と、閉じる handle の確かめを、fleet の skill と docs/operations.md で検査する
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const WORKER_HEADING = '## Orca の worker として動くとき';
const OPERATIONS = 'docs/operations.md';
const HQ_HEADING = '### hq（テーマごとの fleet をまとめる）';

const RIGHT_ORDER = ['あなたがすること', '進み具合', 'PR と費用'];

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

/** worker の節（無ければ assert で落とす） */
function workerSection(): string {
  const sub = section(read(FLEET_SKILL), WORKER_HEADING);
  assert.ok(sub !== '', `fleet の skill に「${WORKER_HEADING}」の節がありません`);
  return sub;
}

/** 節の中の番号付きの項（「<n>. **<名前>**」で始まる行から、次の番号付きの項の前まで）を切り出す（無ければ assert で落とす） */
function step(sub: string, prefix: string): string {
  const lines = sub.split('\n');
  const start = lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(start >= 0, `「${WORKER_HEADING}」の節に「${prefix}」で始まる項がありません`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. \*\*/.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const step3 = (): string => step(workerSection(), '3. **ペインを作る**');
const step7 = (): string => step(workerSection(), '7. **終わるとき**');

/** 「左に fleet の Claude」を含み、その後の「右に上から」の後に words がこの順で出てくる行を探す */
function findLayoutLine(text: string, words: string[]): string | undefined {
  return text.split('\n').find((l) => {
    if (!l.includes('左に fleet の Claude')) return false;
    const right = l.indexOf('右に上から');
    if (right < 0 || right < l.indexOf('左に fleet の Claude')) return false;
    let at = right;
    for (const w of words) {
      const i = l.indexOf(w, at);
      if (i < 0) return false;
      at = i + w.length;
    }
    return true;
  });
}

// ---- AC1：手順3の並びと作り方 ----

test('fleet の skill：worker の節の手順3に、左に fleet の Claude（縦いっぱい）、右に上から あなたがすること → 進み具合 → PR と費用 の並びが書かれている', () => {
  const s = step3();
  const line = findLayoutLine(s, RIGHT_ORDER);
  assert.ok(line, '手順3に「左に fleet の Claude … 右に上から あなたがすること → 進み具合 → PR と費用」の順の文がありません');
  assert.ok(line.includes('縦いっぱい'), '並びの文に「縦いっぱい」がありません');
});

test('fleet の skill：worker の節の手順3に、terminal split を --direction vertical と --direction horizontal で使う作り方がある', () => {
  const s = step3();
  assert.ok(/ORCA terminal split[^\n`]*--direction vertical/.test(s), '手順3に「ORCA terminal split … --direction vertical」がありません');
  assert.ok(s.includes('--direction horizontal'), '手順3に「--direction horizontal」がありません');
});

test('fleet の skill：worker の節に旧来の「3回分けて」「4ペイン」の書き方が残っていない', () => {
  const sub = workerSection();
  for (const w of ['3回分けて', '4ペイン']) {
    assert.ok(!sub.includes(w), `「${WORKER_HEADING}」の節に「${w}」が残っています`);
  }
});

test('fleet の skill：worker の節の手順3に、panes.ts todo・panes.ts collect・panes.ts prs のコマンドが残っている', () => {
  const s = step3();
  const missing = ['panes.ts todo', 'panes.ts collect', 'panes.ts prs'].filter((w) => !s.includes(w));
  assert.deepEqual(missing, [], `手順3に次のコマンドがありません：${missing.join('、')}`);
});

// ---- AC2：手順7の handle の確かめ ----

test('fleet の skill：worker の節の手順7に、閉じる handle が fleet 自身の Claude の端末の handle と違うことを確かめ、同じなら閉じないことが書かれている', () => {
  const s = step7();
  const line = s.split('\n').find((l) => l.includes('閉じる handle') && l.includes('fleet 自身の Claude') && l.includes('確かめ'));
  assert.ok(line, '手順7に「閉じる handle」「fleet 自身の Claude」「確かめ」を同じ行に含む文がありません');
  assert.ok(s.includes('同じなら閉じない'), '手順7に「同じなら閉じない」がありません');
});

// ---- AC3：docs/operations.md のペインの説明 ----

test('docs/operations.md：hq の節に、fleet のワークスペースのペインが 左に fleet の Claude、右に上から あなたがすること（todo）→ 進み具合（collect）→ PR と費用（prs）の並びで書かれている', () => {
  const sub = section(read(OPERATIONS), HQ_HEADING);
  assert.ok(sub !== '', `docs/operations.md に「${HQ_HEADING}」の節がありません`);
  const line = findLayoutLine(sub, ['あなたがすること', 'panes.ts todo', '進み具合', 'panes.ts collect', 'PR と費用', 'panes.ts prs']);
  assert.ok(line, 'hq の節に「左に fleet の Claude … 右に上から あなたがすること（panes.ts todo）→ 進み具合（panes.ts collect）→ PR と費用（panes.ts prs）」の順の文がありません');
  assert.ok(line.includes('fleet のワークスペースのペイン'), '並びの文に「fleet のワークスペースのペイン」がありません');
});

test('docs/operations.md：hq の節に、fleet 自身の Claude の端末は閉じないことが書かれている', () => {
  const sub = section(read(OPERATIONS), HQ_HEADING);
  assert.ok(sub !== '', `docs/operations.md に「${HQ_HEADING}」の節がありません`);
  assert.ok(sub.includes('fleet 自身の Claude の端末は閉じない'), 'hq の節に「fleet 自身の Claude の端末は閉じない」がありません');
});
