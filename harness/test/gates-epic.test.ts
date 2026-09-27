import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { childMarker, type SplitChild } from '../lib/epic.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, ctxFor, pr } from './support/gate-fixtures.ts';

const split: SplitChild[] = [
  { title: 'feat(x): 一つ目', goal: 'g1', requirements: ['r1'], acceptanceCriteria: ['a1'], files: ['src/a.ts'], dependsOn: [] },
  { title: 'docs: 二つ目', goal: 'g2', requirements: ['r2'], acceptanceCriteria: ['a2'], files: ['docs/**'], dependsOn: [0] },
];
const plan = { version: 1, issue: 3, risk: 'critical', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [], split };
const event = (p: unknown) => ({
  action: 'created',
  issue: { number: 3, labels: [{ name: 'agent:ready' }, { name: 'priority:high' }, { name: 'risk:critical' }], state: 'open' },
  comment: { id: 80, body: renderBlock('agent-plan', p), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
});

interface Item { id: number; number: number; body: string; labels: { name: string }[]; user: { login: string } }

interface Blocker { id: number; number: number; state: string; repository_url: string }

/** App の記録コメント（親 #3 に既にあるもの） */
const appRecord = (id: number, kind: string, value: unknown) => ({
  id, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\nx\n${renderBlock('agent-app', value)}`,
});

/**
 * 親 #3 の Sub-issues・App が作った Issue・依存・コメントを持つ偽の GitHub。子は #100 から番号を振る。
 * #3 へ投稿したコメントは #3 のコメント一覧に積む。failOn に一致する POST は失敗させる
 */
function epicFake(state: { subs?: Item[]; created?: Item[]; blockedBy?: Record<number, number[]>; parentBlockers?: Blocker[]; comments?: unknown[]; failOn?: RegExp } = {}) {
  const subs = state.subs ?? [];
  const created = state.created ?? [];
  const comments = state.comments ?? [];
  let next = 100 + subs.length + created.length;
  const fake = acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => comments)
    .on('POST', /\/issues\/3\/comments$/, (_m, body) => {
      const c = { id: 500 + comments.length, body: body.body, html_url: 'u', created_at: '', updated_at: '', author_association: 'NONE', user: { login: APP, type: 'Bot' } };
      comments.push(c);
      return c;
    })
    .on('GET', /\/issues\/3\/sub_issues/, () => subs)
    .on('GET', /\/issues\?state=all&creator=/, () => created)
    .on('POST', /\/repos\/o\/r\/issues$/, (_m, body) => {
      const item = { id: 9000 + next, number: next++, body: body.body, labels: [], user: { login: APP } };
      created.push(item);
      return item;
    })
    .on('POST', /\/issues\/3\/sub_issues$/, () => ({}))
    .on('GET', /\/issues\/(\d+)\/dependencies\/blocked_by/, (m) => (state.blockedBy?.[Number(m[1])] ?? []).map((number) => ({ number })))
    .on('POST', /\/issues\/\d+\/dependencies\/blocked_by$/, () => ({}))
    .on('GET', /\/issues\/3\/dependencies\/blocked_by/, () => state.parentBlockers ?? []);
  const failOn = state.failOn;
  if (failOn) {
    fake.on('POST', failOn, (m) => {
      throw new Error(`boom ${m.input}`);
    });
  }
  return fake;
}

const posts = (fake: ReturnType<typeof epicFake>, re: RegExp) => fake.calls.filter((c) => c.method === 'POST' && re.test(c.path));
const record = (fake: ReturnType<typeof epicFake>, kind: string) => {
  const body = posts(fake, /\/issues\/3\/comments$/).map((c) => String(c.body.body)).find((b) => b.includes(`kind=${kind} `))!;
  const block = extractBlock(body, 'agent-app');
  return { body, value: block.found && block.ok ? (block.value as any) : null };
};

test('split の計画：親に epic、子 Issue・Sub-issues・依存・ラベル・記録を作る（plan-ok は付けない）', async () => {
  const fake = epicFake();
  await onComment(ctxFor(fake, 'issue_comment', event(plan)));
  assert.deepEqual(fake.writes(), [
    'label-agent:plan-ok', 'label+epic', 'comment:plan-gate',
    'POST /repos/o/r/issues', 'POST /repos/o/r/issues/3/sub_issues',
    'POST /repos/o/r/issues', 'POST /repos/o/r/issues/3/sub_issues',
    'POST /repos/o/r/issues/101/dependencies/blocked_by',
    'label+agent:ready,priority:high', 'label+agent:ready,priority:high',
    'comment:epic-split', 'check:agent/plan-link=success',
  ]);
  const issues = posts(fake, /\/issues$/);
  assert.deepEqual(issues.map((c) => c.body.title), ['feat(x): 一つ目', 'docs: 二つ目']);
  assert.match(issues[0]!.body.body, /^### Goal\n\ng1\n/);
  assert.match(issues[1]!.body.body, /Epic #3 の子課題/);
  assert.match(issues[1]!.body.body, /#100 の後/);
  assert.ok(issues[1]!.body.body.endsWith(childMarker(3, 1)));
  assert.deepEqual(posts(fake, /sub_issues$/).map((c) => c.body), [{ sub_issue_id: 9100 }, { sub_issue_id: 9101 }]);
  assert.deepEqual(posts(fake, /blocked_by$/).map((c) => c.body), [{ issue_id: 9100 }]);
  assert.deepEqual(posts(fake, /\/issues\/\d+\/labels$/).map((c) => c.path.match(/issues\/(\d+)/)![1]), ['3', '100', '101']);
  const gate = record(fake, 'plan-gate').value;
  assert.equal(gate.pass, true);
  assert.equal(gate.plan.split.length, 2, '計画の写しに split が入る');
  assert.deepEqual(record(fake, 'epic-split').value, { version: 1, planCommentId: 80, children: [100, 101] });
});

test('途中まで作られた状態から再実行しても、子 Issue を二重に作らない', async () => {
  const mk = (number: number, index: number, labels: string[] = [], login = APP): Item => ({ id: 9000 + number, number, body: `b\n${childMarker(3, index)}`, labels: labels.map((name) => ({ name })), user: { login } });
  const fake = epicFake({
    // #100 は Sub-issue 登録とラベルまで済み。#50 は App 以外が目印を真似たもの（使わない）。#101 は作ったが Sub-issue 未登録
    subs: [mk(100, 0, ['agent:ready', 'priority:high']), mk(50, 1, [], 'me')],
    created: [mk(100, 0, ['agent:ready', 'priority:high']), mk(101, 1), mk(102, 0), { ...mk(103, 0), body: childMarker(4, 1) }],
    blockedBy: { 101: [100] },
    comments: [appRecord(1, 'plan-gate', { version: 1, planCommentId: 80, pass: true, reasons: [], plan })],
  });
  await onComment(ctxFor(fake, 'issue_comment', event(plan)));
  assert.ok(!fake.writes().includes('comment:plan-gate'), '同じ計画の通過の記録は二重に残さない');
  assert.equal(posts(fake, /\/issues$/).length, 0, '作り直さない');
  assert.deepEqual(posts(fake, /sub_issues$/).map((c) => c.body), [{ sub_issue_id: 9101 }], '未登録の Sub-issue だけ登録する');
  assert.equal(posts(fake, /blocked_by$/).length, 0, '登録済みの依存は足さない');
  assert.deepEqual(posts(fake, /\/issues\/\d+\/labels$/).map((c) => c.path.match(/issues\/(\d+)/)![1]), ['3', '101']);
  assert.deepEqual(record(fake, 'epic-split').value.children, [100, 101]);
});

const mkChild = (number: number, index: number): Item => ({ id: 9000 + number, number, body: `b\n${childMarker(3, index)}`, labels: [], user: { login: APP } });

test('親の停止（hold / blocked / waiting）と開いた blocker を、agent:ready より先に子へ引き継ぐ', async () => {
  const blocker = (number: number, state = 'open', repo = 'o/r'): Blocker => ({ id: 7000 + number, number, state, repository_url: `https://api.github.com/repos/${repo}` });
  const fake = epicFake({ parentBlockers: [blocker(40), blocker(41, 'closed'), blocker(42, 'open', 'o/other')], blockedBy: { 101: [40] } });
  const ev = event(plan);
  ev.issue.labels.push({ name: 'agent:hold' }, { name: 'agent:blocked' }, { name: 'agent:waiting' });
  await onComment(ctxFor(fake, 'issue_comment', ev));
  assert.deepEqual(fake.writes(), [
    'label-agent:plan-ok', 'label+epic', 'comment:plan-gate',
    'POST /repos/o/r/issues', 'POST /repos/o/r/issues/3/sub_issues',
    'POST /repos/o/r/issues', 'POST /repos/o/r/issues/3/sub_issues',
    'POST /repos/o/r/issues/100/dependencies/blocked_by',
    'POST /repos/o/r/issues/101/dependencies/blocked_by',
    'label+agent:hold,agent:blocked,agent:waiting', 'comment:epic-inherit',
    'label+agent:hold,agent:blocked,agent:waiting', 'comment:epic-inherit',
    'label+agent:ready,priority:high', 'label+agent:ready,priority:high',
    'comment:epic-split', 'check:agent/plan-link=success',
  ]);
  const deps = posts(fake, /blocked_by$/).map((c) => `${c.path.match(/issues\/(\d+)/)![1]}<-${c.body.issue_id}`);
  assert.deepEqual(deps, ['100<-7040', '101<-9100'], '親の開いた blocker を全部の子に。閉じた・別リポジトリのもの、登録済みのものは足さない');
  const inherit = posts(fake, /\/issues\/100\/comments$/).map((c) => String(c.body.body));
  assert.match(inherit[0]!, /reason code=other/, 'blocked を付けるときは理由コードを残す');
});

test('既に子課題に分けた Issue に別の計画が来たら、作らずに plan-review（理由コード resplit）', async () => {
  for (const state of [
    { comments: [appRecord(1, 'epic-split', { version: 1, planCommentId: 60, children: [100, 101] })] },
    { created: [mkChild(100, 0)] },
  ]) {
    const fake = epicFake(state);
    await onComment(ctxFor(fake, 'issue_comment', event(plan)));
    assert.deepEqual(fake.writes(), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate', 'check:agent/plan-link=success']);
    const gate = record(fake, 'plan-gate');
    assert.match(gate.body, /reason code=resplit/);
    assert.equal(gate.value.pass, false);
    assert.ok(gate.value.reasons.some((r: string) => r.includes('#100')));
  }
});

test('同じ計画コメントの再実行は、分け直しとして止めずに続きから作る（epic-split の記録があっても）', async () => {
  const fake = epicFake({
    created: [mkChild(100, 0)],
    comments: [appRecord(1, 'epic-split', { version: 1, planCommentId: 80, children: [100, 101] })],
  });
  await onComment(ctxFor(fake, 'issue_comment', event(plan)));
  assert.ok(!fake.writes().includes('label+agent:plan-review'));
  assert.equal(posts(fake, /\/issues$/).length, 1, '足りない子だけ作る');
  assert.equal(record(fake, 'epic-split').value.planCommentId, 80);
});

test('子課題を作る途中で失敗したら、親を agent:blocked（理由コード split-failed）にして失敗を投げ直す。やり直しは続きから', async () => {
  const fake = epicFake({ failOn: /\/issues\/101\/dependencies\/blocked_by$/ });
  await assert.rejects(onComment(ctxFor(fake, 'issue_comment', event(plan))), /boom/);
  const writes = fake.writes();
  assert.deepEqual(writes.slice(-2), ['label+agent:blocked', 'comment:epic-split-failed']);
  assert.match(posts(fake, /\/issues\/3\/comments$/).at(-1)!.body.body, /reason code=split-failed/);
  assert.ok(!writes.some((w) => w.startsWith('label+agent:ready')), 'ready は付けない');

  // 人が blocked を外してやり直す：作った子と投稿した記録はそのまま
  const posted = posts(fake, /\/issues\/3\/comments$/).map((c, k) => ({ ...appRecord(500 + k, 'x', {}), body: String(c.body.body) }));
  const retry = epicFake({ subs: [mkChild(100, 0), mkChild(101, 1)], created: [mkChild(100, 0), mkChild(101, 1)], blockedBy: {}, comments: posted });
  await onComment(ctxFor(retry, 'issue_comment', event(plan)));
  assert.deepEqual(retry.writes(), [
    'label-agent:plan-ok', 'label+epic',
    'POST /repos/o/r/issues/101/dependencies/blocked_by',
    'label+agent:ready,priority:high', 'label+agent:ready,priority:high',
    'comment:epic-split', 'check:agent/plan-link=success',
  ]);
});

test('兄弟のファイルが重なる split は子 Issue を作らず plan-review（理由コード split-invalid）', async () => {
  const fake = epicFake();
  await onComment(ctxFor(fake, 'issue_comment', event({ ...plan, split: [split[0], { ...split[1], files: ['src/**'] }] })));
  assert.deepEqual(fake.writes(), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate', 'check:agent/plan-link=success']);
  const gate = record(fake, 'plan-gate');
  assert.match(gate.body, /reason code=split-invalid/);
  assert.equal(gate.value.pass, false);
  assert.ok(gate.value.reasons.some((r: string) => r.includes('重なります')));
});

test('split の計画でも人の判断を求めていれば止める（Risk では止めない）', async () => {
  const fake = epicFake();
  await onComment(ctxFor(fake, 'issue_comment', event({ ...plan, needsHuman: true })));
  assert.ok(fake.writes().includes('label+agent:plan-review'));
  const gate = record(fake, 'plan-gate');
  assert.match(gate.body, /reason code=needs-decision/);
  assert.equal(gate.value.reasons.length, 1);
});
