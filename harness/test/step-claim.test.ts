// Issue #306：agent.ts step の宣言の投稿と解除（applyStepClaims）。node なら宣言を投稿して node のまま返し、読み直しで先に宣言したほかのセッションがいれば
// stop claimed（released false）に変える。decision.claim が null なら投稿しない。stop なら release の番号ごとに解除のコメント（released: true）を書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Claim } from '../lib/queue.ts';
import { applyStepClaims, decideStep } from '../lib/step.ts';
import { fleetIssue, manual, N, NOW, openPr, OTHER, PR, planOkFacts, SESSION, stepInput } from './support/step-fixtures.ts';

let nextId = 1;
function comment(body: string): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `u${id}`, created_at: `2026-09-26T00:${String(Math.floor(id / 60) % 60).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}Z`, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } };
}
const render = (value: Claim): string => `${claudeMark(value.session ?? null)}\n着手宣言です。\n\n${renderBlock('agent-claim', value)}`;

const claimValue = (body: string): Claim => {
  const b = extractBlock(body, 'agent-claim');
  assert.ok(b.found && b.ok, `agent-claim のブロックがありません: ${body}`);
  return b.value as Claim;
};

/** 番号ごとのコメント一覧を持つ偽の io。beforePost は最初の投稿が一覧に入る直前に呼ばれる */
function fakeIo(hooks: { beforePost?: (n: number, list: IssueComment[]) => void } = {}) {
  const lists = new Map<number, IssueComment[]>();
  const listOf = (n: number) => lists.get(n) ?? (lists.set(n, []), lists.get(n)!);
  const posted: { n: number; body: string }[] = [];
  let reads = 0;
  return {
    posted,
    get reads() {
      return reads;
    },
    io: {
      async listComments(n: number): Promise<IssueComment[]> {
        reads++;
        return [...listOf(n)];
      },
      async comment(n: number, body: string): Promise<unknown> {
        if (posted.length === 0) hooks.beforePost?.(n, listOf(n));
        posted.push({ n, body });
        listOf(n).push(comment(body));
        return {};
      },
    },
  };
}

const opts = { session: SESSION, now: NOW, humanClaimStaleHours: 6, render, wait: async () => {} };

test('node：宣言を投稿し、結果は node のまま（Issue に stage implement、このセッションの手動の宣言）', async () => {
  const f = fakeIo();
  const decision = decideStep(stepInput(fleetIssue(planOkFacts())));
  const r = await applyStepClaims(f.io, decision, opts);
  assert.deepEqual(r, decision.result);
  assert.equal(r.kind, 'node');
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0]!.n, N);
  const v = claimValue(f.posted[0]!.body);
  assert.equal(v.by, 'manual');
  assert.equal(v.session, SESSION);
  assert.equal(v.stage, 'implement');
  assert.notEqual(v.released, true);
  assert.ok(f.reads >= 2, '投稿の前と後に読む');
});

test('node（PR）：PR の番号に stage judge で宣言する', async () => {
  const f = fakeIo();
  const decision = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr()] })));
  const r = await applyStepClaims(f.io, decision, opts);
  assert.equal(r.kind, 'node');
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0]!.n, PR);
  assert.equal(claimValue(f.posted[0]!.body).stage, 'judge');
});

test('node：読み直しで先に宣言したほかのセッションがいれば stop claimed（released false）に変わる', async () => {
  const f = fakeIo({ beforePost: (_n, list) => void list.push(comment(render(manual(OTHER, 'implement')))) });
  const decision = decideStep(stepInput(fleetIssue(planOkFacts())));
  const r = await applyStepClaims(f.io, decision, opts);
  assert.equal(r.kind, 'stop');
  assert.equal(r.kind === 'stop' && r.reason, 'claimed');
  assert.equal(r.kind === 'stop' && r.released, false);
  assert.equal(r.issue, N);
  assert.equal(r.node, decision.result.node);
  assert.equal(r.version, 1);
  // 取り下げ（postClaim）は書くが、step の解除はしない
  assert.equal(f.posted.length, 2, '宣言と取り下げ');
  assert.equal(claimValue(f.posted[1]!.body).released, true);
});

test('decision.claim が null（同じ段階の自分の宣言がある）なら投稿しない', async () => {
  const f = fakeIo();
  const decision = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(SESSION, 'implement') }))));
  assert.equal(decision.claim, null);
  const r = await applyStepClaims(f.io, decision, opts);
  assert.deepEqual(r, decision.result);
  assert.equal(f.posted.length, 0);
});

test('wait：投稿も解除もしない', async () => {
  const f = fakeIo();
  const decision = decideStep(stepInput(fleetIssue(planOkFacts()), { areaFull: '上限' }));
  const r = await applyStepClaims(f.io, decision, opts);
  assert.equal(r.kind, 'wait');
  assert.equal(f.posted.length, 0);
});

test('stop：release の番号ごとに解除のコメント（このセッションの手動の宣言に released: true）を書く', async () => {
  const f = fakeIo();
  const issue = fleetIssue(planOkFacts({ labels: ['agent:hold'], claim: manual(SESSION, 'implement') }), { prs: [openPr({ claim: manual(SESSION, 'fix') })] });
  const decision = decideStep(stepInput(issue));
  assert.deepEqual(decision.release, [N, PR]);
  const r = await applyStepClaims(f.io, decision, opts);
  assert.equal(r.kind, 'stop');
  assert.equal(r.kind === 'stop' && r.released, true);
  assert.deepEqual(f.posted.map((p) => p.n), [N, PR]);
  for (const p of f.posted) {
    const v = claimValue(p.body);
    assert.equal(v.by, 'manual');
    assert.equal(v.session, SESSION);
    assert.equal(v.released, true);
  }
});

test('stop：release が空なら何も書かない', async () => {
  const f = fakeIo();
  const decision = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(OTHER, 'implement') }))));
  assert.equal(decision.result.kind, 'stop');
  await applyStepClaims(f.io, decision, opts);
  assert.equal(f.posted.length, 0);
});
