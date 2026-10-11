// Issue #656：同じセッションの着手宣言の段階更新・解除を、自分の最新の宣言コメントの書き換え（PATCH）にして history に段階を足す。新しいコメントに戻る場合・取り下げ・Transport・停滞の時刻も確かめる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import { postClaim, writeClaim, type ClaimIo } from '../lib/claim.ts';
import { claimActivityAt, claimOf, critiqueClaimedBefore } from '../lib/facts.ts';
import { FetchTransport, GhTransport, GitHub, type GhRunner, type IssueComment } from '../lib/github.ts';
import { claimAt } from '../lib/push-claim.ts';
import type { Claim, StoredClaim } from '../lib/queue.ts';
import { stalledClaims } from '../lib/stalled-claim.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';
const N = 656;
const T0 = Date.parse('2026-10-10T17:00:00.000Z');
const iso = (k: number, extraMin = 0) => new Date(T0 + (k * 10 + extraMin) * 60_000).toISOString();
const render = (v: StoredClaim): string => `${claudeMark(v.session ?? null)}\n着手宣言です。\n\n${renderBlock('agent-claim', v)}`;
const mk = (id: number, body: string, at: string, updated = at): IssueComment => ({ id, body, html_url: `u${id}`, created_at: at, updated_at: updated, author_association: 'OWNER', user: { login: 'me', type: 'User' } }) as IssueComment;
const claimC = (id: number, v: StoredClaim, at = iso(0), updated = at) => mk(id, render(v), at, updated);
const own = (id: number, extra: Partial<StoredClaim> = {}) => claimC(id, { by: 'manual', session: SESSION, at: iso(0), stage: 'plan', ...extra } as StoredClaim);
const PLAN = `${claudeMark(SESSION)}\n## 計画\n\n${renderBlock('agent-plan', { version: 1, issue: N, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['a.md'] })}`;

/** 偽の io。comment は ID を1ずつ増やす。edit: yes は PATCH を反映、none は editComment 無し、throw は投げる。hideNext は次の listComments だけ最後のコメントを隠す */
function fakeIo(edit: 'yes' | 'none' | 'throw', initial: IssueComment[] = []) {
  const list = [...initial];
  const s = { clock: T0, hideNext: false, edits: 0, posted: 0 };
  let id = Math.max(0, ...list.map((c) => c.id));
  const io: ClaimIo = {
    async listComments() {
      const r = s.hideNext ? list.slice(0, -1) : [...list];
      s.hideNext = false;
      return r;
    },
    async comment(_n, body) {
      s.posted++;
      list.push(mk(++id, body, new Date(s.clock).toISOString()));
      return {};
    },
  };
  if (edit !== 'none') {
    io.editComment = async (cid, body) => {
      s.edits++;
      if (edit === 'throw') throw new Error('boom');
      const c = list.find((x) => x.id === cid)!;
      c.body = body;
      c.updated_at = new Date(s.clock).toISOString();
      return {};
    };
  }
  return { io, list, s };
}
const postAt = async (f: ReturnType<typeof fakeIo>, k: number, stage: Claim['stage'], patch: Record<string, unknown> = {}) => {
  f.s.clock = Date.parse(iso(k));
  return postClaim(f.io, N, { current: SESSION, manual: true, takeover: false, stage, render, wait: async () => {}, now: new Date(f.s.clock), humanClaimStaleHours: 6, ...patch });
};
async function flow(edit: 'yes' | 'none') {
  const f = fakeIo(edit);
  for (const [k, stage] of [[0, 'plan'], [1, 'plan-critique']] as const) assert.equal((await postAt(f, k, stage)).error, null);
  f.s.clock = Date.parse(iso(2));
  await f.io.comment(N, PLAN);
  const planId = f.list.at(-1)!.id;
  f.s.clock = Date.parse(iso(3));
  f.s.hideNext = true; // このときの一覧の読みだけ計画を隠す
  await writeClaim(f.io, N, { by: 'manual', session: SESSION, at: iso(3), stage: 'plan-gate' }, { render, minAfter: planId });
  assert.equal((await postAt(f, 4, 'implement')).error, null);
  const owner = claimOf(f.list);
  return {
    f,
    read: {
      owner,
      critique: critiqueClaimedBefore(f.list, planId),
      atPush: [-1, 0, 1, 2, 3, 4].map((k) => claimAt(f.list, iso(k, 5))?.stage ?? null),
      stalled: stalledClaims([{ pr: { number: 5, title: 't', html_url: 'u' }, claim: owner, headCommitAt: null }], new Date(T0 + 10 * 3600_000), 60),
    },
  };
}

test('plan → plan-critique → 計画 → plan-gate → implement：書き換えありでも無しでも読む側の答えが同じで、書き換えありは宣言が1件のまま', async () => {
  const a = await flow('yes');
  const b = await flow('none');
  assert.equal(a.f.list.filter((c) => c.body.includes("agent-claim")).length, 1);
  assert.equal(a.f.s.edits, 3);
  assert.equal(b.f.list.filter((c) => c.body.includes("agent-claim")).length, 4);
  assert.deepEqual(a.read, b.read);
  assert.equal(a.read.owner?.stage, 'implement');
  assert.equal(a.read.critique, true);
  assert.deepEqual(a.read.atPush, [null, 'plan', 'plan-critique', null, 'plan-gate', 'implement'], 'plan-gate は計画の後に並ぶ');
});
const other = (id: number, extra: Partial<StoredClaim> = {}) => claimC(id, { by: 'manual', session: OTHER, at: iso(0), stage: 'plan', ...extra } as StoredClaim);
const history30 = Array.from({ length: 30 }, (_, i) => ({ stage: 'plan', at: iso(0), ...(i > 0 ? { after: 1 } : {}) }));
const fresh = { len: 2, posted: 1, session: SESSION, stage: 'implement' };
type Row = { name: string; edit: 'yes' | 'none' | 'throw'; initial: IssueComment[]; opts?: Record<string, unknown>; wait?: (l: IssueComment[]) => void; want: { len: number; posted: number; edits: number; session: string; stage?: string } };
const rows: Row[] = [
  { name: 'editComment が無ければ新しいコメント', edit: 'none', initial: [own(1)], want: { ...fresh, edits: 0 } },
  { name: '書き換える先が無ければ新しいコメント', edit: 'yes', initial: [], want: { ...fresh, len: 1, edits: 0 } },
  { name: 'history が30件なら新しいコメント', edit: 'yes', initial: [own(1, { history: history30 } as Partial<StoredClaim>)], want: { ...fresh, edits: 0 } },
  { name: 'PATCH が投げたら新しいコメント', edit: 'throw', initial: [own(1)], want: { ...fresh, edits: 1 } },
  { name: '読み直しの取り下げは自分のコメントの書き換えで解除（コメントは増えず、持ち主は先の側）', edit: 'yes', initial: [own(5)], wait: (l) => void l.unshift(other(3)), want: { len: 2, posted: 0, edits: 2, session: OTHER } },
  { name: '--takeover の宣言の取り下げも持ち主は先の側のまま', edit: 'yes', initial: [], opts: { takeover: true }, wait: (l) => void l.push(other(6, { takeover: true })), want: { len: 2, posted: 1, edits: 1, session: OTHER } },
];
for (const r of rows) {
  test(`postClaim：${r.name}`, async () => {
    const f = fakeIo(r.edit, r.initial);
    const res = await postAt(f, 1, 'implement', { ...r.opts, wait: async () => void r.wait?.(f.list) });
    assert.equal(f.list.length, r.want.len);
    assert.equal(f.s.posted, r.want.posted);
    assert.equal(f.s.edits, r.want.edits);
    const owner = claimOf(f.list);
    assert.equal(owner?.session, r.want.session);
    if (r.want.stage) assert.equal(owner?.stage, r.want.stage);
    assert.equal(res.error === null, r.want.session === SESSION, '負けたら error');
  });
}
test('writeClaim：--takeover と Routine は書き換えずに新しいコメントにする', async () => {
  const values: Claim[] = [{ by: 'manual', session: SESSION, at: iso(1), stage: 'implement', takeover: true }, { by: 'routine', session: SESSION, at: iso(1), stage: 'implement' }];
  for (const v of values) {
    const f = fakeIo('yes', [own(1)]);
    const r = await writeClaim(f.io, N, v, { render });
    assert.equal(r.rewritten, false);
    assert.equal(f.s.posted, 1);
    assert.equal(f.s.edits, 0);
  }
});
test('GitHub.editComment：FetchTransport・GhTransport のどちらでも PATCH repos/o/r/issues/comments/7 に { body } を送る', async () => {
  const real = globalThis.fetch;
  const seen: { url: string; method?: string; body?: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => (seen.push({ url, method: init.method, body: init.body }), new Response('{}', { status: 200 }))) as unknown as typeof fetch;
  try {
    await new GitHub(new FetchTransport('tok'), 'o/r').editComment(7, 'x');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, 'PATCH');
  assert.match(seen[0]!.url, /\/repos\/o\/r\/issues\/comments\/7$/);
  assert.deepEqual(JSON.parse(seen[0]!.body as string), { body: 'x' });
  const calls: { args: string[]; input: string | undefined }[] = [];  const run: GhRunner = (args, input) => (calls.push({ args: [...args], input }), { status: 0, stdout: '{}', stderr: '' });
  await new GitHub(new GhTransport({}, run), 'o/r').editComment(7, 'x');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args.slice(0, 4), ['api', '--method', 'PATCH', 'repos/o/r/issues/comments/7']);
  assert.deepEqual(JSON.parse(calls[0]!.input!), { body: 'x' });
});

test('claimActivityAt：history の段階の at が未来でも、コメントの updated_at が今ならその updated_at を返す', () => {
  const future = '2027-01-01T00:00:00.000Z';
  const history = [{ stage: 'plan', at: iso(0) }, { stage: 'fix', at: future, after: 1 }];
  const c = claimC(1, { by: 'manual', session: SESSION, at: future, stage: 'fix', history } as StoredClaim, iso(0), '2026-10-11T00:00:00.000Z');
  assert.equal(claimActivityAt([c]), '2026-10-11T00:00:00.000Z');
});
