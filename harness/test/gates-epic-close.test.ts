// Issue #412：子課題が全部閉じた Epic を App が閉じる。子を付け替え・外した後に残った Epic を定期実行（closeDoneEpics・onScheduleWithLabels）で閉じ、
// 子が0件・開いた子が残る・別リポジトリのものは閉じないこと、閉じた子の今の親を閉じる onIssue（closed）の動きが変わらないことを、偽の GitHub で確かめる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeAsDone, closeDoneEpics, closeIfSubIssuesDone } from '../gates/epic-close.ts';
import { onScheduleWithLabels } from '../gates/label-apply.ts';
import { onIssue } from '../gates/on-issue.ts';
import { acceptanceFake, APP, config, ctxFor, FakeGitHub, pr } from './support/gate-fixtures.ts';

/** GraphQL で読む Issue の、子課題の形 */
interface Node {
  state?: 'OPEN' | 'CLOSED';
  repo?: string;
  totalCount?: number;
  children: ('OPEN' | 'CLOSED')[];
}

/** 開いた Issue の一覧の1件（REST。sub_issues_summary が子の数と閉じた数） */
const listed = (number: number, summary: { total: number; completed: number } | null | undefined, patch: Record<string, unknown> = {}) => ({
  number, title: `feat: Epic ${number}`, state: 'open', labels: [], user: { login: 'me' }, ...(summary === undefined ? {} : { sub_issues_summary: summary }), ...patch,
});

const issueNode = (n: Node) => ({
  state: n.state ?? 'OPEN',
  repository: { nameWithOwner: n.repo ?? 'o/r' },
  subIssues: { totalCount: n.totalCount ?? n.children.length, nodes: n.children.map((state) => ({ state })) },
});

/** GraphQL の変数のうち Issue の番号（名前は実装に任せ、数の値を拾う） */
const numberOf = (variables: Record<string, unknown> | undefined): number => Number(Object.values(variables ?? {}).find((v) => typeof v === 'number'));

/** 定期実行の照合の偽の GitHub。list は開いた Issue の一覧、nodes は GraphQL で読む Issue（番号 → 子の形） */
function epicFake(list: unknown[], nodes: Record<number, Node>): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&per_page/, () => list)
    .on('POST', /\/graphql/, (_m, body) => {
      const node = nodes[numberOf(body.variables)];
      return { data: { repository: { issue: node ? issueNode(node) : null } } };
    })
    .on('POST', /\/issues\/\d+\/comments$/, () => ({ id: 1, html_url: 'u' }))
    .on('PATCH', /\/issues\/\d+$/, () => ({}));
}

const graphqlCalls = (fake: FakeGitHub) => fake.calls.filter((c) => c.path === '/graphql');

/** 閉じる書き込み（コメントの本文と PATCH の body）。閉じ方が同じかを、文言を固定せずに比べるため */
function closing(fake: FakeGitHub): { comment: string; patch: unknown } {
  const comment = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/comments'));
  const patch = fake.calls.find((c) => c.method === 'PATCH');
  return { comment: String(comment?.body?.body), patch: patch?.body };
}

test('付け替えの後に残った Epic（残りの子が全部閉じている）を、定期実行の照合で閉じる', async () => {
  // #191 の形：子は #195 だけになり、それも閉じている
  const fake = epicFake([listed(191, { total: 1, completed: 1 })], { 191: { children: ['CLOSED'] } });
  const closed = await closeDoneEpics(ctxFor(fake, 'schedule', {}));
  assert.equal(closed, 1);
  assert.deepEqual(fake.writes(), ['comment:parent-closed', 'PATCH /repos/o/r/issues/191']);
  assert.deepEqual(fake.calls.find((c) => c.method === 'PATCH')!.body, { state: 'closed', state_reason: 'completed' });
});

test('一覧の子の数で候補から外すもの（子が0件・数が無い・開いた子が残る・PR・ダッシュボード）は、GraphQL も呼ばず閉じない', async () => {
  const cases: [string, unknown][] = [
    ['子が0件', listed(10, { total: 0, completed: 0 })],
    ['sub_issues_summary が null', listed(11, null)],
    ['sub_issues_summary が無い', listed(12, undefined)],
    ['開いた子が残る', listed(13, { total: 2, completed: 1 })],
    ['PR', listed(14, { total: 1, completed: 1 }, { pull_request: {} })],
    ['ダッシュボード', listed(15, { total: 1, completed: 1 }, { title: config.dashboardIssueTitle, user: { login: APP } })],
  ];
  for (const [name, item] of cases) {
    const fake = epicFake([item], { 10: { children: [] }, 11: { children: [] }, 12: { children: [] }, 13: { children: ['CLOSED', 'OPEN'] }, 14: { children: ['CLOSED'] }, 15: { children: ['CLOSED'] } });
    const closed = await closeDoneEpics(ctxFor(fake, 'schedule', {}));
    assert.equal(closed, 0, name);
    assert.deepEqual(fake.writes(), [], name);
    assert.deepEqual(graphqlCalls(fake), [], `${name}：GraphQL を呼ばない`);
  }
});

test('GraphQL で読み直した子の形が閉じる条件に当たらなければ閉じない（一覧の数が古い・子が0件・別リポジトリ・Epic が閉じている・子が読み切れない）', async () => {
  const cases: [string, Node][] = [
    ['開いた子が残る', { children: ['CLOSED', 'OPEN'] }],
    ['子が0件', { children: [] }],
    ['別リポジトリ', { repo: 'x/y', children: ['CLOSED'] }],
    ['Epic が既に閉じている', { state: 'CLOSED', children: ['CLOSED'] }],
    ['totalCount が nodes の数を超える', { totalCount: 101, children: ['CLOSED'] }],
  ];
  for (const [name, node] of cases) {
    // closeDoneEpics の経路（一覧では候補）
    const sweep = epicFake([listed(20, { total: 1, completed: 1 })], { 20: node });
    assert.equal(await closeDoneEpics(ctxFor(sweep, 'schedule', {})), 0, name);
    assert.deepEqual(sweep.writes(), [], name);

    // closeIfSubIssuesDone を直接
    const direct = epicFake([], { 20: node });
    assert.equal(await closeIfSubIssuesDone(ctxFor(direct, 'schedule', {}), 20), false, name);
    assert.deepEqual(direct.writes(), [], name);
  }
  const ok = epicFake([], { 20: { children: ['CLOSED', 'CLOSED'] } });
  assert.equal(await closeIfSubIssuesDone(ctxFor(ok, 'schedule', {}), 20), true);
  assert.deepEqual(ok.writes(), ['comment:parent-closed', 'PATCH /repos/o/r/issues/20']);
});

test('定期実行の入口（onScheduleWithLabels）が、付け替えの後に残った Epic を閉じる', async () => {
  const fake = epicFake([listed(191, { total: 1, completed: 1 }, { labels: [{ name: 'type:feat' }, { name: 'priority:medium' }, { name: 'area:harness' }] })], { 191: { children: ['CLOSED'] } })
    .on('GET', /\/pulls\?state=open/, () => [])
    .on('GET', /\/pulls\?state=closed/, () => [])
    .on('GET', /\/issues\/(\d+)\/(events|comments)/, () => [])
    .on('POST', /\/issues\/\d+\/labels$/, () => [])
    .on('GET', /\/repos\/o\/r$/, () => ({ allow_auto_merge: true }))
    .on('GET', /\/issues\?state=open&creator=/, () => [{ number: 1, title: config.dashboardIssueTitle, user: { login: APP }, labels: [] }])
    .on('GET', /\/issues\/1$/, () => ({ body: '' }))
    .on('PATCH', /\/issues\/1$/, () => ({}));
  await onScheduleWithLabels(ctxFor(fake, 'schedule', {}), new Date('2026-09-27T01:00:00Z'));
  const w = fake.writes();
  assert.ok(w.includes('comment:parent-closed'), w.join(' '));
  assert.ok(w.includes('PATCH /repos/o/r/issues/191'), w.join(' '));
});

/** onIssue（closed）の偽の GitHub。閉じた子 #3 の今の親を parent で返す（resolveDependents の blocking と同じ応答に入れる） */
function closedChildFake(parent: Record<string, unknown> | null): FakeGitHub {
  return acceptanceFake({ pr: pr() })
    .on('POST', /\/graphql/, () => ({ data: { repository: { issue: { blocking: { nodes: [] }, parent } } } }))
    .on('PATCH', /\/issues\/\d+$/, () => ({}));
}
const closedEvent = { action: 'closed', sender: { login: 'me' }, issue: { number: 3, body: '', state: 'closed', labels: [] } };

test('閉じた子の今の親を閉じる onIssue（closed）の動きは変わらない（子が全部閉じたら閉じ、別リポジトリ・開いた子が残る親は閉じない）', async () => {
  const parent = (patch: Record<string, unknown>) => ({ number: 10, state: 'OPEN', repository: { nameWithOwner: 'o/r' }, subIssues: { totalCount: 2, nodes: [{ state: 'CLOSED' }, { state: 'CLOSED' }] }, ...patch });

  const done = closedChildFake(parent({}));
  await onIssue(ctxFor(done, 'issues', closedEvent));
  assert.deepEqual(done.writes(), ['comment:parent-closed', 'PATCH /repos/o/r/issues/10']);
  assert.deepEqual(done.calls.find((c) => c.method === 'PATCH')!.body, { state: 'closed', state_reason: 'completed' });

  const cases: [string, Record<string, unknown> | null][] = [
    ['親が無い', null],
    ['親が別リポジトリ', parent({ repository: { nameWithOwner: 'x/y' } })],
    ['開いた子が残る', parent({ subIssues: { totalCount: 2, nodes: [{ state: 'CLOSED' }, { state: 'OPEN' }] } })],
  ];
  for (const [name, p] of cases) {
    const fake = closedChildFake(p);
    await onIssue(ctxFor(fake, 'issues', closedEvent));
    assert.deepEqual(fake.writes(), [], name);
  }
});

test('閉じ方（コメントと state_reason）は、閉じた子の今の親・定期実行の照合・closeAsDone で同じ', async () => {
  const direct = epicFake([], {});
  await closeAsDone(ctxFor(direct, 'schedule', {}), 10);

  const sweep = epicFake([listed(10, { total: 1, completed: 1 })], { 10: { children: ['CLOSED'] } });
  await closeDoneEpics(ctxFor(sweep, 'schedule', {}));

  const child = closedChildFake({ number: 10, state: 'OPEN', repository: { nameWithOwner: 'o/r' }, subIssues: { totalCount: 1, nodes: [{ state: 'CLOSED' }] } });
  await onIssue(ctxFor(child, 'issues', closedEvent));

  assert.deepEqual(direct.writes(), ['comment:parent-closed', 'PATCH /repos/o/r/issues/10']);
  assert.deepEqual(closing(sweep), closing(direct));
  assert.deepEqual(closing(child), closing(direct));
});
