// Issue #183：backlog-scan の決まる部分
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backlogScan, backlogTargets, bodyPaths, fileOverlaps, issueSignals, renderBacklogScan, similarity, similarPairs, SIMILAR_THRESHOLD,
} from '../lib/backlog.ts';
import { appLogin, loadConfig } from '../lib/config.ts';
import type { FleetTargetItem } from '../lib/fleet.ts';

const config = loadConfig();

// GitHub の Issue 一覧の1件（backlogTargets に渡す形。fleet-targets.test.ts と同じ組み立て方）
const item = (n: number, labels: string[], patch: Partial<FleetTargetItem> = {}): FleetTargetItem => ({
  number: n, title: `t${n}`, labels: labels.map((name) => ({ name })), user: { login: 'someone' }, author_association: 'OWNER', ...patch,
});

// Issue Form（parseIssueBody が読める形）の本文
const form = (goal: string, requirements: string[], extra = ''): string =>
  [
    `### Goal\n\n${goal}`,
    '### Background\n\n_No response_',
    `### Requirements\n\n${requirements.map((r) => `- ${r}`).join('\n')}`,
    '### Non-goals\n\n_No response_',
    '### Acceptance Criteria\n\n- [ ] 動く',
    `### Dependencies\n\n${extra || '_No response_'}`,
    '### Validation Requirements\n\n_No response_',
  ].join('\n\n');

const issue = (number: number, title: string, body: string | null, labels: string[] = ['agent:ready']) =>
  ({ number, title, body, labels: labels.map((name) => ({ name })) });

const pairOf = <P extends { issues: [number, number] }>(pairs: P[], a: number, b: number): P[] =>
  pairs.filter((p) => p.issues[0] === a && p.issues[1] === b);

// ---- 対象の選び方 ----

test('backlogTargets：ready・plan-review と、agent:* 無し＋type:* のコラボレーターか App の Issue だけが対象', () => {
  const app = { login: appLogin(config) };
  const cases: [string, FleetTargetItem, boolean][] = [
    ['agent:ready（作成者は問わない）', item(1, ['agent:ready'], { author_association: 'CONTRIBUTOR' }), true],
    ['agent:plan-review', item(2, ['agent:plan-review'], { author_association: 'NONE' }), true],
    ['type:* だけ・OWNER', item(3, ['type:feat'], { author_association: 'OWNER' }), true],
    ['type:* だけ・COLLABORATOR', item(4, ['type:fix'], { author_association: 'COLLABORATOR' }), true],
    ['type:* だけ・App が作った', item(5, ['type:feat'], { author_association: 'CONTRIBUTOR', user: app }), true],
    ['type:* だけ・CONTRIBUTOR', item(6, ['type:feat'], { author_association: 'CONTRIBUTOR' }), false],
    ['type:* だけ・NONE', item(7, ['type:feat'], { author_association: 'NONE' }), false],
    ['PR', item(8, ['agent:ready'], { pull_request: { url: 'x' } }), false],
    ['ダッシュボード', item(9, [], { title: config.dashboardIssueTitle, user: app, author_association: 'CONTRIBUTOR' }), false],
    ['epic＋type:*', item(10, ['epic', 'type:feat']), false],
    ['epic＋agent:ready', item(11, ['epic', 'agent:ready']), false],
    ['agent:plan-ok だけ', item(12, ['agent:plan-ok']), false],
    ['agent:* も type:* も無い・OWNER', item(13, ['area:harness'], { author_association: 'OWNER' }), false],
    ['ラベル無し・OWNER', item(14, [], { author_association: 'OWNER' }), false],
    ['止まる印＋type:*', item(15, ['agent:hold', 'type:feat']), false],
  ];
  for (const [name, it, expected] of cases) {
    assert.deepEqual(backlogTargets([it], config).map((i) => i.number), expected ? [it.number] : [], name);
  }
  // まとめて渡しても、対象だけが元の順で残る
  const all = cases.map(([, it]) => it);
  assert.deepEqual(backlogTargets(all, config).map((i) => i.number), cases.filter(([, , e]) => e).map(([, it]) => it.number));
});

// ---- 本文のパスと、計画の files ----

test('bodyPaths：バッククォートのパスらしい文字列だけを取り、URL・空白を含むもの・パスでないものは取らない', () => {
  const body = [
    '`harness/lib/backlog.ts` と `docs/operations.md` を触る。`README.md` も。',
    '`.claude/skills/backlog/SKILL.md` と `.github/workflows/gate.yml` と `overview.html` と `harness.config.json`',
    '参考：`https://example.com/a/b.md`、`http://example.com/x.ts`',
    '`some dir/with space.ts` と `npm run check` と `agent:ready` と `foo`',
  ].join('\n');
  assert.deepEqual([...new Set(bodyPaths(body))].sort(), [
    '.claude/skills/backlog/SKILL.md', '.github/workflows/gate.yml', 'README.md', 'docs/operations.md',
    'harness.config.json', 'harness/lib/backlog.ts', 'overview.html',
  ]);
});

test('issueSignals：計画の files があればそれを使い出どころは plan。[] でも plan で空、null のときだけ本文から取る', () => {
  const body = form('目的', ['要件'], '`harness/lib/a.ts` を触る');
  const fromPlan = issueSignals(issue(1, 'feat(harness): a', body), ['harness/lib/b.ts']);
  assert.deepEqual([fromPlan.files, fromPlan.filesFrom], [['harness/lib/b.ts'], 'plan']);
  const emptyPlan = issueSignals(issue(1, 'feat(harness): a', body), []);
  assert.deepEqual([emptyPlan.files, emptyPlan.filesFrom], [[], 'plan']);
  const fromBody = issueSignals(issue(1, 'feat(harness): a', body), null);
  assert.deepEqual([fromBody.files, fromBody.filesFrom], [['harness/lib/a.ts'], 'body']);
  assert.equal(fromBody.formOk, true);
  assert.equal(fromBody.goal, '目的');
  assert.deepEqual(fromBody.requirements, ['要件']);
});

test('issueSignals：Form として読めない本文・null の本文でも止まらず、formOk=false で続き、backlogScan の対象に残る', () => {
  const free = issueSignals(issue(7, 'fix(harness): 自由記述', '自由に書いた本文。`harness/lib/x.ts` を直す。#3 の続き'), null);
  assert.equal(free.formOk, false);
  assert.deepEqual(free.requirements, []);
  assert.deepEqual(free.files, ['harness/lib/x.ts']);
  assert.ok(free.mentions.includes(3));
  const none = issueSignals(issue(8, 'fix(harness): 本文なし', null), null);
  assert.equal(none.formOk, false);
  assert.deepEqual(none.files, []);
  const scan = backlogScan([free, none]);
  for (const n of [7, 8]) {
    const t = scan.targets.find((x) => x.number === n);
    assert.ok(t, `#${n} が対象に残る`);
    assert.equal(t.formOk, false, `#${n}`);
  }
});

// ---- 触りそうなファイルの重なり ----

test('fileOverlaps：同じファイル・重なるパターンを挙げた組が出て、相手の番号を挙げていれば mentioned。重ならない組は出ない', () => {
  const signals = [
    issueSignals(issue(10, 'feat(harness): a', form('a', ['a'], '`harness/lib/backlog.ts`')), null),
    issueSignals(issue(11, 'feat(docs): b', form('b', ['b'], '`docs/operations.md`')), null),
    issueSignals(issue(12, 'feat(harness): c', form('c', ['c'], '#10 の後。`harness/lib/*.ts`')), null),
    issueSignals(issue(20, 'feat(harness): d', form('d', ['d'])), ['overview.html']),
    issueSignals(issue(21, 'feat(harness): e', form('e', ['e'])), ['overview.html']),
  ];
  const overlaps = fileOverlaps(signals);

  const glob = pairOf(overlaps, 10, 12);
  assert.equal(glob.length, 1, '#10 と #12（パターンの重なり）は1組だけ、小さい番号が先');
  assert.ok(glob[0]!.paths.length >= 1);
  assert.ok(glob[0]!.paths.flat().includes('harness/lib/backlog.ts') && glob[0]!.paths.flat().includes('harness/lib/*.ts'));
  assert.equal(glob[0]!.mentioned, true, '#12 が #10 を挙げている');

  const same = pairOf(overlaps, 20, 21);
  assert.equal(same.length, 1, '#20 と #21（同じファイル）');
  assert.equal(same[0]!.mentioned, false);

  for (const p of overlaps) assert.ok(!p.issues.includes(11), `#11 は誰とも重ならない（${p.issues.join('-')}）`);
  assert.equal(overlaps.length, 2);
  assert.deepEqual(fileOverlaps(signals.slice(0, 1)), [], '1件なら組は無い');
});

// ---- 似た Issue の組 ----

test('similarity：文字の 2-gram の Jaccard（大文字小文字・空白・記号は無視）', () => {
  assert.equal(similarity('backlog', 'backlog'), 1);
  assert.equal(similarity('Back Log!', 'backlog'), 1);
  assert.equal(similarity('abcd', 'wxyz'), 0);
  assert.equal(similarity('重複を探す', '重なりを出す'), similarity('重なりを出す', '重複を探す'));
  assert.ok(SIMILAR_THRESHOLD > 0 && SIMILAR_THRESHOLD < 1);
});

test('similarPairs：同じ skill・docs を挙げ目的の近い2件は似た組に出て、無関係の Issue との組は出ない', () => {
  const files = ['.claude/skills/backlog/SKILL.md', 'docs/operations.md'];
  const signals = [
    issueSignals(issue(161, 'feat(harness): 開いた Issue の重複を見つける skill を足す',
      form('開いた Issue をまとめて読み、重複と重なりの候補を一覧にする', ['重複の候補を出す', '重なりの候補を出す'])), files),
    issueSignals(issue(177, 'feat(harness): 開いた Issue の重なりを見つける skill を足す',
      form('開いた Issue をまとめて読み、重なりと重複の候補を一覧にする', ['重なりの候補を出す', '重複の候補を出す'])), files),
    issueSignals(issue(190, 'fix(gates): Ruleset の検査で例外を投げない',
      form('ゲートが Ruleset を読めなくても止まらずに理由を残す', ['読めないときは理由を書く'])), ['harness/gates/run.ts']),
  ];
  const pairs = similarPairs(signals);
  const hit = pairOf(pairs, 161, 177);
  assert.equal(hit.length, 1, '#161 と #177 が1組');
  assert.ok(hit[0]!.score >= SIMILAR_THRESHOLD || hit[0]!.requirementScore >= SIMILAR_THRESHOLD);
  for (const p of pairs) assert.ok(!p.issues.includes(190), `無関係の #190 は出ない（${p.issues.join('-')}）`);
  assert.deepEqual(similarPairs(signals.slice(0, 1)), [], '1件なら組は無い');
});

// ---- まとめ（JSON・テキスト） ----

test('backlogScan の JSON のキーは targets・overlaps・similar、renderBacklogScan のテキストに3つの節がある（0件でも）', () => {
  const signals = [
    issueSignals(issue(30, 'feat(harness): x', form('x', ['x'])), ['harness/lib/x.ts']),
    issueSignals(issue(31, 'feat(harness): y', form('y', ['y'], '#30')), ['harness/lib/x.ts']),
  ];
  const scan = backlogScan(signals);
  const json = JSON.parse(JSON.stringify(scan)) as Record<string, unknown>;
  for (const k of ['targets', 'overlaps', 'similar']) assert.ok(Array.isArray(json[k]), `${k} が配列`);
  assert.deepEqual(scan.targets.map((t) => t.number).sort(), [30, 31]);
  assert.equal(pairOf(scan.overlaps, 30, 31).length, 1);

  const text = renderBacklogScan(scan);
  for (const s of ['対象', '重なり', '似た']) assert.ok(text.includes(s), `節「${s}」がある`);
  assert.ok(text.includes('30') && text.includes('31'));

  const empty = renderBacklogScan(backlogScan([]));
  for (const s of ['対象', '重なり', '似た']) assert.ok(empty.includes(s), `0件でも節「${s}」がある`);
});
