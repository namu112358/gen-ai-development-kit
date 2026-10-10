import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { GitHub } from '../lib/github.ts';
import { fillLabels } from '../lib/label-fill.ts';
import { APP, config, FakeGitHub } from './support/gate-fixtures.ts';

// label-fill（Issue #538）：label-triage の記録の notApplied にある priority:*・area:* だけを付け、理由のコメントを書く

const REASON = '本文の影響範囲が広いので high にした';

function triage(notApplied: unknown, login = APP) {
  return {
    id: 100,
    html_url: 'https://github.com/o/r/issues/5#issuecomment-100',
    user: { login, type: 'Bot' },
    author_association: 'NONE',
    body: [appMark('label-triage'), '分類', '', renderBlock('agent-app', { version: 1, notApplied })].join('\n'),
  };
}

const NOT_APPLIED = [
  { question: 'priority', choice: 'high', probability: 0.67, label: 'priority:high', reason: '下限 70% に届かない' },
  { question: 'area', choice: 'harness', probability: 0.6, label: 'area:harness', reason: '下限に届かない' },
];

function world(labels: string[], comments: unknown[], extra: Record<string, unknown> = {}) {
  const fake = new FakeGitHub()
    .on('GET', /\/issues\/5$/, () => ({ number: 5, labels: labels.map((name) => ({ name })), ...extra }))
    .on('GET', /\/issues\/5\/comments\?/, () => comments)
    .on('POST', /\/issues\/5\/labels$/, () => [])
    .on('POST', /\/issues\/5\/comments$/, () => ({ id: 200, html_url: 'https://github.com/o/r/issues/5#issuecomment-200' }));
  return { fake, gh: new GitHub(fake, 'o/r') };
}

test('notApplied の priority:high が付き、提案・確率・根拠・Claude の目印のコメントが残る', async () => {
  const { fake, gh } = world(['type:feat'], [triage(NOT_APPLIED)]);
  const r = await fillLabels(gh, config, 5, ['priority:high'], REASON, 'sess1');
  assert.deepEqual(r, { kind: 'filled', added: ['priority:high'], skipped: [], comment: 'https://github.com/o/r/issues/5#issuecomment-200' });
  const w = fake.writes();
  assert.equal(w[0], 'label+priority:high');
  assert.equal(w.length, 2);
  const body = String(fake.calls.at(-1)!.body.body);
  for (const s of ['priority:high', '67%', REASON, '<!-- agent-harness:claude session=sess1 -->']) assert.ok(body.includes(s), s);
});

test('notApplied に無い priority・保護ラベル・type:* は書き込み無しで拒む', async () => {
  for (const label of ['priority:medium', 'agent:plan-ok', 'type:feat']) {
    const { fake, gh } = world([], [triage(NOT_APPLIED)]);
    const r = await fillLabels(gh, config, 5, [label], REASON, null);
    assert.equal(r.kind, 'rejected', label);
    assert.deepEqual(fake.writes(), [], label);
  }
});

test('同じ種類のラベルが既にあれば拒む', async () => {
  const { fake, gh } = world(['priority:low'], [triage(NOT_APPLIED)]);
  assert.equal((await fillLabels(gh, config, 5, ['priority:high'], REASON, null)).kind, 'rejected');
  assert.deepEqual(fake.writes(), []);
});

test('label-triage の記録が無ければ（App 以外の名義の同じ形も）何もしない', async () => {
  for (const comments of [[], [triage(NOT_APPLIED, 'someone')]]) {
    const { fake, gh } = world([], comments);
    assert.deepEqual(await fillLabels(gh, config, 5, ['priority:high'], REASON, null), { kind: 'no-record' });
    assert.deepEqual(fake.writes(), []);
  }
});

test('頼んだラベルが既に付いていれば、付けず、コメントも書かない（コメントが既にあるとき）', async () => {
  const first = world([], [triage(NOT_APPLIED)]);
  await fillLabels(first.gh, config, 5, ['priority:high'], REASON, 's');
  const written = { id: 201, html_url: 'u', user: null, author_association: 'OWNER', body: String(first.fake.calls.at(-1)!.body.body) };
  const { fake, gh } = world(['priority:high'], [triage(NOT_APPLIED), written]);
  assert.deepEqual(await fillLabels(gh, config, 5, ['priority:high'], REASON, 's'), { kind: 'filled', added: [], skipped: ['priority:high'], comment: null });
  assert.deepEqual(fake.writes(), []);
});

test('notApplied の area:harness は area が無ければ付く', async () => {
  const { fake, gh } = world([], [triage(NOT_APPLIED)]);
  const r = await fillLabels(gh, config, 5, ['area:harness'], REASON, null);
  assert.equal(r.kind === 'filled' && r.added[0], 'area:harness');
  assert.equal(fake.writes()[0], 'label+area:harness');
});

test('reason が空・PR は拒み、書き込まない', async () => {
  const a = world([], [triage(NOT_APPLIED)]);
  assert.equal((await fillLabels(a.gh, config, 5, ['priority:high'], '  ', null)).kind, 'rejected');
  assert.deepEqual(a.fake.writes(), []);
  const b = world([], [triage(NOT_APPLIED)], { pull_request: {} });
  assert.equal((await fillLabels(b.gh, config, 5, ['priority:high'], REASON, null)).kind, 'rejected');
  assert.deepEqual(b.fake.writes(), []);
});
