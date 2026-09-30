// Issue #388：test-prune を /loop から回すときの手元の状態（読み書き・回の記録・下書きの検査と重なり・pending・adopt・2回分でたまること）と、skill の回し方の書き方を確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptDraft, pendingDrafts } from '../lib/qa-retro-loop.ts';
import {
  parseTestPruneLoopState, recordTestPruneRound, TEST_PRUNE_LOOP_MAX_DRAFTS, type TestPruneLoopState,
} from '../lib/test-prune-loop.ts';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-30T08:00:00Z');
const later = (h: number, d: Date = NOW): Date => new Date(d.getTime() + h * HOUR);
const SHA = 'c'.repeat(40);

/** test-prune.ts の出力の JSON（version 1）。record が使うのは generatedAt・headSha・files・candidates */
function reportAt(generatedAt: Date, candidates = 0, headSha: string | null = SHA) {
  return {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    headSha,
    files: [],
    candidates: Array.from({ length: candidates }, (_, i) => ({ kind: 'contained', file: `harness/test/x${i + 1}.test.ts`, reasons: [] })),
    notes: [],
  };
}

/** Issue Form の見出し（Goal・Requirements・Acceptance Criteria）を持つ本文（qa-retro-loop.test.ts と同じ形） */
const BODY = ['### Goal', '', '重なるテストを減らす', '', '### Requirements', '', '- 同じ行を確かめるテストを1本にまとめる', '', '### Acceptance Criteria', '', '- [ ] npm run check が通る'].join('\n');
const draft = (patch: Record<string, unknown> = {}) => ({ title: 'test(harness): 重なる patrol のテストをまとめる', body: BODY, ...patch });
const T2 = 'test(harness): 文言を固定するだけのテストを書き直す';
const T3 = 'test(harness): カバレッジの無いテストを消す';

function mustRecord(state: TestPruneLoopState | null, report: unknown, drafts: unknown, at: Date): TestPruneLoopState {
  const r = recordTestPruneRound(state, report, drafts, at);
  assert.ok(r.ok, JSON.stringify(r));
  return r.state;
}

// --- 定数 ---

test('定数：下書きは1回に3件まで', () => {
  assert.equal(TEST_PRUNE_LOOP_MAX_DRAFTS, 3);
});

// --- recordTestPruneRound：回の記録 ---

test('recordTestPruneRound：初回は状態を作り、回を1つ記録する（時刻・集計の時刻・head・候補の数・下書き無し）', () => {
  const report = reportAt(later(-1), 4);
  const s = mustRecord(null, report, undefined, NOW);
  assert.equal(s.version, 1);
  assert.equal(s.rounds.length, 1);
  assert.deepEqual(s.rounds[0], { at: NOW.toISOString(), generatedAt: report.generatedAt, headSha: SHA, candidates: 4, drafts: [], duplicates: [] });
});

test('recordTestPruneRound：headSha が null の集計も記録する', () => {
  assert.equal(mustRecord(null, reportAt(later(-1), 0, null), undefined, NOW).rounds[0]!.headSha, null);
});

test('recordTestPruneRound：下書きが空の配列なら下書き無しの回になる', () => {
  assert.deepEqual(mustRecord(null, reportAt(later(-1)), [], NOW).rounds[0]!.drafts, []);
});

test('recordTestPruneRound：前回の回の generatedAt と同じか古い集計は誤りで、元の状態は変わらない', () => {
  const s1 = mustRecord(null, reportAt(later(-1)), undefined, NOW);
  const before = structuredClone(s1);
  const same = recordTestPruneRound(s1, reportAt(later(-1)), undefined, later(1));
  assert.equal(same.ok, false, '同じ集計を2度記録しています');
  assert.ok(!same.ok && same.errors.length > 0);
  assert.equal(recordTestPruneRound(s1, reportAt(later(-2)), undefined, later(1)).ok, false, '古い集計を記録しています');
  assert.deepEqual(s1, before);
});

test('recordTestPruneRound：集計の JSON の形が違うと誤り（version 1・generatedAt・files・candidates）', () => {
  const good = reportAt(later(-1));
  for (const bad of [
    null, 1, 'x', [], {},
    { ...good, version: 2 },
    { ...good, version: undefined },
    { ...good, generatedAt: undefined },
    { ...good, generatedAt: 'not-a-time' },
    { ...good, files: undefined },
    { ...good, files: {} },
    { ...good, candidates: undefined },
    { ...good, candidates: 3 },
  ]) {
    const r = recordTestPruneRound(null, bad, undefined, NOW);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.ok && r.errors.length > 0, JSON.stringify(bad));
  }
});

test('recordTestPruneRound：成功しても元の状態は変えず、新しい状態を返す', () => {
  const s1 = mustRecord(null, reportAt(later(-1)), [draft()], NOW);
  const before = structuredClone(s1);
  const s2 = mustRecord(s1, reportAt(later(23), 2), [draft({ title: T2 })], later(24));
  assert.deepEqual(s1, before);
  assert.notEqual(s2, s1);
  assert.equal(s2.rounds.length, 2);
  assert.equal(s2.rounds[1]!.candidates, 2);
});

// --- recordTestPruneRound：下書き ---

test('recordTestPruneRound：正しい下書き（3件まで）は created: null で回に記録する', () => {
  const s = mustRecord(null, reportAt(later(-1)), [draft(), draft({ title: T2, duplicateOf: 120 }), draft({ title: T3 })], NOW);
  assert.deepEqual(s.rounds[0]!.drafts, [
    { title: 'test(harness): 重なる patrol のテストをまとめる', body: BODY, created: null },
    { title: T2, body: BODY, duplicateOf: 120, created: null },
    { title: T3, body: BODY, created: null },
  ]);
  assert.deepEqual(s.rounds[0]!.duplicates, []);
});

test('recordTestPruneRound：下書きが4件以上なら誤り', () => {
  const four = [draft(), draft({ title: T2 }), draft({ title: T3 }), draft({ title: 'test(harness): 遅いテストを分ける' })];
  assert.equal(recordTestPruneRound(null, reportAt(later(-1)), four, NOW).ok, false);
});

test('recordTestPruneRound：タイトルが Conventional Commits でない・Issue Form の見出しが欠ける下書きは誤りで、元の状態は変わらない', () => {
  const s1 = mustRecord(null, reportAt(later(-1)), undefined, NOW);
  const before = structuredClone(s1);
  const report = reportAt(later(23));
  assert.equal(recordTestPruneRound(s1, report, [draft({ title: '重なるテストをまとめる' })], later(24)).ok, false, 'タイトル');
  assert.equal(recordTestPruneRound(s1, report, [draft({ body: BODY.split('### Acceptance Criteria')[0] })], later(24)).ok, false, 'Acceptance Criteria');
  assert.equal(recordTestPruneRound(s1, report, [draft({ body: BODY.replace('### Goal', '### Background') })], later(24)).ok, false, 'Goal');
  assert.deepEqual(s1, before);
});

test('recordTestPruneRound：ラベルを持つ下書き（agent:ready を含む）は誤り', () => {
  assert.equal(recordTestPruneRound(null, reportAt(later(-1)), [draft({ labels: ['agent:ready'] })], NOW).ok, false, 'agent:ready');
  assert.equal(recordTestPruneRound(null, reportAt(later(-1)), [draft({ labels: ['type:test'] })], NOW).ok, false, 'ほかのラベル');
});

test('recordTestPruneRound：下書きが配列でない・中身の形が違うと誤り', () => {
  assert.equal(recordTestPruneRound(null, reportAt(later(-1)), draft(), NOW).ok, false);
  assert.equal(recordTestPruneRound(null, reportAt(later(-1)), [{ body: BODY }], NOW).ok, false);
});

test('recordTestPruneRound：すでに状態にある未採用の下書きと同じタイトルは記録せず、duplicates に入る', () => {
  const s1 = mustRecord(null, reportAt(later(-1)), [draft()], NOW);
  const s2 = mustRecord(s1, reportAt(later(23)), [draft(), draft({ title: T2 })], later(24));
  assert.deepEqual(s2.rounds[1]!.drafts.map((d) => d.title), [T2]);
  assert.deepEqual(s2.rounds[1]!.duplicates, ['test(harness): 重なる patrol のテストをまとめる']);
  assert.equal(pendingDrafts(s2).total, 2, '同じ下書きが2回たまっています');
});

test('recordTestPruneRound：採用済みの下書きと同じタイトルも記録せず、duplicates に入る（前の前の回でも）', () => {
  const s1 = mustRecord(null, reportAt(later(-1)), [draft()], NOW);
  const adopted = adoptDraft(s1, 1, 1, 500);
  assert.ok(adopted.ok, JSON.stringify(adopted));
  const s2 = mustRecord(adopted.state, reportAt(later(23)), [draft({ title: T2 })], later(24));
  const s3 = mustRecord(s2, reportAt(later(47)), [draft(), draft({ title: T3 })], later(48));
  assert.deepEqual(s3.rounds[2]!.drafts.map((d) => d.title), [T3]);
  assert.deepEqual(s3.rounds[2]!.duplicates, ['test(harness): 重なる patrol のテストをまとめる']);
  assert.equal(s3.rounds[0]!.drafts[0]!.created, 500, '採用の記録が消えています');
});

// --- pending・adopt（qa-retro-loop の関数を test-prune の状態で使う） ---

/** 1回目に2件、2回目に1件の下書きがある状態（/loop の2回分） */
function twoRounds(): TestPruneLoopState {
  const s1 = mustRecord(null, reportAt(later(-1), 3), [draft(), draft({ title: T2, duplicateOf: 120 })], NOW);
  return mustRecord(s1, reportAt(later(23), 1), [draft({ title: T3 })], later(24));
}

test('2回分：1回目・2回目の record で回が2つになり、pending に両方の回の未採用が番号つきで並ぶ', () => {
  const s = twoRounds();
  assert.equal(s.rounds.length, 2);
  assert.deepEqual(s.rounds.map((r) => r.candidates), [3, 1]);
  const p = pendingDrafts(s);
  assert.equal(p.total, 3);
  assert.equal(p.adopted, 0);
  assert.deepEqual(p.pending.map((x) => [x.round, x.draft, x.title]), [
    [1, 1, 'test(harness): 重なる patrol のテストをまとめる'],
    [1, 2, T2],
    [2, 1, T3],
  ]);
  assert.equal(p.pending[1]!.duplicateOf, 120);
  assert.equal(p.pending[0]!.body, BODY);
});

test('pendingDrafts：状態が無ければ空', () => {
  assert.deepEqual(pendingDrafts(null), { pending: [], total: 0, adopted: 0 });
});

test('adoptDraft：選んだ下書きだけ created に Issue 番号が入り、未採用から外れる。元の状態は変わらない', () => {
  const state = twoRounds();
  const before = structuredClone(state);
  const r = adoptDraft(state, 1, 2, 400);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.state.rounds[0]!.drafts[1]!.created, 400);
  assert.equal(r.state.rounds[0]!.drafts[0]!.created, null, '選んでいない下書きまで採用されています');
  assert.equal(r.state.rounds[1]!.drafts[0]!.created, null, '選んでいない下書きまで採用されています');
  assert.deepEqual(state, before);
  const p = pendingDrafts(r.state);
  assert.equal(p.total, 3);
  assert.equal(p.adopted, 1);
  assert.deepEqual(p.pending.map((x) => [x.round, x.draft]), [[1, 1], [2, 1]]);
  // 採用した状態を状態のファイルに書いて読み戻せる（test-prune の回の形のまま）
  const read = parseTestPruneLoopState(JSON.stringify(r.state, null, 2));
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual(read.state, r.state);
});

test('adoptDraft：採用済みの下書きをもう一度採用すると誤り', () => {
  const r = adoptDraft(twoRounds(), 2, 1, 401);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(adoptDraft(r.state, 2, 1, 402).ok, false);
});

test('adoptDraft：回・下書きの番号が範囲外、Issue 番号が正の整数でないと誤り', () => {
  const state = twoRounds();
  for (const [round, d] of [[0, 1], [3, 1], [1, 0], [1, 3], [2, 2]] as const) {
    assert.equal(adoptDraft(state, round, d, 400).ok, false, `${round}-${d}`);
  }
  for (const issue of [0, -1, 1.5]) assert.equal(adoptDraft(state, 1, 1, issue).ok, false, `issue=${issue}`);
});

// --- parseTestPruneLoopState ---

test('parseTestPruneLoopState：ファイルが無ければ（null）状態無しとして読む', () => {
  assert.deepEqual(parseTestPruneLoopState(null), { ok: true, state: null });
});

test('parseTestPruneLoopState：record が作った状態を JSON にして読み戻せる', () => {
  const s1 = mustRecord(null, reportAt(later(-1)), [draft()], NOW);
  const state = mustRecord(s1, reportAt(later(23), 0, null), [draft(), draft({ title: T2 })], later(24));
  const r = parseTestPruneLoopState(JSON.stringify(state, null, 2));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.state, state);
});

test('parseTestPruneLoopState：壊れた JSON・version が 1 でない・形の誤りは誤りとして読む', () => {
  const round = { at: NOW.toISOString(), generatedAt: NOW.toISOString(), headSha: SHA, candidates: 0, drafts: [], duplicates: [] };
  for (const text of [
    '{',
    '',
    JSON.stringify([]),
    JSON.stringify(null),
    JSON.stringify({ version: 2, rounds: [] }),
    JSON.stringify({ rounds: [] }),
    JSON.stringify({ version: 1, rounds: {} }),
    JSON.stringify({ version: 1, rounds: [{ ...round, at: 1 }] }),
    JSON.stringify({ version: 1, rounds: [{ ...round, generatedAt: 'x' }] }),
    JSON.stringify({ version: 1, rounds: [{ ...round, candidates: -1 }] }),
    JSON.stringify({ version: 1, rounds: [{ ...round, drafts: {} }] }),
    JSON.stringify({ version: 1, rounds: [{ ...round, drafts: [{ title: 1, body: BODY, created: null }] }] }),
    JSON.stringify({ version: 1, rounds: [{ ...round, duplicates: 'x' }] }),
  ]) {
    const r = parseTestPruneLoopState(text);
    assert.equal(r.ok, false, text);
    assert.ok(!r.ok && r.errors.length > 0, text);
  }
});

// --- skill ---

const root = join(import.meta.dirname, '..', '..');
const readRoot = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const skill = (): string => readRoot('.claude', 'skills', 'test-prune', 'SKILL.md');

/** 見出しから次の同じ深さの見出しまでの本文。見出しが無ければ null（qa-retro-loop.test.ts と同じ） */
function section(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** skill が使う test-prune-loop.ts のサブコマンド */
const usedLoopCommands = (text: string): string[] => [...text.matchAll(/node harness\/scripts\/test-prune-loop\.ts ([a-z][\w-]*)/g)].map((m) => m[1]!);

/** harness/scripts/test-prune-loop.ts の先頭の使い方のコメントに書かれたサブコマンド */
function documentedLoopCommands(): Set<string> {
  const src = readRoot('harness', 'scripts', 'test-prune-loop.ts');
  const doc = src.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
  return new Set(usedLoopCommands(doc));
}

const loopSection = (): string => {
  const body = section(skill(), '## /loop で回すとき');
  assert.ok(body !== null, 'SKILL.md に「## /loop で回すとき」がありません');
  return body;
};

test('skill：入力に --loop がある', () => {
  const body = section(skill(), '## 入力');
  assert.ok(body !== null, '「## 入力」がありません');
  assert.ok(body.includes('--loop'), '「## 入力」に --loop がありません');
});

test('skill：/loop で回すときの節に、間隔（/loop <間隔> /test-prune --loop）と止め方がある', () => {
  const body = loopSection();
  assert.match(body, /\/loop\s+\S+\s+\/test-prune --loop/, '`/loop 1d /test-prune --loop` の形の書き方がありません');
  assert.ok(body.includes('止め方'), '「止め方」がありません');
});

test('skill：/loop で回すときの節で、test-prune-loop.ts の record・pending・adopt を使う', () => {
  const used = new Set(usedLoopCommands(loopSection()));
  for (const sub of ['record', 'pending', 'adopt']) assert.ok(used.has(sub), `node harness/scripts/test-prune-loop.ts ${sub} がありません`);
});

test('skill：ループの回では AskUserQuestion を呼ばず、gh issue create もしないと書かれている', () => {
  const lines = loopSection().split('\n');
  assert.ok(lines.some((l) => l.includes('AskUserQuestion') && l.includes('呼ばない')), '「AskUserQuestion」と「呼ばない」を同じ行に含む行がありません');
  assert.ok(lines.some((l) => l.includes('gh issue create') && l.includes('しない')), '「gh issue create」と「しない」を同じ行に含む行がありません');
});

test('skill：/loop で回すときの節から docs/operations.md へリンクしている', () => {
  assert.match(loopSection(), /\]\([^)]*docs\/operations\.md[^)]*\)/, 'docs/operations.md へのリンクがありません');
});

test('skill：やってはいけないことに、無人の定期 Routine を動かさない規則が残り、/loop を許す文がある', () => {
  const body = section(skill(), '## やってはいけないこと');
  assert.ok(body !== null, '「## やってはいけないこと」がありません');
  assert.ok(body.includes('無人の定期 Routine'), '「無人の定期 Routine」がありません');
  assert.ok(body.includes('/loop'), '/loop を許す文がありません');
});

test('skill：description に「test-prune の下書きを選ぶ」がある', () => {
  const fm = frontmatter(skill());
  assert.ok((fm.description ?? '').includes('test-prune の下書きを選ぶ'), `description: ${fm.description}`);
});

test('skill が使う test-prune-loop.ts のサブコマンドは、スクリプトの使い方のコメントに実在する', () => {
  const known = documentedLoopCommands();
  for (const sub of ['record', 'pending', 'adopt']) assert.ok(known.has(sub), `test-prune-loop.ts の使い方のコメントに ${sub} がありません`);
  const used = usedLoopCommands(skill());
  assert.ok(used.length > 0, 'SKILL.md が test-prune-loop.ts を使っていません');
  for (const sub of used) assert.ok(known.has(sub), `test-prune-loop.ts ${sub} は使い方のコメントにありません`);
});

test('harness/CLAUDE.harness.md の skill の表の test-prune の行に /loop がある', () => {
  const row = readRoot('harness', 'CLAUDE.harness.md').split('\n').find((l) => l.startsWith('| [test-prune](../.claude/skills/test-prune/SKILL.md) |'));
  assert.ok(row, 'test-prune の行がありません');
  assert.ok(row.includes('/loop'), `test-prune の行に /loop がありません: ${row}`);
});
