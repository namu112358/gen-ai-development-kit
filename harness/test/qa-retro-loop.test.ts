// Issue #329：qa-retro を /loop から回すときの期間のつなぎ方（状態のファイル・前回の終わりからの期間・下書きの記録と採用）と、skill・docs の回し方の書き方を確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitHub, HttpError } from '../lib/github.ts';
import { collectQaRetro } from '../lib/qa-retro.ts';
import {
  adoptDraft, advanceLoopState, loopPeriod, parseLoopState, pendingDrafts,
  QA_RETRO_LOOP_FIRST_DAYS, QA_RETRO_LOOP_LAG_DAYS, QA_RETRO_LOOP_MAX_DRAFTS, type LoopState,
} from '../lib/qa-retro-loop.ts';
import { APP, config, FakeGitHub } from './support/gate-fixtures.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-29T08:30:00Z');
const daysBefore = (d: Date, n: number): Date => new Date(d.getTime() - n * DAY);
const iso = (d: Date): string => d.toISOString();

/** 集計の JSON（QaRetroData の形。advance が使うのは period と prs） */
function dataFor(since: Date, until: Date, prs: unknown[] = []) {
  return {
    period: { since: iso(since), until: iso(until) },
    prs,
    followups: [],
    byRisk: {},
    flakyCi: [],
    notes: { unreadableLogs: 0, unreadableMetrics: 0, truncated: [] },
  };
}

/** 初回の期間（状態が無いとき）の集計の JSON */
const firstData = (now: Date = NOW) => {
  const p = loopPeriod(null, now);
  return dataFor(p.since, p.until);
};

const stateWith = (until: string, rounds: LoopState['rounds'] = []): LoopState => ({ version: 1, until, rounds });

/** Issue Form の見出し（Goal・Requirements・Acceptance Criteria）を持つ本文 */
const BODY = ['### Goal', '', '不安定なテストを直す', '', '### Requirements', '', '- 待ち時間を固定しない', '', '### Acceptance Criteria', '', '- [ ] 10回続けて通る'].join('\n');
const draft = (patch: Record<string, unknown> = {}) => ({ title: 'test(harness): 不安定なテストの待ち時間を直す', body: BODY, ...patch });

function mustAdvance(state: LoopState | null, data: unknown, drafts: unknown, at: Date): LoopState {
  const r = advanceLoopState(state, data, drafts, at);
  assert.ok(r.ok, JSON.stringify(r));
  return r.state;
}

// --- 定数 ---

test('定数：下書きは3件まで、終わりは7日前、初回は14日分', () => {
  assert.equal(QA_RETRO_LOOP_MAX_DRAFTS, 3);
  assert.equal(QA_RETRO_LOOP_LAG_DAYS, 7);
  assert.equal(QA_RETRO_LOOP_FIRST_DAYS, 14);
});

// --- loopPeriod ---

test('loopPeriod：状態が無ければ [今-21日, 今-7日) で、初回として扱う', () => {
  const p = loopPeriod(null, NOW);
  assert.equal(iso(p.since), '2026-09-08T08:30:00.000Z');
  assert.equal(iso(p.until), '2026-09-22T08:30:00.000Z');
  assert.equal(p.first, true);
  assert.equal(p.empty, false);
});

test('loopPeriod：状態があれば [状態の until, 今-7日) で、初回ではない', () => {
  const p = loopPeriod(stateWith('2026-09-20T00:00:00.000Z'), NOW);
  assert.equal(iso(p.since), '2026-09-20T00:00:00.000Z');
  assert.equal(iso(p.until), '2026-09-22T08:30:00.000Z');
  assert.equal(p.first, false);
  assert.equal(p.empty, false);
});

test('loopPeriod：始まりが終わりと同じか後なら empty（前回から7日たっていない回）', () => {
  assert.equal(loopPeriod(stateWith('2026-09-22T08:30:00.000Z'), NOW).empty, true, '始まり = 終わり');
  assert.equal(loopPeriod(stateWith('2026-09-25T00:00:00.000Z'), NOW).empty, true, '始まり > 終わり');
  assert.equal(loopPeriod(stateWith('2026-09-22T08:29:59.999Z'), NOW).empty, false, '1ミリ秒でもあれば空でない');
});

// --- つながり ---

test('つながり：1回目の advance の後に決めた2回目の期間は、1回目の終わりから始まる', () => {
  const first = loopPeriod(null, NOW);
  const s1 = mustAdvance(null, dataFor(first.since, first.until), undefined, NOW);
  assert.equal(s1.until, iso(first.until));
  const now2 = new Date(NOW.getTime() + DAY);
  const second = loopPeriod(s1, now2);
  assert.equal(iso(second.since), iso(first.until), '2回目の始まりが1回目の終わりと違います（重なりか抜け）');
  assert.equal(iso(second.until), iso(daysBefore(now2, 7)));
  assert.equal(second.first, false);
  const s2 = mustAdvance(s1, dataFor(second.since, second.until), undefined, now2);
  assert.equal(s2.until, iso(second.until));
  assert.equal(s2.rounds.length, 2);
  assert.equal(s2.rounds[1]!.since, s2.rounds[0]!.until, '回の記録の期間がつながっていません');
});

test('つながり：3回続けても、各回の始まりは前の回の終わりと同じ', () => {
  let state: LoopState | null = null;
  for (let i = 0; i < 3; i++) {
    const now = new Date(NOW.getTime() + i * DAY + i * 3600_000);
    const p = loopPeriod(state, now);
    state = mustAdvance(state, dataFor(p.since, p.until), undefined, now);
  }
  assert.ok(state);
  assert.equal(state.rounds.length, 3);
  for (let i = 1; i < 3; i++) assert.equal(state.rounds[i]!.since, state.rounds[i - 1]!.until, `${i + 1}回目`);
  assert.equal(state.until, state.rounds[2]!.until);
});

// --- 境目の PR（collectQaRetro を続く2つの期間で呼ぶ） ---

interface PrSpec { number: number; mergedAt: string }

/** collectQaRetro が読む GET だけを返す最小の偽の GitHub（closingIssues の graphql は未定義で、collectQaRetro が catch する） */
function loopFake(prs: PrSpec[]): FakeGitHub {
  const page1 = <T>(m: RegExpMatchArray, items: T[]): T[] => (Number(m.input?.match(/[?&]page=(\d+)/)?.[1] ?? 1) === 1 ? items : []);
  const prOf = (n: string | undefined): PrSpec => {
    const found = prs.find((p) => p.number === Number(n));
    if (!found) throw new HttpError(404, `pulls/${n}`);
    return found;
  };
  const listItem = (p: PrSpec) => ({
    number: p.number, title: `feat: #${p.number}`, state: 'closed', draft: false, html_url: `https://github.com/o/r/pull/${p.number}`,
    merged_at: p.mergedAt, closed_at: p.mergedAt, updated_at: p.mergedAt, created_at: '2026-09-01T00:00:00Z',
    user: { login: 'me', type: 'User' }, author_association: 'OWNER', body: 'Closes #3', labels: [],
    head: { ref: `claude/issue-${p.number}-x`, sha: 'a'.repeat(40), repo: { full_name: 'o/r' } }, base: { ref: 'main', sha: 'b'.repeat(40) },
  });
  return new FakeGitHub()
    .on('GET', /\/pulls\?state=closed/, (m) => page1(m, prs.map(listItem)))
    .on('GET', /\/pulls\/(\d+)$/, (m) => ({ ...listItem(prOf(m[1])), merged: true, merged_by: { login: APP, type: 'Bot' } }))
    .on('GET', /\/pulls\/(\d+)\/files/, (m) => page1(m, [{ filename: 'docs/a.md', status: 'modified', additions: 1, deletions: 1 }]))
    .on('GET', /\/pulls\/(\d+)\/reviews/, (m) => page1(m, []))
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => page1(m, []))
    .on('GET', /\/commits\?/, (m) => page1(m, []))
    .on('GET', /\/actions\/workflows(\?[^/]*)?$/, () => ({ total_count: 0, workflows: [] }));
}

test('境目：続く2回の期間で集計すると、境目ちょうどに Merge された PR は後の回にだけ入り、どの PR も1回だけ数える', async () => {
  const now1 = new Date('2026-09-29T00:00:00Z');
  const now2 = new Date('2026-09-30T00:00:00Z');
  const boundary = '2026-09-22T00:00:00.000Z'; // now1 - 7日 = 1回目の終わり = 2回目の始まり
  const prs: PrSpec[] = [
    { number: 10, mergedAt: '2026-09-10T00:00:00Z' },
    { number: 11, mergedAt: '2026-09-21T23:59:59.999Z' },
    { number: 12, mergedAt: boundary },
    { number: 13, mergedAt: '2026-09-22T12:00:00Z' },
    { number: 14, mergedAt: '2026-09-23T00:00:00Z' }, // 2回目の終わりちょうど（次の回に入る）
  ];
  const fake = loopFake(prs);
  const gh = new GitHub(fake, 'o/r');

  const p1 = loopPeriod(null, now1);
  assert.equal(iso(p1.until), boundary);
  const d1 = await collectQaRetro(gh, config, { since: p1.since, until: p1.until });
  const s1 = mustAdvance(null, d1, undefined, now1);

  const p2 = loopPeriod(s1, now2);
  assert.equal(iso(p2.since), boundary);
  const d2 = await collectQaRetro(gh, config, { since: p2.since, until: p2.until });
  const s2 = mustAdvance(s1, d2, undefined, now2);

  const n1 = d1.prs.map((p) => p.number);
  const n2 = d2.prs.map((p) => p.number);
  assert.deepEqual(n1, [10, 11]);
  assert.deepEqual(n2, [12, 13]);
  assert.ok(!n1.includes(12), '境目の PR が前の回にも入っています');
  assert.equal(s2.rounds[0]!.prs, 2);
  assert.equal(s2.rounds[1]!.prs, 2);
  assert.deepEqual(fake.writes(), [], 'GitHub に書き込んでいます');
  assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET' && c.path !== '/graphql').map((c) => `${c.method} ${c.path}`), []);
});

// --- advanceLoopState：一致の確かめ ---

test('advanceLoopState：初回は状態を作り、until を集計の終わりに進めて回を1つ記録する（下書き無し）', () => {
  const data = firstData();
  const s = mustAdvance(null, data, undefined, NOW);
  assert.equal(s.version, 1);
  assert.equal(s.until, data.period.until);
  assert.equal(s.rounds.length, 1);
  const r = s.rounds[0]!;
  assert.equal(r.since, data.period.since);
  assert.equal(r.until, data.period.until);
  assert.equal(r.advancedAt, iso(NOW));
  assert.equal(r.prs, 0);
  assert.deepEqual(r.drafts, []);
});

test('advanceLoopState：period.since が状態の until と違う集計は誤りで、元の状態は変わらない', () => {
  const state = stateWith('2026-09-20T00:00:00.000Z');
  const before = structuredClone(state);
  const r = advanceLoopState(state, dataFor(new Date('2026-09-19T00:00:00Z'), daysBefore(NOW, 7)), undefined, NOW);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.length > 0);
  assert.deepEqual(state, before);
});

test('advanceLoopState：状態があるのに初回の集計（古い JSON）を渡すと誤り', () => {
  const s1 = mustAdvance(null, firstData(), undefined, NOW);
  const before = structuredClone(s1);
  const r = advanceLoopState(s1, firstData(), undefined, NOW);
  assert.equal(r.ok, false, '同じ初回の JSON を2度進めています');
  const later = advanceLoopState(s1, firstData(new Date(NOW.getTime() + DAY)), undefined, NOW);
  assert.equal(later.ok, false, '状態があるのに初回の形の JSON を受け付けています');
  assert.deepEqual(s1, before);
});

test('advanceLoopState：状態が無いのに2回目の集計（幅が14日でない）を渡すと誤り', () => {
  const r = advanceLoopState(null, dataFor(daysBefore(NOW, 8), daysBefore(NOW, 7)), undefined, NOW);
  assert.equal(r.ok, false);
  const wide = advanceLoopState(null, dataFor(daysBefore(NOW, 30), daysBefore(NOW, 7)), undefined, NOW);
  assert.equal(wide.ok, false);
});

test('advanceLoopState：集計の JSON の形が違うと誤り', () => {
  const state = stateWith('2026-09-20T00:00:00.000Z');
  for (const bad of [null, 1, 'x', {}, { period: {} }, { period: { since: 1, until: 2 }, prs: [] }, { period: { since: '2026-09-20T00:00:00.000Z', until: '2026-09-22T08:30:00.000Z' } }]) {
    assert.equal(advanceLoopState(state, bad, undefined, NOW).ok, false, JSON.stringify(bad));
  }
});

test('advanceLoopState：成功しても元の状態は変えず、新しい状態を返す', () => {
  const s1 = mustAdvance(null, firstData(), undefined, NOW);
  const before = structuredClone(s1);
  const now2 = new Date(NOW.getTime() + DAY);
  const p = loopPeriod(s1, now2);
  const s2 = mustAdvance(s1, dataFor(p.since, p.until, [{ number: 1 }, { number: 2 }]), undefined, now2);
  assert.deepEqual(s1, before);
  assert.notEqual(s2, s1);
  assert.equal(s2.rounds[1]!.prs, 2);
});

// --- advanceLoopState：下書き ---

test('advanceLoopState：正しい下書き（3件まで）は created: null で回に記録する', () => {
  const s = mustAdvance(null, firstData(), [draft(), draft({ title: 'fix(harness): risk の問いの例を足す', duplicateOf: 120 }), draft({ title: 'docs: 見直しの手順を直す' })], NOW);
  assert.deepEqual(s.rounds[0]!.drafts, [
    { title: 'test(harness): 不安定なテストの待ち時間を直す', body: BODY, created: null },
    { title: 'fix(harness): risk の問いの例を足す', body: BODY, duplicateOf: 120, created: null },
    { title: 'docs: 見直しの手順を直す', body: BODY, created: null },
  ]);
});

test('advanceLoopState：下書きが空の配列なら下書き無しの回になる', () => {
  assert.deepEqual(mustAdvance(null, firstData(), [], NOW).rounds[0]!.drafts, []);
});

test('advanceLoopState：下書きが4件以上なら誤り', () => {
  const r = advanceLoopState(null, firstData(), [draft(), draft(), draft(), draft()], NOW);
  assert.equal(r.ok, false);
});

test('advanceLoopState：タイトルが Conventional Commits でない・Issue Form の見出しが欠ける下書きは誤りで、元の状態は変わらない', () => {
  const s1 = mustAdvance(null, firstData(), undefined, NOW);
  const before = structuredClone(s1);
  const now2 = new Date(NOW.getTime() + DAY);
  const p = loopPeriod(s1, now2);
  const data = dataFor(p.since, p.until);
  assert.equal(advanceLoopState(s1, data, [draft({ title: '不安定なテストを直す' })], now2).ok, false, 'タイトル');
  assert.equal(advanceLoopState(s1, data, [draft({ body: BODY.split('### Acceptance Criteria')[0] })], now2).ok, false, 'Acceptance Criteria');
  assert.equal(advanceLoopState(s1, data, [draft({ body: BODY.replace('### Goal', '### Background') })], now2).ok, false, 'Goal');
  assert.deepEqual(s1, before);
});

test('advanceLoopState：ラベルを持つ下書き（agent:ready を含む）は誤り', () => {
  assert.equal(advanceLoopState(null, firstData(), [draft({ labels: ['agent:ready'] })], NOW).ok, false, 'agent:ready');
  assert.equal(advanceLoopState(null, firstData(), [draft({ labels: ['type:bug'] })], NOW).ok, false, 'ほかのラベル');
});

test('advanceLoopState：下書きが配列でない・中身の形が違うと誤り', () => {
  assert.equal(advanceLoopState(null, firstData(), draft(), NOW).ok, false);
  assert.equal(advanceLoopState(null, firstData(), [{ body: BODY }], NOW).ok, false);
});

// --- pendingDrafts・adoptDraft ---

/** 1回目に2件、2回目に1件の下書きがある状態 */
function twoRounds(): LoopState {
  const s1 = mustAdvance(null, firstData(), [draft(), draft({ title: 'fix(harness): risk の問いの例を足す', duplicateOf: 120 })], NOW);
  const now2 = new Date(NOW.getTime() + DAY);
  const p = loopPeriod(s1, now2);
  return mustAdvance(s1, dataFor(p.since, p.until), [draft({ title: 'docs: 見直しの手順を直す' })], now2);
}

test('pendingDrafts：状態が無ければ空', () => {
  assert.deepEqual(pendingDrafts(null), { pending: [], total: 0, adopted: 0 });
});

test('pendingDrafts：未採用の下書きを、回と下書きの番号（1から）つきで返す', () => {
  const r = pendingDrafts(twoRounds());
  assert.equal(r.total, 3);
  assert.equal(r.adopted, 0);
  assert.deepEqual(r.pending.map((p) => [p.round, p.draft, p.title]), [
    [1, 1, 'test(harness): 不安定なテストの待ち時間を直す'],
    [1, 2, 'fix(harness): risk の問いの例を足す'],
    [2, 1, 'docs: 見直しの手順を直す'],
  ]);
  assert.equal(r.pending[1]!.duplicateOf, 120);
  assert.equal(r.pending[0]!.body, BODY);
});

test('adoptDraft：採用すると created に Issue 番号が書かれ、未採用から外れる。until と元の状態は変わらない', () => {
  const state = twoRounds();
  const before = structuredClone(state);
  const r = adoptDraft(state, 1, 2, 400);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.state.rounds[0]!.drafts[1]!.created, 400);
  assert.equal(r.state.until, state.until);
  assert.deepEqual(state, before);
  const p = pendingDrafts(r.state);
  assert.equal(p.total, 3);
  assert.equal(p.adopted, 1);
  assert.deepEqual(p.pending.map((x) => [x.round, x.draft]), [[1, 1], [2, 1]]);
});

test('adoptDraft：採用済みの下書きをもう一度採用すると誤り', () => {
  const r = adoptDraft(twoRounds(), 2, 1, 401);
  assert.ok(r.ok, JSON.stringify(r));
  const again = adoptDraft(r.state, 2, 1, 402);
  assert.equal(again.ok, false);
});

test('adoptDraft：回・下書きの番号が範囲外、Issue 番号が正の整数でない、状態が無いと誤り', () => {
  const state = twoRounds();
  for (const [round, d] of [[0, 1], [3, 1], [1, 0], [1, 3], [2, 2]] as const) {
    assert.equal(adoptDraft(state, round, d, 400).ok, false, `${round}-${d}`);
  }
  for (const issue of [0, -1, 1.5, Number.NaN]) assert.equal(adoptDraft(state, 1, 1, issue).ok, false, `issue=${issue}`);
  assert.equal(adoptDraft(null, 1, 1, 400).ok, false, '状態が無い');
});

// --- parseLoopState ---

test('parseLoopState：ファイルが無ければ（null）状態無しとして読む', () => {
  assert.deepEqual(parseLoopState(null), { ok: true, state: null });
});

test('parseLoopState：advance が作った状態を JSON にして読み戻せる', () => {
  const state = twoRounds();
  const r = parseLoopState(JSON.stringify(state, null, 2));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.state, state);
});

test('parseLoopState：壊れた JSON・version が 1 でない・形の誤りは誤りとして読む', () => {
  for (const text of [
    '{',
    '',
    JSON.stringify({ version: 2, until: '2026-09-20T00:00:00.000Z', rounds: [] }),
    JSON.stringify({ until: '2026-09-20T00:00:00.000Z', rounds: [] }),
    JSON.stringify({ version: 1, until: 1, rounds: [] }),
    JSON.stringify({ version: 1, until: '2026-09-20T00:00:00.000Z', rounds: {} }),
    JSON.stringify([]),
  ]) {
    const r = parseLoopState(text);
    assert.equal(r.ok, false, text);
    assert.ok(!r.ok && r.errors.length > 0, text);
  }
});

// --- skill・docs ---

const root = join(import.meta.dirname, '..', '..');
const readRoot = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const skill = (): string => readRoot('.claude', 'skills', 'qa-retro', 'SKILL.md');

/** 見出しから次の同じ深さの見出しまでの本文。見出しが無ければ null */
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

/** skill が使う qa-retro-loop.ts のサブコマンド */
const usedLoopCommands = (text: string): string[] => [...text.matchAll(/node harness\/scripts\/qa-retro-loop\.ts ([a-z][\w-]*)/g)].map((m) => m[1]!);

/** harness/scripts/qa-retro-loop.ts の先頭の使い方のコメントに書かれたサブコマンド */
function documentedLoopCommands(): Set<string> {
  const src = readRoot('harness', 'scripts', 'qa-retro-loop.ts');
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

test('skill：/loop で回すときの節に、間隔（/loop <間隔> /qa-retro --loop）と止め方がある', () => {
  const body = loopSection();
  assert.match(body, /\/loop\s+\S+\s+\/qa-retro --loop/, '`/loop 1d /qa-retro --loop` の形の書き方がありません');
  assert.ok(body.includes('止め方'), '「止め方」がありません');
});

test('skill：/loop で回すときの節で、qa-retro-loop.ts の data・advance・pending・adopt を使う', () => {
  const used = new Set(usedLoopCommands(loopSection()));
  for (const sub of ['data', 'advance', 'pending', 'adopt']) assert.ok(used.has(sub), `node harness/scripts/qa-retro-loop.ts ${sub} がありません`);
});

test('skill：ループの回では AskUserQuestion を呼ばず、gh issue create もしないと書かれている', () => {
  const lines = loopSection().split('\n');
  assert.ok(lines.some((l) => l.includes('AskUserQuestion') && l.includes('呼ばない')), '「AskUserQuestion」と「呼ばない」を同じ行に含む行がありません');
  assert.ok(lines.some((l) => l.includes('gh issue create') && l.includes('しない')), '「gh issue create」と「しない」を同じ行に含む行がありません');
});

test('skill：/loop で回すときの節から docs/operations.md の共通の節へリンクしている', () => {
  assert.match(loopSection(), /\]\([^)]*docs\/operations\.md[^)]*\)/, 'docs/operations.md へのリンクがありません');
});

test('skill：やってはいけないことに、無人の定期 Routine を動かさない規則が残り、/loop を許す文がある', () => {
  const body = section(skill(), '## やってはいけないこと');
  assert.ok(body !== null, '「## やってはいけないこと」がありません');
  assert.ok(body.includes('無人の定期 Routine'), '「無人の定期 Routine」がありません');
  assert.ok(body.includes('/loop'), '/loop を許す文がありません');
});

test('skill：description に「qa-retro の下書きを選ぶ」がある', () => {
  const fm = frontmatter(skill());
  assert.ok((fm.description ?? '').includes('qa-retro の下書きを選ぶ'), `description: ${fm.description}`);
});

test('skill が使う qa-retro-loop.ts のサブコマンドは、スクリプトの使い方のコメントに実在する', () => {
  const known = documentedLoopCommands();
  for (const sub of ['data', 'advance', 'pending', 'adopt']) assert.ok(known.has(sub), `qa-retro-loop.ts の使い方のコメントに ${sub} がありません`);
  const used = usedLoopCommands(skill());
  assert.ok(used.length > 0, 'SKILL.md が qa-retro-loop.ts を使っていません');
  for (const sub of used) assert.ok(known.has(sub), `qa-retro-loop.ts ${sub} は使い方のコメントにありません`);
});

test('docs/risk-policy.md の見直しの手順に、/loop での回し方（--loop・1日・7日前・止め方・SKILL.md へのリンク）がある', () => {
  const body = section(readRoot('docs', 'risk-policy.md'), '## 見直しの手順');
  assert.ok(body !== null, '「## 見直しの手順」がありません');
  for (const word of ['--loop', '1日', '7日前', '止め方']) assert.ok(body.includes(word), `「${word}」がありません`);
  assert.match(body, /\]\([^)]*\.claude\/skills\/qa-retro\/SKILL\.md[^)]*\)/, 'qa-retro の SKILL.md へのリンクがありません');
});

test('harness/CLAUDE.harness.md の skill の表の qa-retro の行に /loop がある', () => {
  const row = readRoot('harness', 'CLAUDE.harness.md').split('\n').find((l) => l.startsWith('| [qa-retro](../.claude/skills/qa-retro/SKILL.md) |'));
  assert.ok(row, 'qa-retro の行がありません');
  assert.ok(row.includes('/loop'), `qa-retro の行に /loop がありません: ${row}`);
});
