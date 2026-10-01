// Issue #430：Orca の terminal split の向き（Orca 1.4.216 では orca-cli の案内と逆で、`vertical` で左右・`horizontal` で上下）と、
// 分けた後にペインの木（--include-visual-layouts）で並びを確かめて違えば分け直す手順が、fleet の手順3・hq の手順6・
// harness/CLAUDE.harness.md の Orca の項に書かれ、fleet の作り方と作り直しが右の列を上から 進み具合 → あなたがすること → PR と費用 に
// 保つこと、docs/operations.md の hq のペインが上から Epic/Issue → 人待ち → ログ の順であることを確かめる。
// 並びの文（「左に fleet の Claude … 右に上から」）と docs の fleet のペインの順は fleet-panes-skill.test.ts が見るので、ここでは見ない。
// 語句は要点ごとに少なく絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const HQ_SKILL = '.claude/skills/hq/SKILL.md';
const HARNESS_RULES = 'harness/CLAUDE.harness.md';
const OPERATIONS = 'docs/operations.md';
const WORKER_HEADING = '## Orca の worker として動くとき';
const HQ_HEADING = '### hq（テーマごとの fleet をまとめる）';

/** 見出しの行（前方一致）から、同じか上の階層の次の見出しの前までを切り出す（無ければ assert で落とす） */
function section(text: string, heading: string, what: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  assert.ok(start >= 0, `${what}に「${heading}」の節がありません`);
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** prefix で始まる行から、次の番号付きの項（行頭が `<n>. `）か見出しの前までを切り出す（無ければ assert で落とす） */
function item(text: string, prefix: string, what: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(start >= 0, `${what}に「${prefix}」で始まる項がありません`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || /^#+ /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const fleetStep3 = (): string =>
  item(section(read(FLEET_SKILL), WORKER_HEADING, 'fleet の skill'), '3. **ペインを作る**', 'fleet の worker の節');
const hqStep6 = (): string => item(read(HQ_SKILL), '6. ', 'hq の skill');

/** text の中で、行頭（字下げを除く）が prefix の行を探す（無ければ assert で落とす） */
function lineStarting(text: string, prefix: string, what: string): string {
  const line = text.split('\n').find((l) => l.trimStart().startsWith(prefix));
  assert.ok(line, `${what}に「${prefix}」で始まる行がありません`);
  return line;
}

/** 語句が text の中にこの順で出てくることを確かめる（前の語句の後ろから次を探す） */
function assertOrder(text: string, words: string[], what: string): void {
  let at = 0;
  for (const w of words) {
    const i = text.indexOf(w, at);
    assert.ok(i >= 0, `${what}：「${w}」が前の語句の後ろにありません（順：${words.join(' → ')}）`);
    at = i + w.length;
  }
}

function assertWords(text: string, words: string[], what: string): void {
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

const VERTICAL_IS_LEFT_RIGHT = /vertical`?\s*で左右/;
const OLD_SWAP = /逆なら[^\n。]*入れ替える/;

// ---- AC1：fleet の手順3の作り方と作り直し ----

test('fleet の手順3：作り方が --direction vertical で右に分け、--direction horizontal で上下に分けて、上から 進み具合 → あなたがすること → PR と費用 にする', () => {
  const line = lineStarting(fleetStep3(), '- 作り方', 'fleet の手順3');
  assertWords(line, ['--direction vertical', '--direction horizontal'], 'fleet の手順3の作り方');
  assertOrder(line, ['--direction vertical', '進み具合', 'あなたがすること', 'PR と費用'], 'fleet の手順3の作り方');
});

test('fleet の手順3：対象の Issue が変わったら、進み具合のペインを閉じずに --interrupt で止めて collect を送り直し、だめなら作り方からやり直す', () => {
  const line = lineStarting(fleetStep3(), '- 対象の Issue が変わったら', 'fleet の手順3');
  assertWords(line, ['進み具合', '--interrupt', 'collect', '作り方'], 'fleet の手順3の作り直しの項');
  assert.ok(!line.includes('進み具合のペインを閉じ、'), 'fleet の手順3の作り直しの項に、旧い「進み具合のペインを閉じ、」が残っています');
});

// ---- AC2：fleet と hq の向きの注意と、分けた後の確かめ ----

for (const [name, get] of [['fleet の手順3', fleetStep3], ['hq の手順6', hqStep6]] as const) {
  test(`${name}：Orca 1.4.216 では案内と向きが逆で、vertical で左右に分かれることが書かれている`, () => {
    const s = get();
    assertWords(s, ['1.4.216', '案内', '逆'], name);
    assert.ok(VERTICAL_IS_LEFT_RIGHT.test(s), `${name}に「vertical で左右」がありません`);
  });

  test(`${name}：分けた後に --include-visual-layouts で並びを確かめ、違えば分け直す`, () => {
    const s = get();
    const line = s.split('\n').find((l) => l.includes('--include-visual-layouts'));
    assert.ok(line, `${name}に「--include-visual-layouts」がありません`);
    assert.ok(/違えば/.test(line) && /分け直す|やり直す/.test(line), `${name}の確かめの行に「違えば … 分け直す（やり直す）」がありません`);
  });

  test(`${name}：旧い「逆なら入れ替える」「ORCA skills get orchestration の案内で確かめる」が残っていない`, () => {
    const s = get();
    assert.ok(!OLD_SWAP.test(s), `${name}に「逆なら … 入れ替える」が残っています`);
    assert.ok(!s.includes('ORCA skills get orchestration'), `${name}に「ORCA skills get orchestration」が残っています`);
  });
}

// ---- AC3：harness/CLAUDE.harness.md の Orca の項 ----

test('harness/CLAUDE.harness.md：Orca の項（起動と監視・orca-cli の行）に、split の向き（--direction）は vertical で左右とする扱いがある', () => {
  const line = read(HARNESS_RULES).split('\n').find((l) => l.includes('起動と監視') && l.includes('orca-cli'));
  assert.ok(line, 'harness/CLAUDE.harness.md に「起動と監視」と「orca-cli」を含む行がありません');
  assert.ok(line.includes('--direction'), 'Orca の項の行に「--direction」がありません');
  assert.ok(VERTICAL_IS_LEFT_RIGHT.test(line), 'Orca の項の行に「vertical で左右」がありません');
});

// ---- AC4：docs/operations.md の hq のペインの並び ----

test('docs/operations.md：hq の節で、hq のペインが真ん中の列に上から Epic/Issue（hq board）→ 人待ち（hq todo）→ ログ（hq log）の順', () => {
  const sub = section(read(OPERATIONS), HQ_HEADING, 'docs/operations.md');
  const line = sub.split('\n').find((l) => l.includes('hq のワークスペース') && l.includes('真ん中の列'));
  assert.ok(line, 'hq の節に「hq のワークスペース」と「真ん中の列」を含む行がありません');
  assertOrder(line.slice(line.indexOf('真ん中の列')), [
    'Epic/Issue', 'panes.ts hq board', '人待ち', 'panes.ts hq todo', 'ログ', 'panes.ts hq log',
  ], 'docs/operations.md の hq のペインの並び');
});
