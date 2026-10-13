// Issue #853：digest.ts のまとめの組み立て（前回からの Merge・閉じた Issue と Epic・人がすること3つまで）と本文、その材料の応答の読み取り
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDigest, renderDigest, sinceFacts, type SinceFacts } from '../scripts/dashboard/digest.ts';
import type { Task, Todo } from '../scripts/dashboard/graph.ts';
import { APP } from './support/gate-fixtures.ts';

/** 手元の時刻で作る（TZ に依らない） */
const NOW = new Date(2026, 9, 12, 15);
const SINCE = new Date(2026, 9, 11, 17, 30);
const at = (d: number, h: number, m = 0): string => new Date(2026, 9, d, h, m).toISOString();

const merged = (number: number, mergedAt: string, byApp: boolean) => ({
  number, title: `pr${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt, byApp,
});
const closed = (number: number, closedAt: string, epic: boolean) => ({
  number, title: `issue${number}`, url: `https://github.com/o/r/issues/${number}`, closedAt, epic,
});
const facts = (patch: Partial<SinceFacts> = {}): SinceFacts => ({ merged: [], closed: [], truncated: { merged: false, closed: false }, ...patch });

const todo = (id: string): Todo => {
  const number = Number(id.slice(id.lastIndexOf('-') + 1));
  const kind = id.includes('-pr-') ? 'pr' : 'issue';
  const url = `https://github.com/o/r/${kind === 'pr' ? 'pull' : 'issues'}/${number}`;
  return { id, kind, number, url, title: `t${number}`, reason: `reason ${id}` };
};
/** 確認事項の行（id は confirm-<issue|pr>-<番号>-<確認事項のコメントID>。Issue #964） */
const confirmTodo = (number: number, confirmCommentId: number): Todo =>
  ({ id: `confirm-issue-${number}-${confirmCommentId}`, kind: 'issue', number, url: `https://github.com/o/r/issues/${number}#c${confirmCommentId}`, title: `t${number}`, reason: `reason confirm ${number}` });
const staleTask = (kind: 'issue' | 'pr', number: number, status: Task['status'] = 'stale'): Task => ({
  id: `${kind}-${number}`, kind, number, title: `t${number}`, url: `https://github.com/o/r/issues/${number}`,
  column: 'implement', status, note: null, claim: { by: 'manual', stage: 'implement', session: 's-1', at: at(12, 9) },
  sessions: [], warnings: [],
});

const digest = (patch: { facts?: SinceFacts; todos?: Todo[]; tasks?: Task[] } = {}) =>
  buildDigest({ now: NOW, since: SINCE, facts: patch.facts ?? facts(), todos: patch.todos ?? [], tasks: patch.tasks ?? [] });

test('buildDigest：Merge を App と人に分けて新しい順に並べ、since より前の Merge と閉じた Issue を落とし、閉じた Epic を分ける', () => {
  const d = digest({
    facts: facts({
      merged: [merged(1, at(12, 10), true), merged(2, at(12, 14), false), merged(3, at(12, 11), true), merged(4, at(11, 17, 29), true)],
      closed: [closed(10, at(12, 9), false), closed(11, at(12, 12), true), closed(12, at(11, 10), true)],
    }),
  });
  assert.deepEqual(d.merged.map((m) => m.number), [2, 3, 1], 'since より前（#4）を落とし、mergedAt の新しい順');
  assert.equal(d.merged.filter((m) => m.byApp).length, 2, 'App');
  assert.equal(d.merged.filter((m) => !m.byApp).length, 1, '人');
  assert.deepEqual(d.closed.map((c) => c.number), [11, 10], 'since より前（#12）を落とし、closedAt の新しい順');
  assert.deepEqual(d.closed.filter((c) => c.epic).map((c) => c.number), [11], '閉じた Epic');
});

test('buildDigest：人がすることは merge → review → confirm → stop → stale の順に3件まで、rest は残りの件数、priority の todo は出さない', () => {
  const d = digest({
    todos: [todo('priority-issue-5'), todo('stop-issue-7'), confirmTodo(12, 900), todo('review-issue-6'), todo('review-issue-8'), todo('merge-pr-9')],
    tasks: [
      staleTask('issue', 20),
      staleTask('issue', 8), // review の群に同じ Issue があるので stale では数えない
      staleTask('pr', 9), // merge の群に同じ PR があるので stale では数えない
      staleTask('issue', 21, 'active'), // stale でない
    ],
  });
  assert.deepEqual(d.todo.map((t) => [t.group, t.kind, t.number]), [['merge', 'pr', 9], ['review', 'issue', 6], ['review', 'issue', 8]]);
  assert.equal(d.rest, 3, 'confirm の #12、stop の #7 と stale の #20');
  assert.deepEqual(d.counts, { merge: 1, review: 2, confirm: 1, stop: 1, stale: 1 });
  assert.ok(!d.todo.some((t) => t.number === 5), 'priority の todo は出さない');
  // 確認事項の群は計画ゲートの後、止まる印の前
  const later = digest({ todos: [todo('stop-issue-7'), confirmTodo(12, 900), todo('review-issue-6')] });
  assert.deepEqual(later.todo.map((t) => [t.group, t.number]), [['review', 6], ['confirm', 12], ['stop', 7]]);
});

test('renderDigest：1行目が結論（前回の時刻・件数と内訳）、人がすることが4件以上なら「ほか N 件」とダッシュボードの案内の行があり、3件以下なら無い', () => {
  const f = facts({ merged: [merged(1, at(12, 10), true), merged(2, at(12, 11), false)], closed: [closed(10, at(12, 9), false), closed(11, at(12, 12), true)] });
  const todos = [todo('merge-pr-9'), todo('review-issue-6'), todo('review-issue-8'), todo('stop-issue-7'), confirmTodo(12, 900)];
  const text = renderDigest(digest({ facts: f, todos, tasks: [staleTask('issue', 20)] }));
  const lines = text.trim().split('\n');
  const first = lines[0]!;
  assert.ok(first.includes('10/11 17:30'), first);
  for (const re of [/Merge\s*2\s*件/, /App\s*1/, /人\s*1/, /閉じた Issue\s*2\s*件/, /Epic\s*1/, /人がすること\s*6\s*件/,
    /人の Merge 待ち\s*1/, /計画ゲート\s*2/, /確認事項\s*1/, /止まる印\s*1/, /止まっていそうな宣言\s*1/]) {
    assert.match(first, re);
  }
  const guide = lines.filter((l) => /ほか\s*3\s*件/.test(l));
  assert.equal(guide.length, 1, text);
  assert.ok(guide[0]!.includes('node harness/scripts/dashboard.ts'), guide[0]);
  assert.equal(lines.filter((l) => l.startsWith('- #9 ') || l.startsWith('- #6 ') || l.startsWith('- #8 ')).length, 3, text);
  assert.ok(!lines.some((l) => l.startsWith('- #7 ') || l.startsWith('- #12 ') || l.startsWith('- #20 ')), '4件目からは出さない');

  const three = renderDigest(digest({ facts: f, todos: todos.slice(0, 3) }));
  assert.ok(!three.includes('ほか'), three);
});

test('renderDigest：何も無ければ結論の1行だけ', () => {
  const text = renderDigest(digest());
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1, text);
  assert.ok(lines[0]!.includes('10/11 17:30'), lines[0]);
});

test('sinceFacts：閉じた Issue の epic を labels から読み、merged と closed の hasNextPage を truncated に読む', () => {
  const EPIC = 'type:epic-853';
  const T = '2026-10-12T01:00:00Z';
  const response = (mergedNext: boolean, closedNext: boolean) => ({
    merged: { nodes: [], pageInfo: { hasNextPage: mergedNext } },
    closed: {
      nodes: [
        { __typename: 'Issue', number: 10, title: 'e10', url: 'https://github.com/o/r/issues/10', closedAt: T, labels: { nodes: [{ name: 'bug' }, { name: EPIC }] } },
        { __typename: 'Issue', number: 11, title: 'i11', url: 'https://github.com/o/r/issues/11', closedAt: T, labels: { nodes: [{ name: `${EPIC}-x` }] } },
        { __typename: 'Issue', number: 12, title: 'i12', url: 'https://github.com/o/r/issues/12', closedAt: T, labels: { nodes: [] } },
      ],
      pageInfo: { hasNextPage: closedNext },
    },
  });
  for (const [m, c] of [[false, false], [true, false], [false, true]] as const) {
    const f = sinceFacts(response(m, c), APP, EPIC);
    assert.deepEqual(f.closed.map((x) => [x.number, x.epic]), [[10, true], [11, false], [12, false]], `${m}/${c}`);
    assert.deepEqual(f.truncated, { merged: m, closed: c });
  }
});
