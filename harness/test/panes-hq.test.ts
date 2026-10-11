// Issue #402：hq のペイン（人待ち・Epic/Issue・ログ）の描き方と、控え（hq-fleets.json）から今動いている fleet を見つけることを確かめる。
// 人待ちが全 fleet の人がすることを出し、無ければ「今はありません」と進行中の件数を出すこと、Epic のページの Close の数・人待ちの数・
// Epic に入っていない件数、Issue のページの Epic ごとの6段階の横棒と済みの畳み方、ログの新しい順、長いタイトルの折り返し（英数字の語を
// 途中で切らない）を、要点の語句だけで確かめる（文言を丸ごと固定しない）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { MARKS, displayWidth, stripAnsi, type PaneEpic, type PaneSnapshot } from '../lib/panes.ts';
import {
  hqWarning, ledgerFleets, nextBoardPage, readHqView, renderHqBoard, renderHqLog, renderHqTodo, wrapText,
  type HqFleet, type HqFleetView, type HqView,
} from '../lib/panes-hq.ts';

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.filter((r) => r.selected).length, selected: rows.filter((r) => r.selected).map((r) => r.issue), max: null, mode: null,
});
const NOW = Date.parse('2026-09-30T00:10:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60000).toISOString();
const snap = (session: string, rows: FleetStatusRow[], patch: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  version: 1, at: minutesAgo(1), session, label: null, intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: statusData(rows), prs: [], usage: null, history: [],
  since: Object.fromEntries(rows.map((r) => [String(r.issue), { signature: 's', at: minutesAgo(3) }])), error: null, ...patch,
});
const fleet = (theme: string, session: string | null, patch: Partial<HqFleet> = {}): HqFleet => ({ theme, epic: null, session, startedAt: minutesAgo(1), ...patch });
const fv = (f: HqFleet, s: PaneSnapshot | null, state: HqFleetView['state'] = s ? 'ok' : 'starting'): HqFleetView => ({ fleet: f, snap: s, state });
const view = (fleets: HqFleetView[]): HqView => ({ ledger: true, fleets });
const plain = (s: string): string => stripAnsi(s);
const noSpace = (s: string): string => s.replace(/\s/g, '');
const lines = (s: string): string[] => plain(s).split('\n');
const epic = (number: number, title: string, children: [number, 'OPEN' | 'CLOSED'][]): PaneEpic => ({
  number, title, state: 'OPEN', children: children.map(([n, state]) => ({ number: n, title: `c${n}`, state })),
});

// ---- ledgerFleets：控えから fleet を読む ----

test('ledgerFleets：控えが null なら空', () => {
  assert.deepEqual(ledgerFleets(null), []);
});

test('ledgerFleets：theme・epic・session・startedAt を読み、無いもの・形の違うものは既定にする', () => {
  const got = ledgerFleets({
    fleets: [
      { theme: 'ペイン', epic: 281, session: 'sessaaaa-1111', startedAt: '2026-09-30T00:00:00.000Z', extra: 'x' },
      { session: 'abcdefgh1234', epic: -1 },
      { epic: 1.5, session: '' },
      { theme: 'b', epic: '281', startedAt: 5 },
    ],
  });
  assert.deepEqual(got[0], { theme: 'ペイン', epic: 281, session: 'sessaaaa-1111', startedAt: '2026-09-30T00:00:00.000Z' });
  assert.deepEqual(got[1], { theme: 'abcdefgh', epic: null, session: 'abcdefgh1234', startedAt: null }, 'theme が無ければ session の先頭8文字');
  assert.deepEqual(got[2], { theme: '（名前なし）', epic: null, session: null, startedAt: null }, '空の session は null');
  assert.deepEqual(got[3], { theme: 'b', epic: null, session: null, startedAt: null }, '文字列の epic・数の startedAt は既定');
  assert.equal(got.length, 4);
});

// ---- readHqView：控えの fleet を見つけて状態を決める ----

test('readHqView：控えが null なら ledger: false で fleet は空、スナップショットを読まない', () => {
  const read: string[] = [];
  assert.deepEqual(readHqView(null, (s) => { read.push(s); return null; }, NOW, 10), { ledger: false, fleets: [] });
  assert.deepEqual(read, []);
});

test('readHqView：セッションを渡されなくても、控えの fleet のセッションだけを読む（session が null の fleet は読まない）', () => {
  const read: string[] = [];
  const ledger = { fleets: [{ theme: 'a', session: 'sess-a', startedAt: minutesAgo(1) }, { theme: 'b', session: 'sess-b' }, { theme: 'c' }] };
  const v = readHqView(ledger, (s) => { read.push(s); return s === 'sess-a' ? snap('sess-a', [row(11)]) : null; }, NOW, 10);
  assert.deepEqual([...read].sort(), ['sess-a', 'sess-b']);
  assert.equal(v.ledger, true);
  assert.deepEqual(v.fleets.map((f) => f.fleet.theme), ['a', 'b', 'c']);
  assert.equal(v.fleets[0]?.snap?.session, 'sess-a');
  assert.equal(v.fleets[1]?.snap, null);
});

test('readHqView：状態（starting・missing・stale・error・ok）', () => {
  const ledger = {
    fleets: [
      { theme: 'no-session' },
      { theme: 'new', session: 's-new', startedAt: minutesAgo(3) },
      { theme: 'old', session: 's-old', startedAt: minutesAgo(30) },
      { theme: 'nostart', session: 's-nostart' },
      { theme: 'stale', session: 's-stale', startedAt: minutesAgo(60) },
      { theme: 'err', session: 's-err', startedAt: minutesAgo(60) },
      { theme: 'ok', session: 's-ok', startedAt: minutesAgo(60) },
    ],
  };
  const snaps: Record<string, PaneSnapshot> = {
    's-stale': snap('s-stale', [row(1)], { at: minutesAgo(30) }),
    's-err': snap('s-err', [row(2)], { error: 'fleet-status が読めませんでした' }),
    's-ok': snap('s-ok', [row(3)]),
  };
  const v = readHqView(ledger, (s) => snaps[s] ?? null, NOW, 10);
  assert.deepEqual(Object.fromEntries(v.fleets.map((f) => [f.fleet.theme, f.state])), {
    'no-session': 'starting', new: 'starting', old: 'missing', nostart: 'missing', stale: 'stale', err: 'error', ok: 'ok',
  });
});

// ---- hqWarning ----

test('hqWarning：starting と ok だけなら null', () => {
  assert.equal(hqWarning(view([fv(fleet('a', null), null, 'starting'), fv(fleet('b', 's-b'), snap('s-b', [row(1)]))]), NOW), null);
});

test('hqWarning：控えが無ければ「控え」を含む ⚠ の1行', () => {
  const w = hqWarning({ ledger: false, fleets: [] }, NOW);
  assert.ok(w?.startsWith('⚠ '), String(w));
  assert.ok(w?.includes('控え'), String(w));
  assert.ok(!w?.includes('\n'), '1行');
});

test('hqWarning：missing・stale・error を theme 付きで / でつなぐ', () => {
  const w = hqWarning(view([
    fv(fleet('テーマA', 's-a'), null, 'missing'),
    fv(fleet('テーマB', 's-b'), snap('s-b', [row(1)], { at: minutesAgo(25) }), 'stale'),
    fv(fleet('テーマC', 's-c'), snap('s-c', [row(2)], { error: 'PR #50 が読めませんでした' }), 'error'),
    fv(fleet('テーマD', 's-d'), snap('s-d', [row(3)]), 'ok'),
  ]), NOW) ?? '';
  assert.ok(w.startsWith('⚠ '), w);
  assert.ok(w.includes('テーマA：スナップショットが無い'), w);
  assert.match(w, /テーマB：更新が ?25 ?分前/);
  assert.ok(w.includes('テーマC：PR #50 が読めませんでした'), w);
  assert.ok(!w.includes('テーマD'), 'ok は出さない');
  assert.equal(w.split(' / ').length, 3, w);
});

// ---- renderHqTodo（人待ち） ----

test('renderHqTodo：全 fleet の人がすることを、fleet の theme を添えて出す', () => {
  const a = snap('s-a', [row(11, { stage: 'human-merge', pr: 50 }), row(12)]);
  const b = snap('s-b', [row(22, { stage: 'plan-review' })]);
  const text = plain(renderHqTodo(view([fv(fleet('ペイン', 's-a'), a), fv(fleet('判定', 's-b'), b)]), NOW, 160, 4));
  assert.ok(text.includes('[ペイン]') && text.includes('[判定]'), text);
  assert.ok(text.includes('#11') && text.includes('#22'), text);
  assert.ok(text.includes('PR #50'), text);
  assert.doesNotMatch(text, /今はありません/);
  assert.doesNotMatch(text, /hq\.maxFleets/, '上限内なら警告しない');
});

test('renderHqTodo：人がすることが無ければ「今はありません」と進行中の件数（人・済みを除く）', () => {
  const a = snap('s-a', [row(11), row(12, { stage: 'auto-merge', pr: 50 }), row(13, { stage: 'merged' })]);
  const b = snap('s-b', [row(22, { stage: 'judge', pr: 51 })]);
  const text = plain(renderHqTodo(view([fv(fleet('a', 's-a'), a), fv(fleet('b', 's-b'), b), fv(fleet('c', null), null, 'starting')]), NOW, 160, 4));
  assert.match(text, /今はありません/);
  assert.match(text, /AI・App が進行中 3 件/);
});

test('renderHqTodo：fleet が hq.maxFleets を超えると警告の行', () => {
  const fleets = [1, 2, 3].map((n) => fv(fleet(`f${n}`, `s-${n}`), snap(`s-${n}`, [row(n)])));
  assert.match(plain(renderHqTodo(view(fleets), NOW, 160, 2)), /hq\.maxFleets/);
});

test('renderHqTodo：注意（hqWarning）があれば出す', () => {
  const text = plain(renderHqTodo(view([fv(fleet('テーマA', 's-a'), null, 'missing')]), NOW, 160, 4));
  assert.ok(text.includes('⚠'), text);
  assert.ok(text.includes('テーマA：スナップショットが無い'), text);
});

// ---- nextBoardPage ----

test('nextBoardPage：Tab は切り替え、e は epic、i は issue、ほかはそのまま', () => {
  assert.equal(nextBoardPage('epic', '\t'), 'issue');
  assert.equal(nextBoardPage('issue', '\t'), 'epic');
  assert.equal(nextBoardPage('issue', 'e'), 'epic');
  assert.equal(nextBoardPage('epic', 'e'), 'epic');
  assert.equal(nextBoardPage('epic', 'i'), 'issue');
  assert.equal(nextBoardPage('epic', 'x'), 'epic');
  assert.equal(nextBoardPage('issue', 'q'), 'issue');
});

// ---- renderHqBoard：Epic のページ ----

const NINE: [number, 'OPEN' | 'CLOSED'][] = [[11, 'OPEN'], [12, 'CLOSED'], [13, 'CLOSED'], [14, 'CLOSED'], [15, 'CLOSED'], [16, 'CLOSED'], [17, 'CLOSED'], [18, 'CLOSED'], [19, 'CLOSED']];

function boardView(): HqView {
  const rows = [
    row(11, { stage: 'human-merge', pr: 50 }),
    row(12, { stage: 'plan-review' }),
    row(22),
    row(33, { stage: 'judge', pr: 60 }),
    row(281, { stage: 'stopped', note: 'Epic（子課題で進める）', selected: false, next: 'none' }),
  ];
  const s = snap('s-a', rows, { epics: [epic(281, 'hq のペインを作る', NINE)], issueEpic: { 11: 281, 12: 281, 22: null } });
  return view([fv(fleet('ペイン', 's-a', { epic: 281 }), s)]);
}

test('renderHqBoard（epic）：見出しにページと切り替えのキー', () => {
  const text = plain(renderHqBoard(boardView(), 'epic', NOW, 120));
  assert.match(text, /Tab/);
  assert.match(text, /Epic/);
});

test('renderHqBoard（epic）：Epic ごとに Close の数の棒・closed/total・人待ちの数・番号・theme・タイトル', () => {
  const text = plain(renderHqBoard(boardView(), 'epic', NOW, 120));
  assert.ok(text.includes('8/9'), text);
  assert.ok(text.includes('■') && text.includes('□'), text);
  assert.match(text, /人待ち 2/);
  assert.ok(text.includes('#281'), text);
  assert.ok(text.includes('ペイン'), text);
  assert.ok(text.includes('hq のペインを作る'), text);
});

test('renderHqBoard（epic）：Epic に入っていない行の件数（issueEpic が null・無い行。Epic 自身の行は数えない）', () => {
  assert.match(plain(renderHqBoard(boardView(), 'epic', NOW, 120)), /Epic なし 2 件/);
});

test('renderHqBoard（epic）：スナップショットの無い fleet でも、控えに Epic があれば番号・theme・「まだ読めていない」', () => {
  const v = view([fv(fleet('起動中のテーマ', 's-new', { epic: 300 }), null, 'starting'), fv(fleet('無いテーマ', 's-gone', { epic: 301 }), null, 'missing')]);
  const text = plain(renderHqBoard(v, 'epic', NOW, 120));
  assert.ok(text.includes('#300') && text.includes('起動中のテーマ'), text);
  assert.ok(text.includes('#301') && text.includes('無いテーマ'), text);
  assert.match(text, /まだ読めていない/);
});

test('renderHqBoard（epic）：長いタイトルを省略せずに折り返し、行の幅を超えない', () => {
  const title = 'hq を呼び出したら、hq・人待ち・Epic/Issue・ログ・intel のペインを開き、今動いている fleet を自分で読む renderHqBoard';
  const s = snap('s-a', [row(11)], { epics: [epic(402, title, [[11, 'OPEN']])], issueEpic: { 11: 402 } });
  const width = 40;
  const out = renderHqBoard(view([fv(fleet('t', 's-a'), s)]), 'epic', NOW, width);
  for (const l of lines(out)) assert.ok(displayWidth(l) <= width, `幅 ${displayWidth(l)}：${l}`);
  assert.ok(noSpace(plain(out)).includes(noSpace(title)), '折り返してもタイトルの文字が全部残る');
  assert.ok(lines(out).some((l) => l.includes('renderHqBoard')), '英数字の語を途中で切らない');
});

// ---- renderHqBoard：Issue のページ ----

function issueView(): HqView {
  const rows = [
    row(11, { stage: 'human-merge', pr: 50 }),
    row(12, { stage: 'plan-ok', selected: false, waitReason: '#11 と触るファイルが重なるため待つ' }),
    row(13, { stage: 'merged', pr: 41 }),
    row(14, { stage: 'merged', pr: 42 }),
    row(15, { stage: 'merged', pr: 43 }),
    row(22, { stage: 'judge', pr: 60 }),
  ];
  const s = snap('s-a', rows, {
    epics: [epic(281, 'Epic のタイトル', [[11, 'OPEN'], [12, 'OPEN'], [13, 'CLOSED'], [14, 'CLOSED'], [15, 'CLOSED']])],
    issueEpic: { 11: 281, 12: 281, 13: 281, 14: 281, 15: 281, 22: null },
  });
  return view([fv(fleet('ペイン', 's-a', { epic: 281 }), s)]);
}

test('renderHqBoard（issue）：Epic ごとにまとめ、Epic なしは最後', () => {
  const text = plain(renderHqBoard(issueView(), 'issue', NOW, 120));
  const iEpic = text.indexOf('#281');
  const i11 = text.indexOf('#11');
  const iNone = text.indexOf('Epic なし');
  const i22 = text.indexOf('#22');
  assert.ok(iEpic >= 0 && i11 > iEpic, '#281 の見出しの下に #11');
  assert.ok(iNone > i11, 'Epic なしは Epic の後');
  assert.ok(i22 > iNone, 'Epic に入っていない #22 は Epic なしの下');
});

test('renderHqBoard（issue）：行ごとに6段階の横棒（進み具合と同じ記号）・誰の番・PR・時間・待つ理由', () => {
  const text = plain(renderHqBoard(issueView(), 'issue', NOW, 160));
  assert.ok(noSpace(text).includes(`${MARKS.done.mark.repeat(5)}${MARKS.human.mark}`), '人の Merge 待ちの #11：5つ済みで6つ目があなたの番');
  assert.ok(noSpace(text).includes(`${MARKS.done.mark.repeat(4)}${MARKS.ai.mark}${MARKS.todo.mark}`), '判定待ちの #22');
  assert.ok(text.includes(MARKS.human.meaning), text);
  assert.ok(text.includes('PR #50') && text.includes('PR #60'), text);
  assert.match(text, /3分前/);
  assert.ok(text.includes('#11 と触るファイルが重なるため待つ'), '待つ理由');
});

test('renderHqBoard（issue）：Merge 済みの行は Epic ごとに1行に畳む', () => {
  const ls = lines(renderHqBoard(issueView(), 'issue', NOW, 160));
  const done = ls.filter((l) => l.includes('済み 3 件'));
  assert.equal(done.length, 1, ls.join('\n'));
  assert.ok(done[0]?.includes(MARKS.done.mark), done[0]);
  for (const n of ['#13', '#14', '#15']) assert.ok(done[0]?.includes(n), `${n} が畳んだ行にある`);
  for (const n of ['#13', '#14', '#15']) assert.equal(ls.filter((l) => l.includes(n)).length, 1, `${n} は畳んだ行だけに出る`);
});

test('renderHqBoard（issue）：長いタイトルを折り返し、行の幅を超えない', () => {
  const title = 'feat(harness): hq を呼び出したら、人待ち・Epic/Issue・ログ・intel のペインを開き、今動いている fleet を控えから見つけて fleet-status を読む';
  const s = snap('s-a', [row(11, { title, stage: 'judge', pr: 50 })], { issueEpic: { 11: null } });
  const width = 64;
  const out = renderHqBoard(view([fv(fleet('t', 's-a'), s)]), 'issue', NOW, width);
  for (const l of lines(out)) assert.ok(displayWidth(l) <= width, `幅 ${displayWidth(l)}：${l}`);
  assert.ok(lines(out).some((l) => l.includes('fleet-status')), '英数字の語を途中で切らない');
  assert.ok(noSpace(plain(out)).includes(noSpace('人待ち・Epic/Issue・ログ・intel のペインを開き、今動いている fleet を控えから見つけて fleet-status を読む')), '省略しない');
});

// ---- renderHqLog ----

test('renderHqLog：全 fleet の行を、状態が変わった時刻の新しい順に、時刻・#番号・PR とともに出す', () => {
  const at = (m: number): string => minutesAgo(m);
  const a = snap('s-a', [row(11, { stage: 'judge', pr: 50 }), row(12)], { since: { 11: { signature: 'x', at: at(5) }, 12: { signature: 'x', at: at(9) } } });
  const b = snap('s-b', [row(22, { stage: 'plan-review' })], { since: { 22: { signature: 'x', at: at(2) } } });
  const text = plain(renderHqLog(view([fv(fleet('a', 's-a'), a), fv(fleet('b', 's-b'), b)]), NOW, 120, 40));
  const i22 = text.indexOf('#22');
  const i11 = text.indexOf('#11');
  const i12 = text.indexOf('#12');
  assert.ok(i22 >= 0 && i22 < i11 && i11 < i12, text);
  const hhmm = (iso: string): string => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const line22 = text.split('\n').find((l) => l.includes('#22')) ?? '';
  assert.ok(line22.includes(hhmm(at(2))), line22);
  const line11 = text.split('\n').find((l) => l.includes('#11')) ?? '';
  assert.ok(line11.includes(hhmm(at(5))) && line11.includes('PR #50'), line11);
});

test('renderHqLog：出力の行数が height を超えない', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(100 + i));
  const since = Object.fromEntries(rows.map((r, i) => [String(r.issue), { signature: 'x', at: minutesAgo(i) }]));
  const out = renderHqLog(view([fv(fleet('a', 's-a'), snap('s-a', rows, { since })), fv(fleet('b', 's-b'), null, 'missing')]), NOW, 120, 10);
  assert.ok(lines(out).length <= 10, `${lines(out).length} 行`);
  assert.ok(plain(out).includes('#100'), '一番新しい行は残る');
});

// ---- wrapText ----

const assertWrap = (text: string, width: number): string[] => {
  const ls = wrapText(text, width);
  for (const l of ls) assert.ok(displayWidth(l) <= width, `幅 ${displayWidth(l)} > ${width}：${l}`);
  assert.equal(noSpace(ls.join('')), noSpace(text), '元の文字がすべて残る');
  assert.ok(!ls.join('').includes('…') || text.includes('…'), '… を付けない');
  return ls;
};

test('wrapText：短い文はそのまま1行', () => {
  assert.deepEqual(wrapText('abc', 10), ['abc']);
});

test('wrapText：全角は幅2で折り返し、省略しない', () => {
  const ls = assertWrap('あいうえおかきくけこさしすせそ', 7);
  assert.ok(ls.length >= 5, ls.join('|'));
});

test('wrapText：英数字・記号の語を途中で切らない', () => {
  const text = 'hq のペインに renderHqBoard と fleet-status --json と #402 を足して Epic/Issue を描く';
  const ls = assertWrap(text, 16);
  for (const w of ['renderHqBoard', 'fleet-status', '--json', '#402', 'Epic/Issue']) {
    assert.ok(ls.some((l) => l.includes(w)), `${w} が1行に収まる：${ls.join('|')}`);
  }
});

test('wrapText：幅より長い語だけは切る', () => {
  const long = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const ls = assertWrap(`x ${long} y`, 10);
  assert.ok(ls.length >= 4, ls.join('|'));
});
