// Issue #638：fix・sync は Merge 済み・Closed の PR で止まる（push して消えたブランチを作り直さない）。開いた PR では今までどおり宣言する
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import { closedPrStop, postClaim, prStageStop, type PullState } from '../lib/claim.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Claim, ClaimStage } from '../lib/queue.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const N = 638;
const now = new Date('2026-10-11T12:00:00Z');

const MERGED: PullState = { number: N, state: 'closed', merged: true, merged_at: '2026-10-10T00:00:00Z' };
const MERGED_AT_ONLY: PullState = { number: N, state: 'closed', merged_at: '2026-10-10T00:00:00Z' };
const CLOSED: PullState = { number: N, state: 'closed', merged: false, merged_at: null };
const OPEN: PullState = { number: N, state: 'open', merged: false, merged_at: null };

const render = (value: Claim): string => `${claudeMark(value.session ?? null)}\n着手宣言です。\n\n${renderBlock('agent-claim', value)}`;

/** 呼ばれた回数を数える getPull */
function fakePull(pr: PullState | null) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async (n: number): Promise<PullState | null> => {
      assert.equal(n, N);
      calls++;
      return pr;
    },
  };
}

/** コメント一覧を持つ偽の io。comment() は一覧の末尾に足す */
function fakeIo() {
  const list: IssueComment[] = [];
  const posted: string[] = [];
  let nextId = 1;
  return {
    posted,
    io: {
      async listComments(n: number): Promise<IssueComment[]> {
        assert.equal(n, N);
        return [...list];
      },
      async comment(n: number, body: string): Promise<unknown> {
        assert.equal(n, N);
        posted.push(body);
        const id = nextId++;
        list.push({ id, body, html_url: `u${id}`, created_at: `2026-10-11T00:00:${String(id).padStart(2, '0')}Z`, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } });
        return {};
      },
    },
  };
}

const baseOpts = (stage: ClaimStage, before: () => Promise<string | null>) => ({
  current: SESSION as string | null,
  manual: true,
  takeover: false,
  stage,
  render,
  wait: async () => {},
  now,
  humanClaimStaleHours: 6,
  before,
});

// ---- closedPrStop ----

test('closedPrStop：Merge 済み（merged か merged_at）は「Merge 済み」と PR 番号を含む文、未 Merge の Closed は「Closed」を含む文', () => {
  const cases: Array<{ name: string; pr: PullState; want: string }> = [
    { name: 'merged:true', pr: MERGED, want: 'Merge 済み' },
    { name: 'merged_at だけ', pr: MERGED_AT_ONLY, want: 'Merge 済み' },
    { name: 'state closed・未 Merge', pr: CLOSED, want: 'Closed' },
  ];
  for (const c of cases) {
    const r = closedPrStop(c.pr);
    assert.ok(typeof r === 'string', `${c.name}: 止める文がありません`);
    assert.ok(r.includes(c.want), `${c.name}: 「${c.want}」を含みません: ${r}`);
    assert.ok(r.includes(`PR #${N}`), `${c.name}: PR 番号を含みません: ${r}`);
  }
  assert.ok(!closedPrStop(CLOSED)!.includes('Merge 済み'), '未 Merge の Closed を Merge 済みと書いています');
});

test('closedPrStop：開いた PR と null は null', () => {
  assert.equal(closedPrStop(OPEN), null);
  assert.equal(closedPrStop({ number: N, state: 'open' }), null);
  assert.equal(closedPrStop(null), null);
});

// ---- prStageStop ----

test('prStageStop：fix・sync では PR を読み、Merge 済み・Closed なら止める文、開いた PR・null なら null', async () => {
  for (const stage of ['fix', 'sync'] as const) {
    const cases: Array<{ pr: PullState | null; want: string | null }> = [
      { pr: MERGED, want: 'Merge 済み' },
      { pr: CLOSED, want: 'Closed' },
      { pr: OPEN, want: null },
      { pr: null, want: null },
    ];
    for (const c of cases) {
      const pull = fakePull(c.pr);
      const r = await prStageStop(pull.fn, N, stage);
      assert.equal(pull.calls, 1, `${stage}: getPull を1回呼んでいません`);
      if (c.want === null) assert.equal(r, null, `${stage}: ${JSON.stringify(c.pr)} で止めています`);
      else assert.ok(typeof r === 'string' && r.includes(c.want), `${stage}: 「${c.want}」を含みません: ${r}`);
    }
  }
});

test('prStageStop：fix・sync 以外の段階と段階なしでは getPull を呼ばずに null（Merge 済みでも）', async () => {
  for (const stage of ['judge', 'implement', 'plan', 'plan-critique', 'plan-gate', undefined] as const) {
    const pull = fakePull(MERGED);
    assert.equal(await prStageStop(pull.fn, N, stage), null, `${stage}: 止めています`);
    assert.equal(pull.calls, 0, `${stage}: getPull を呼んでいます`);
  }
});

// ---- postClaim に before として渡す ----

test('postClaim：before が prStageStop なら、fix・sync で Merge 済み・Closed の PR は宣言を投稿せずに error を返す', async () => {
  for (const stage of ['fix', 'sync'] as const) {
    for (const [pr, want] of [
      [MERGED, 'Merge 済み'],
      [CLOSED, 'Closed'],
    ] as const) {
      const f = fakeIo();
      const pull = fakePull(pr);
      const r = await postClaim(f.io, N, baseOpts(stage, () => prStageStop(pull.fn, N, stage)));
      assert.ok(typeof r.error === 'string' && r.error.includes(want), `${stage}: 「${want}」を含む error になりません: ${r.error}`);
      assert.equal(f.posted.length, 0, `${stage}: 宣言を投稿しています`);
    }
  }
});

test('postClaim：before が prStageStop なら、fix・sync で開いた PR は今どおり宣言を投稿する', async () => {
  for (const stage of ['fix', 'sync'] as const) {
    const f = fakeIo();
    const pull = fakePull(OPEN);
    const r = await postClaim(f.io, N, baseOpts(stage, () => prStageStop(pull.fn, N, stage)));
    assert.equal(r.error, null, `${stage}: ${r.error}`);
    assert.equal(f.posted.length, 1, `${stage}: 宣言を1回投稿していません`);
    assert.ok(f.posted[0]!.includes('agent-claim'), `${stage}: 宣言のブロックがありません`);
    assert.equal(pull.calls, 1);
  }
});
