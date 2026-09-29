// Issue #172：postClaim の before と ensureOwnClaim の assignee で、Assignee が自分1人でなければ宣言せず・止まる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { ensureOwnClaim, postClaim } from '../lib/claim.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Claim } from '../lib/queue.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';
const N = 172;
const now = new Date('2026-09-26T12:00:00Z');
const ASSIGNEE_ERROR = '#172: Assignee が自分（@me）1人ではありません（ほかの人（@alice）がアサインされている）。アサインは人が決めます（エージェントは自分をアサインしません）';

let nextId = 1;
function comment(body: string): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `u${id}`, created_at: `2026-09-26T00:${String(Math.floor(id / 60) % 60).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}Z`, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } };
}
const render = (value: Claim): string => `${claudeMark(value.session ?? null)}\n着手宣言です。\n\n${renderBlock('agent-claim', value)}`;
const claimComment = (value: Claim) => comment(render(value));
const manual = (session: string, patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', session, ...patch });

/** コメント一覧を差し替えた偽の io。呼ばれた順を記録する */
function fakeIo(initial: IssueComment[] = []) {
  const list = [...initial];
  const posted: string[] = [];
  const order: string[] = [];
  return {
    list,
    posted,
    order,
    io: {
      async listComments(n: number): Promise<IssueComment[]> {
        assert.equal(n, N);
        order.push('read');
        return [...list];
      },
      async comment(n: number, body: string): Promise<unknown> {
        assert.equal(n, N);
        order.push('post');
        posted.push(body);
        list.push(comment(body));
        return {};
      },
    },
  };
}

const baseOpts = (patch: Record<string, unknown> = {}) => ({
  current: SESSION as string | null,
  manual: true,
  takeover: false,
  stage: 'plan' as const,
  render,
  wait: async () => {},
  now,
  humanClaimStaleHours: 6,
  ...patch,
});

const claimValue = (body: string): Claim => {
  const b = extractBlock(body, 'agent-claim');
  assert.ok(b.found && b.ok, `agent-claim のブロックがありません: ${body}`);
  return b.value as Claim;
};

/** 呼ばれた回数を数える before / assignee */
function counted(result: string | null) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async (): Promise<string | null> => {
      calls++;
      return result;
    },
  };
}

// ---- postClaim の before ----

test('postClaim：before が error を返せば、コメントを読まず書かずに、その文のまま error を返す', async () => {
  const f = fakeIo();
  const before = counted(ASSIGNEE_ERROR);
  const r = await postClaim(f.io, N, baseOpts({ before: before.fn }));
  assert.equal(r.error, ASSIGNEE_ERROR);
  assert.equal(before.calls, 1);
  assert.equal(f.posted.length, 0, '宣言を投稿しない');
  assert.deepEqual(f.order, [], 'listComments・comment より前に止まる');
});

test('postClaim：before が error を返せば、--takeover でも投稿しない', async () => {
  const f = fakeIo([claimComment(manual(OTHER, { stage: 'implement' }))]);
  const r = await postClaim(f.io, N, baseOpts({ takeover: true, before: counted(ASSIGNEE_ERROR).fn }));
  assert.equal(r.error, ASSIGNEE_ERROR);
  assert.equal(f.posted.length, 0);
});

test('postClaim：before が null なら今どおり宣言する（before は最初に1回だけ呼ぶ）', async () => {
  const f = fakeIo();
  let beforeAt = -1;
  const before = counted(null);
  const r = await postClaim(f.io, N, baseOpts({ before: async () => ((beforeAt = f.order.length), before.fn()) }));
  assert.equal(r.error, null);
  assert.equal(before.calls, 1);
  assert.equal(beforeAt, 0, 'listComments・comment より前に呼ぶ');
  assert.equal(f.posted.length, 1);
  const v = claimValue(f.posted[0]!);
  assert.equal(v.by, 'manual');
  assert.equal(v.session, SESSION);
  assert.equal(v.stage, 'plan');
});

test('postClaim：before を渡さなければ今どおり宣言する', async () => {
  const f = fakeIo();
  const r = await postClaim(f.io, N, baseOpts());
  assert.equal(r.error, null);
  assert.equal(f.posted.length, 1);
});

// ---- ensureOwnClaim の assignee ----

test('ensureOwnClaim：自分の宣言があっても、assignee が error を返せば（宣言の後にアサインが変わった）その文のまま止まる', async () => {
  const f = fakeIo([claimComment(manual(SESSION, { stage: 'plan' }))]);
  const assignee = counted(ASSIGNEE_ERROR);
  const r = await ensureOwnClaim(f.io, N, SESSION, assignee.fn);
  assert.equal(r.error, ASSIGNEE_ERROR);
  assert.equal(assignee.calls, 1);
  assert.equal(f.posted.length, 0, 'ensureOwnClaim は書かない');
});

test('ensureOwnClaim：自分の宣言があり、assignee が null なら通る', async () => {
  const f = fakeIo([claimComment(manual(SESSION, { stage: 'plan' }))]);
  const assignee = counted(null);
  assert.equal((await ensureOwnClaim(f.io, N, SESSION, assignee.fn)).error, null);
  assert.equal(assignee.calls, 1);
});

test('ensureOwnClaim：持ち主が自分でなければ、assignee を呼ばずに今と同じ error', async () => {
  const f = fakeIo([claimComment(manual(OTHER, { stage: 'plan' }))]);
  const assignee = counted(ASSIGNEE_ERROR);
  const withAssignee = await ensureOwnClaim(f.io, N, SESSION, assignee.fn);
  const without = await ensureOwnClaim(f.io, N, SESSION);
  assert.ok(without.error);
  assert.equal(withAssignee.error, without.error, '持ち主の確認の error のまま');
  assert.equal(assignee.calls, 0);

  const none = counted(ASSIGNEE_ERROR);
  const empty = await ensureOwnClaim(fakeIo().io, N, SESSION, none.fn);
  assert.ok(empty.error, '宣言が無い');
  assert.notEqual(empty.error, ASSIGNEE_ERROR);
  assert.equal(none.calls, 0);
});

test('ensureOwnClaim：assignee を渡さなければ今と同じ（自分の宣言なら通る）', async () => {
  const f = fakeIo([claimComment(manual(SESSION, { stage: 'implement' }))]);
  assert.equal((await ensureOwnClaim(f.io, N, SESSION)).error, null);
});
