// Issue #199（人の決定 2026-09-30）：fleet の SKILL.md の節「待つ間の読み直し」（fleet-status --watch を間隔ごとに読み直す・schedule を使わない・
// 次にやることや Merge 後の見届けで ship を呼び直す・自分の PR が sync なら Merge 待ちでも呼び直す・App が動かないときに1回だけ知らせる・
// 受け持つ Epic の Close か人の判断待ちだけが残ったときに終える）、ship の Merge 済みで呼び直されたときの手順、/clear の後の宣言を1問で聞く手順、
// fleet-status.ts が --watch のときだけ updateWatch を呼ぶこと。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentSourceFiles } from './support/agent-source.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const SHIP_SKILL = '.claude/skills/ship/SKILL.md';
const WATCH = '## 待つ間の読み直し';
const FLEET_STATUS = 'harness/scripts/agent/commands/fleet-status.ts';

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

function mustSection(path: string, heading: string): string {
  const sub = section(read(path), heading);
  assert.ok(sub !== '', `${path} に「${heading}」の節がありません`);
  return sub;
}

/** 番号付きの項目（行頭の `<n>. `）から、次の同じ深さの番号付きの項目の前まで（入れ子の行を含む） */
function item(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || /^#+ /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

function assertWords(where: string, text: string, words: string[]): void {
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${where} に次の語句がありません：${missing.join('、')}`);
}

function lineWith(text: string, words: (string | RegExp)[]): string | undefined {
  return text.split('\n').find((l) => words.every((w) => (typeof w === 'string' ? l.includes(w) : w.test(l))));
}

const watch = (): string => mustSection(FLEET_SKILL, WATCH);
/** 「人の判断待ちだけが残った（残っている）」 */
const ONLY_HUMAN = /人の判断待ちだけが残/;

// ---- 読み直しの回し方 ----

test('待つ間の読み直し：全部が待つか人の Merge 待ちになったら、手順8の一覧の後も終わらずに fleet-status --watch を間隔ごとに読み直す', () => {
  const sub = watch();
  assertWords('待つ間の読み直し', sub, ['node harness/scripts/agent.ts fleet-status --watch', 'human-merge', 'auto-merge', '手順8']);
  assert.ok(lineWith(sub, ['間隔']), '間隔ごとに読み直す文がありません');
});

test('待つ間の読み直し：付き添いのセッションの中の道具（run_in_background の until ループ・Monitor）で待ち、schedule・Actions・Routine は使わない', () => {
  const sub = watch();
  assertWords('待つ間の読み直し', sub, ['run_in_background', 'Monitor']);
  assert.ok(lineWith(sub, ['schedule', 'Actions', 'Routine', '使わない']), 'schedule・Actions・Routine を使わない文（同じ行）がありません');
});

test('待つ間の読み直し：読み直すたびに交代の行（このセッションの読み込みは古い）もここで見る', () => {
  assertWords('待つ間の読み直し', watch(), ['このセッションの読み込みは古い', 'ハーネスが更新されたときの交代']);
});

// ---- ship の呼び直し ----

test('待つ間の読み直し：次にやること（plan-ok・fix など）や「Merge 後の見届けが済んでいない」の行が出たら、その Issue の ship を呼び直す', () => {
  const sub = watch();
  assertWords('待つ間の読み直し', sub, ['plan-ok', 'Merge 後の見届けが済んでいない']);
  assert.ok(lineWith(sub, ['Merge 後の見届けが済んでいない', '呼び直']) ?? lineWith(sub, ['plan-ok', '呼び直']), 'ship を呼び直す文がありません');
});

test('待つ間の読み直し：自分の行の次にやることが sync なら、human-merge・auto-merge でも ship をすぐ呼び直し、fleet 自身は衝突を直さない。ほかのセッションの PR は対象にしない', () => {
  const sub = watch();
  assert.ok(lineWith(sub, ['sync', 'human-merge', 'auto-merge', '呼び直']), 'sync なら Merge 待ちでも ship を呼び直す文（同じ行）がありません');
  assertWords('待つ間の読み直し', sub, ['fleet 自身は衝突を直さない', 'ほかのセッション']);
});

test('待つ間の読み直し：ship が「Close されていない」で返した Issue は人の判断待ちにして呼び直し続けない。印はセッションの中で持ち、見張りの記録には残さない。交代の後の新しい fleet は最初の1回だけ呼び直す', () => {
  const sub = watch();
  assertWords('待つ間の読み直し', sub, ['Close されていない', '見張りの記録には残さない', '最初の1回だけ', '人の判断待ちに数える']);
  assert.ok(lineWith(sub, ['Close されていない', '呼び直さない']), '同じ行が出続けても呼び直さない文がありません');
});

// ---- App が動かないときの知らせ ----

test('待つ間の読み直し：「App が動いていない」の知らせが出たら人に知らせ（worker では hq に escalation）、同じ行は1回だけで読み直しを続ける', () => {
  const sub = watch();
  assertWords('待つ間の読み直し', sub, ['App が動いていない', 'escalation', '1回だけ']);
});

// ---- 受け持つ Epic と終わり方 ----

test('fleet の入力：受け持つ Epic は --epic で渡すか、子課題の印（parseChildMarker）の親が全部同じならその Epic。親が複数・無いなら Epic は無いとして扱う', () => {
  const sub = mustSection(FLEET_SKILL, '## 入力');
  assertWords('fleet の入力', sub, ['--epic <Epic番号>', 'parseChildMarker']);
  assert.ok(lineWith(sub, ['parseChildMarker', '複数', /Epic (は|が)無い/]), '印の親が複数・無いときは Epic が無いとして扱う文（同じ行）がありません');
});

test('fleet の入力：/fleet --epic <Epic番号> <番号…> の形がある', () => {
  assertWords('fleet の入力', mustSection(FLEET_SKILL, '## 入力'), ['/fleet --epic <Epic番号> <番号…>']);
});

test('交代の1行：受け持つ Epic があれば /fleet --epic <Epic番号> <番号…> で新しい fleet に同じ Epic を渡す', () => {
  assertWords('fleet の交代の節', mustSection(FLEET_SKILL, '## ハーネスが更新されたときの交代'), ['/fleet --epic <Epic番号> <番号…>']);
});

test('待つ間の読み直し：受け持つ Epic が Close したとき（gh issue view <Epic番号> --json state）と、人の判断待ちだけが残ったときに終える。Epic が無い fleet は全部 Merge 済みか人の判断待ちで終える', () => {
  const sub = watch();
  assertWords('待つ間の読み直し', sub, ['gh issue view <Epic番号> --json state', 'Merge 済み']);
  assert.match(sub, ONLY_HUMAN, '人の判断待ちだけが残ったときに終える文がありません');
});

test('fleet の手順5：手順8の一覧を出した後に「待つ間の読み直し」へ進む', () => {
  const step5 = item(mustSection(FLEET_SKILL, '## 手順'), 5);
  assert.ok(step5 !== '', '手順5がありません');
  assertWords('fleet の手順5', step5, ['待つ間の読み直し']);
});

test('fleet の入れ子の方式の手順3：手順8の一覧を出した後に「待つ間の読み直し」へ進む', () => {
  const step3 = item(mustSection(FLEET_SKILL, '## 入れ子の方式'), 3);
  assert.ok(step3 !== '', '入れ子の方式の手順3がありません');
  assertWords('入れ子の方式の手順3', step3, ['待つ間の読み直し']);
});

test('fleet の人に返す条件：全部が待つ状態で返すのは人の判断待ちだけが残ったときに限り、App・CI 待ち・人の Merge 待ちが残る間は読み直しを続ける', () => {
  const sub = mustSection(FLEET_SKILL, '## 人に返す条件');
  assert.ok(lineWith(sub, [ONLY_HUMAN, /読み直し」?を続ける/]), '人の判断待ちだけが残ったときに限り、ほかは読み直しを続ける文（同じ行）がありません');
  assert.equal(lineWith(sub, [/^- 選んだ Issue が全部待つ状態になった$/]), undefined, '条件の付かない「全部待つ状態になった」が残っています');
});

test('fleet の worker の節7（終わるとき）：worker_done を送るのは、受け持つ Epic の Close か人の判断待ちだけが残ったとき', () => {
  const step7 = item(mustSection(FLEET_SKILL, '## Orca の worker として動くとき'), 7);
  assert.ok(step7 !== '', 'worker の節の7がありません');
  assertWords('worker の節7', step7, ['worker_done', '受け持つ Epic', 'check']);
  assert.match(step7, ONLY_HUMAN);
});

test('fleet の終わりの状態：受け持つ Epic の Close か人の判断待ちだけが残った（人の Merge 待ちでは終わらない）', () => {
  const sub = mustSection(FLEET_SKILL, '## 終わりの状態');
  assertWords('fleet の終わりの状態', sub, ['受け持つ Epic', 'Close']);
  assert.match(sub, ONLY_HUMAN);
});

// ---- ship：Merge 済みで呼び直されたとき ----

test('ship：Merge 済みの PR で呼び直されたら、worktree-remove で片付け、gh issue view <番号> --json state で Close を見届けて返す。何度呼ばれても同じ結果', () => {
  const ship = read(SHIP_SKILL);
  assertWords('ship の SKILL.md', ship, ['worktree-remove', 'gh issue view <番号> --json state', '何度呼ばれても']);
  const step1 = item(mustSection(SHIP_SKILL, '## 手順'), 1);
  assert.ok(lineWith(step1, ['Merge 済み']), '手順1に Merge 済みの PR で呼び直されたときの行がありません');
  assertWords('ship の手順1', step1, ['worktree-remove', 'gh issue view <番号> --json state']);
  assert.ok(lineWith(mustSection(SHIP_SKILL, '## サブエージェントの ship として動くとき'), ['Merge 済み', '呼び直']), 'サブエージェントの節に Merge 済みで呼び直されたときの項がありません');
});

test('ship：返すものの終わった状態に「Merge 後の見届け済み（Close 済み）」「Close されていない」がある', () => {
  const sub = mustSection(SHIP_SKILL, '## サブエージェントの ship として動くとき');
  const line = lineWith(sub, ['返すもの']);
  assert.ok(line, '返すものの行がありません');
  assertWords('ship の返すもの', line, ['Merge 後の見届け済み', 'Close されていない']);
});

test('ship：Validation Requirements のうちセッションで確かめられるもの（npm run check など）は ship が行い、人にしかできないものだけを人がすることにする', () => {
  const ship = read(SHIP_SKILL);
  assert.ok(lineWith(ship, ['Validation Requirements', 'npm run check']), 'セッションで確かめられる Validation Requirements を ship が行う文がありません');
});

// ---- /clear の後の宣言を1問で聞く ----

test('ship・fleet の手順1：/clear の後は前のセッションの宣言を1件ずつ聞かず、まとめて1問で聞き、引き継ぐなら全部を --takeover で出し直す', () => {
  for (const path of [SHIP_SKILL, FLEET_SKILL]) {
    const step1 = item(mustSection(path, '## 手順'), 1);
    assert.ok(step1 !== '', `${path} の手順1がありません`);
    const line = lineWith(step1, ['/clear', '1問']);
    assert.ok(line, `${path} の手順1に /clear の後の宣言を1問で聞く文（同じ行に /clear と 1問）がありません`);
    assertWords(`${path} の手順1`, line, ['1件ずつ', '--takeover', 'AskUserQuestion']);
  }
});

// ---- fleet-status.ts の --watch ----

test('fleet-status.ts：--watch を splitArgs の前に取り除き、使い方に [--watch] があり、--watch のときだけ updateWatch を呼ぶ', () => {
  assert.ok(agentSourceFiles().includes(FLEET_STATUS));
  const src = read(FLEET_STATUS);
  assert.ok(src.includes('[--watch]'), '使い方に [--watch] がありません');
  assert.ok(src.includes("'--watch'"), '--watch を読んでいません');
  const calls = [...src.matchAll(/updateWatch\(/g)].map((m) => m.index!);
  assert.ok(calls.length > 0, 'updateWatch を呼んでいません');
  /** --watch の分岐（watch・watchCfg などの変数の if・三項・&&）の直後か */
  const guarded = (before: string): boolean => /if \(\s*watch\w*\b[^)]*\)\s*\{[^}]*$|\bwatch\w*\s*(\?|&&)\s*[^\n]*$/.test(before);
  for (const i of calls) {
    if (guarded(src.slice(Math.max(0, i - 600), i))) continue;
    // 補助の関数の中で呼ぶなら、その関数を呼ぶ所がすべて --watch の分岐の中にあること
    const fn = [...src.slice(0, i).matchAll(/function (\w+)\(/g)].at(-1)?.[1];
    assert.ok(fn, 'updateWatch が --watch の分岐の中にありません');
    const sites = [...src.matchAll(new RegExp(`(?<!function )\\b${fn}\\(`, 'g'))].map((m) => m.index!);
    assert.ok(sites.length > 0, `${fn} を呼ぶ所がありません`);
    for (const s of sites) {
      const lineStart = src.lastIndexOf('\n', s) + 1;
      assert.ok(guarded(src.slice(Math.max(0, s - 600), s)) || guarded(src.slice(lineStart, s)), `${fn}（updateWatch を呼ぶ）が --watch の分岐の外で呼ばれています`);
    }
  }
  for (const w of ['pendingFollowUps(', 'fleetWatchConfig(', '--porcelain', 'watchRecordPath(']) assert.ok(src.includes(w), `fleet-status.ts に ${w} がありません`);
});
