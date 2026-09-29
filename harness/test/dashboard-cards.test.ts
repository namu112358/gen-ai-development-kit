// Issue #192：ダッシュボードで Issue と Closes する PR を1枚のカードにまとめる処理（page.html の buildCards）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PAGE_PATH } from '../scripts/dashboard.ts';
import type { ColumnId, Edge, Task, TaskClaim, TaskStatus } from '../scripts/dashboard/graph.ts';

interface CardPr { id: string; number: number; url: string; status: TaskStatus; column: ColumnId; claim: TaskClaim | null; note: string | null }
interface Card {
  id: string; kind: 'issue' | 'pr'; number: number; title: string; url: string; column: ColumnId; status: TaskStatus;
  note: string | null; claim: TaskClaim | null; prs: CardPr[]; sessions: string[]; warnings: string[];
}
type BuildCards = (tasks: Task[], edges: Edge[]) => { cards: Card[]; edges: Edge[] };

const html = readFileSync(PAGE_PATH, 'utf8');
const script = (): string => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page.html に <script> が無い');
  return m[1]!;
};

function load(): BuildCards {
  const context: Record<string, unknown> = {};
  runInNewContext(script(), context);
  assert.equal(typeof context.buildCards, 'function', 'buildCards が定義されていない');
  const fn = context.buildCards as BuildCards;
  // vm の別レルムの配列・オブジェクトを deepEqual で比べられるよう、JSON で持ち帰る
  return (tasks, edges) => JSON.parse(JSON.stringify(fn(tasks, edges)));
}

const claim = (stage: string | null, session: string | null = null): TaskClaim => ({ by: 'manual', stage, session, at: '2026-09-28T23:50:00Z' });
const issue = (n: number, patch: Partial<Task> = {}): Task => ({
  id: `issue-${n}`, kind: 'issue', number: n, title: `issue ${n}`, url: `https://example.test/issues/${n}`,
  column: 'plan-ok', status: 'idle', note: null, claim: null, sessions: [], warnings: [], ...patch,
});
const pr = (n: number, patch: Partial<Task> = {}): Task => ({
  id: `pr-${n}`, kind: 'pr', number: n, title: `pr ${n}`, url: `https://example.test/pull/${n}`,
  column: 'judge', status: 'idle', note: null, claim: null, sessions: [], warnings: [], ...patch,
});
const closes = (i: number, p: number): Edge => ({ kind: 'closes', from: `issue-${i}`, to: `pr-${p}` });
const byId = (cards: Card[], id: string): Card => {
  const c = cards.find((x) => x.id === id);
  assert.ok(c, `${id} のカードが無い`);
  return c;
};
const sortEdges = (es: Edge[]): Edge[] =>
  [...es].sort((a, b) => `${a.kind}|${a.from}|${a.to}`.localeCompare(`${b.kind}|${b.from}|${b.to}`));

test('page.html の script は document の無い環境で実行しても例外にならず、buildCards を定義する', () => {
  const context: Record<string, unknown> = {};
  assert.doesNotThrow(() => runInNewContext(script(), context));
  assert.equal(typeof context.buildCards, 'function');
});

test('page.html はセッションを <details> / <summary> の折りたたみで描く処理を持つ', () => {
  const code = script();
  assert.match(code, /['"`]details['"`]/);
  assert.match(code, /['"`]summary['"`]/);
});

test('Issue と Closes する PR が1枚のカードになり、closes の辺は出ない', () => {
  const buildCards = load();
  const { cards, edges } = buildCards([issue(1), pr(5, { note: 'n5' })], [closes(1, 5)]);
  assert.equal(cards.length, 1);
  const c = cards[0]!;
  assert.equal(c.id, 'issue-1');
  assert.equal(c.kind, 'issue');
  assert.equal(c.number, 1);
  assert.equal(c.title, 'issue 1');
  assert.equal(c.url, 'https://example.test/issues/1');
  assert.deepEqual(c.prs, [{ id: 'pr-5', number: 5, url: 'https://example.test/pull/5', status: 'idle', column: 'judge', claim: null, note: 'n5' }]);
  assert.equal(cards.some((x) => x.id === 'pr-5'), false);
  assert.deepEqual(edges, []);
});

test('入った PR は番号の小さい順に並ぶ', () => {
  const buildCards = load();
  const { cards } = buildCards([issue(1), pr(9), pr(5)], [closes(1, 9), closes(1, 5)]);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0]!.prs.map((p) => p.number), [5, 9]);
});

test('PR の着手宣言の段階が judge で列も judge なら、カードは judge の列に出る', () => {
  const buildCards = load();
  const { cards } = buildCards([issue(1, { column: 'plan-ok' }), pr(5, { column: 'judge', claim: claim('judge') })], [closes(1, 5)]);
  assert.equal(byId(cards, 'issue-1').column, 'judge');
});

test('PR に着手宣言が無ければ、カードは Issue の列に出る', () => {
  const buildCards = load();
  const { cards } = buildCards([issue(1, { column: 'implement' }), pr(5, { column: 'judge', claim: null })], [closes(1, 5)]);
  assert.equal(byId(cards, 'issue-1').column, 'implement');
});

test('着手宣言の段階が対象外（merge など）や null なら、Issue の列に出る', () => {
  const buildCards = load();
  const a = buildCards([issue(1, { column: 'implement' }), pr(5, { column: 'merge', claim: claim('merge') })], [closes(1, 5)]);
  assert.equal(byId(a.cards, 'issue-1').column, 'implement');
  const b = buildCards([issue(1, { column: 'implement' }), pr(5, { column: 'judge', claim: claim(null) })], [closes(1, 5)]);
  assert.equal(byId(b.cards, 'issue-1').column, 'implement');
});

test('段階の合う PR が複数なら、番号の小さい PR の列に出る', () => {
  const buildCards = load();
  const { cards } = buildCards(
    [issue(1), pr(9, { column: 'judge', claim: claim('judge') }), pr(5, { column: 'fix', claim: claim('fix') })],
    [closes(1, 9), closes(1, 5)],
  );
  assert.equal(byId(cards, 'issue-1').column, 'fix');
});

test('止まる印の PR（段階は fix だが列は stopped）は Issue の列に出て、状態は blocked', () => {
  const buildCards = load();
  const { cards } = buildCards(
    [issue(1, { column: 'plan-ok', status: 'idle' }), pr(5, { column: 'stopped', status: 'blocked', claim: claim('fix') })],
    [closes(1, 5)],
  );
  const c = byId(cards, 'issue-1');
  assert.equal(c.column, 'plan-ok');
  assert.equal(c.status, 'blocked');
});

test('状態は Issue と PR のうち強いもの', () => {
  const buildCards = load();
  const cases: [TaskStatus, TaskStatus, TaskStatus][] = [
    ['idle', 'conflict', 'conflict'],
    ['blocked', 'active', 'blocked'],
    ['waiting-human', 'stale', 'stale'],
    ['conflict', 'stale', 'conflict'],
    ['idle', 'active', 'active'],
    ['idle', 'waiting-human', 'waiting-human'],
  ];
  for (const [i, p, want] of cases) {
    const { cards } = buildCards([issue(1, { status: i }), pr(5, { status: p })], [closes(1, 5)]);
    assert.equal(byId(cards, 'issue-1').status, want, `Issue ${i} + PR ${p}`);
  }
});

test('Issue の無い PR は単独のカードで、prs は空', () => {
  const buildCards = load();
  const { cards } = buildCards([issue(1), pr(5, { column: 'judge', status: 'active', claim: claim('judge') })], []);
  assert.equal(cards.length, 2);
  const c = byId(cards, 'pr-5');
  assert.equal(c.kind, 'pr');
  assert.equal(c.number, 5);
  assert.equal(c.column, 'judge');
  assert.equal(c.status, 'active');
  assert.deepEqual(c.prs, []);
  assert.deepEqual(byId(cards, 'issue-1').prs, []);
});

test('closes の from の Issue がタスクに無い PR は単独のカードで、closes の辺は出ない', () => {
  const buildCards = load();
  const { cards, edges } = buildCards([pr(5)], [closes(3, 5)]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.id, 'pr-5');
  assert.deepEqual(cards[0]!.prs, []);
  assert.deepEqual(edges, []);
});

test('stacked の辺は、それぞれ入った Issue のカードに付け替わる', () => {
  const buildCards = load();
  const { edges } = buildCards(
    [issue(1), issue(2), pr(5), pr(7)],
    [closes(1, 5), closes(2, 7), { kind: 'stacked', from: 'pr-7', to: 'pr-5' }],
  );
  assert.deepEqual(edges, [{ kind: 'stacked', from: 'issue-2', to: 'issue-1' }]);
});

test('Issue の無い PR への stacked は、片側だけ付け替わる', () => {
  const buildCards = load();
  const { edges } = buildCards(
    [issue(1), pr(5), pr(7)],
    [closes(1, 5), { kind: 'stacked', from: 'pr-7', to: 'pr-5' }],
  );
  assert.deepEqual(edges, [{ kind: 'stacked', from: 'pr-7', to: 'issue-1' }]);
});

test('同じ Issue に入った PR 同士の stacked は自分への辺になるので落ちる', () => {
  const buildCards = load();
  const { edges } = buildCards(
    [issue(1), pr(5), pr(7)],
    [closes(1, 5), closes(1, 7), { kind: 'stacked', from: 'pr-7', to: 'pr-5' }],
  );
  assert.deepEqual(edges, []);
});

test('session の辺はカードに付け替わり、Issue からの同じ session の辺と重複しない', () => {
  const buildCards = load();
  const { edges } = buildCards(
    [issue(1), pr(5)],
    [
      closes(1, 5),
      { kind: 'session', from: 'issue-1', to: 'session-x' },
      { kind: 'session', from: 'pr-5', to: 'session-x' },
      { kind: 'session', from: 'pr-5', to: 'session-y' },
    ],
  );
  assert.deepEqual(sortEdges(edges), [
    { kind: 'session', from: 'issue-1', to: 'session-x' },
    { kind: 'session', from: 'issue-1', to: 'session-y' },
  ]);
});

test('depends・epic の辺は Issue のまま残る', () => {
  const buildCards = load();
  const input: Edge[] = [
    closes(1, 5),
    { kind: 'depends', from: 'issue-2', to: 'issue-1' },
    { kind: 'epic', from: 'issue-3', to: 'issue-1' },
  ];
  const { edges } = buildCards([issue(1), issue(2), issue(3), pr(5)], input);
  assert.deepEqual(sortEdges(edges), sortEdges(input.slice(1)));
});

test('カードの sessions は Issue と入った PR の sessions の和（重複なし、出てきた順）', () => {
  const buildCards = load();
  const { cards } = buildCards(
    [issue(1, { sessions: ['a', 'b'] }), pr(5, { sessions: ['b', 'c'] }), pr(7, { sessions: ['c', 'd'] })],
    [closes(1, 5), closes(1, 7)],
  );
  assert.deepEqual(byId(cards, 'issue-1').sessions, ['a', 'b', 'c', 'd']);
});

test('Issue の無い PR のカードは、その PR の sessions をそのまま持つ', () => {
  const buildCards = load();
  const { cards } = buildCards([pr(5, { sessions: ['a', 'a', 'b'] })], []);
  assert.deepEqual(byId(cards, 'pr-5').sessions, ['a', 'b']);
});

test('Issue のカードは Issue のタスクの warnings を持ち、Closes の PR が入っても変わらない', () => {
  const buildCards = load();
  const alone = buildCards([issue(1, { warnings: ['批評なし'] })], []);
  assert.deepEqual(byId(alone.cards, 'issue-1').warnings, ['批評なし']);
  const { cards } = buildCards(
    [issue(1, { warnings: ['必須の指摘を残して進めた（2 件）'] }), pr(5, { warnings: [] }), pr(7, { warnings: [] })],
    [closes(1, 5), closes(1, 7)],
  );
  assert.deepEqual(byId(cards, 'issue-1').warnings, ['必須の指摘を残して進めた（2 件）']);
});

test('注意の無い Issue のカードの warnings は空', () => {
  const buildCards = load();
  const { cards } = buildCards([issue(1), pr(5)], [closes(1, 5)]);
  assert.deepEqual(byId(cards, 'issue-1').warnings, []);
});

test('Issue の無い PR のカードは、その PR の warnings を持つ', () => {
  const buildCards = load();
  const { cards } = buildCards([issue(1, { warnings: ['批評なし'] }), pr(5, { warnings: ['x'] })], []);
  assert.deepEqual(byId(cards, 'pr-5').warnings, ['x']);
  assert.deepEqual(byId(cards, 'issue-1').warnings, ['批評なし']);
  assert.deepEqual(byId(buildCards([pr(6)], []).cards, 'pr-6').warnings, []);
});
