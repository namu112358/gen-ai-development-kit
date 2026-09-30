// Issue #171：claim は「投稿 → 少し待つ → 読み直す」で、同時に宣言した後の側が取り下げて止まる。読み直しで気づかなくても ensureOwnClaim が止める
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { ensureOwnClaim, postClaim } from '../lib/claim.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Claim } from '../lib/queue.ts';
import { agentSource } from './support/agent-source.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';
/** CLAUDE_CODE_REMOTE_SESSION_ID から作る形（agent.ts の sessionUrl） */
const CLOUD = 'https://claude.ai/code/session_01CLOUDxyzABC';
const N = 171;
const now = new Date('2026-09-26T12:00:00Z');

let nextId = 1;
function comment(body: string): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `u${id}`, created_at: `2026-09-26T00:${String(Math.floor(id / 60) % 60).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}Z`, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } };
}
const render = (value: Claim): string => `${claudeMark(value.session ?? null)}\n着手宣言です。\n\n${renderBlock('agent-claim', value)}`;
const claimComment = (value: Claim) => comment(render(value));
const manual = (session: string, patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', session, ...patch });

/**
 * コメント一覧を差し替えた偽の io。comment() は一覧の末尾に足す。
 * beforePost は投稿が一覧に入る直前に呼ばれる（同時に宣言したほかのセッションのコメントが先に入る並びを作る）
 */
function fakeIo(initial: IssueComment[] = [], hooks: { beforePost?: (list: IssueComment[]) => void } = {}) {
  const list = [...initial];
  const posted: string[] = [];
  let reads = 0;
  return {
    list,
    posted,
    get reads() {
      return reads;
    },
    io: {
      async listComments(n: number): Promise<IssueComment[]> {
        assert.equal(n, N);
        reads++;
        return [...list];
      },
      async comment(n: number, body: string): Promise<unknown> {
        assert.equal(n, N);
        if (posted.length === 0) hooks.beforePost?.(list);
        posted.push(body);
        list.push(comment(body));
        return {};
      },
    },
  };
}

const claimValue = (body: string): Claim => {
  const b = extractBlock(body, 'agent-claim');
  assert.ok(b.found && b.ok, `agent-claim のブロックがありません: ${body}`);
  return b.value as Claim;
};

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

/** postClaim / ensureOwnClaim の戻り値から error を取り出す（{ error } でも string | null でも読む） */
const errorOf = (r: unknown): string | null => (r === null || typeof r === 'string' ? r : ((r as { error: string | null }).error ?? null));

// ---- AC4：同時の宣言で、先の側は成功し、後の側は取り下げて止まる ----

test('postClaim（勝つ）：宣言が無い Issue に宣言し、待つ間にほかのセッションが後から宣言しても成功し、取り下げを書かない', async () => {
  const f = fakeIo();
  const r = await postClaim(f.io, N, baseOpts({ wait: async () => void f.list.push(claimComment(manual(OTHER, { stage: 'plan' }))) }));
  assert.equal(errorOf(r), null);
  assert.equal(f.posted.length, 1, '宣言の1件だけを書く');
  const v = claimValue(f.posted[0]!);
  assert.equal(v.by, 'manual');
  assert.equal(v.session, SESSION);
  assert.equal(v.stage, 'plan');
  assert.notEqual(v.released, true);
  assert.equal('takeover' in v, false, '--takeover でない宣言に takeover を書かない');
  assert.ok(f.reads >= 2, '投稿の前と、待った後に読み直す');
});

test('postClaim（勝つ）：待つ関数を投稿の後・読み直しの前に呼ぶ', async () => {
  const order: string[] = [];
  const f = fakeIo();
  const io = {
    listComments: async (n: number) => (order.push('read'), f.io.listComments(n)),
    comment: async (n: number, body: string) => (order.push('post'), f.io.comment(n, body)),
  };
  const r = await postClaim(io, N, baseOpts({ wait: async () => void order.push('wait') }));
  assert.equal(errorOf(r), null);
  const post = order.indexOf('post');
  const wait = order.indexOf('wait');
  assert.ok(post >= 0 && wait > post, `投稿の後に待つ: ${order.join(',')}`);
  assert.ok(order.slice(wait + 1).includes('read'), `待った後に読み直す: ${order.join(',')}`);
});

test('postClaim（負ける）：投稿の直前にほかのセッションの宣言が入れば、取り下げを書き、先のセッションを示した error を返す', async () => {
  const f = fakeIo([], { beforePost: (list) => void list.push(claimComment(manual(OTHER, { stage: 'plan' }))) });
  const r = await postClaim(f.io, N, baseOpts());
  const error = errorOf(r);
  assert.ok(error, '後に書いた側は止まる');
  assert.match(error, /9b8c7d6e/, '先に宣言したセッション（短い形）を示す');
  assert.equal(f.posted.length, 2, '宣言と取り下げの2件');
  assert.notEqual(claimValue(f.posted[0]!).released, true);
  const withdrawn = claimValue(f.posted[1]!);
  assert.equal(withdrawn.released, true, '取り下げは released: true');
  assert.equal(withdrawn.session, SESSION, '取り下げるのは自分の宣言');
});

test('postClaim（負ける）：待つ間に、自分より先の宣言が一覧に現れても（遅れて見えた）取り下げて止まる', async () => {
  const f = fakeIo();
  const r = await postClaim(
    f.io,
    N,
    baseOpts({
      wait: async () => {
        // 自分の投稿より前に書かれていたほかのセッションの宣言が、遅れて一覧に見えた
        const mine = f.list.pop()!;
        f.list.push(claimComment(manual(OTHER, { stage: 'plan-critique' })), mine);
      },
    }),
  );
  const error = errorOf(r);
  assert.ok(error);
  assert.match(error, /9b8c7d6e/);
  assert.equal(claimValue(f.posted.at(-1)!).released, true);
});

test('postClaim（負けた後）：取り下げの後の並びで、先の側の宣言が持ち主のまま残る', async () => {
  const f = fakeIo([], { beforePost: (list) => void list.push(claimComment(manual(OTHER, { stage: 'plan' }))) });
  await postClaim(f.io, N, baseOpts());
  // 先の側は自分の宣言として確かめられる
  assert.equal(errorOf(await ensureOwnClaim(f.io, N, OTHER)), null);
  assert.ok(errorOf(await ensureOwnClaim(f.io, N, SESSION)), '後の側は ensureOwnClaim でも止まる');
});

test('postClaim：投稿の前にほかのセッションの有効な宣言があれば、投稿せずに error（今と同じ）', async () => {
  const f = fakeIo([claimComment(manual(OTHER, { stage: 'implement' }))]);
  const r = await postClaim(f.io, N, baseOpts());
  assert.ok(errorOf(r));
  assert.equal(f.posted.length, 0);
});

test('postClaim：--takeover なら、ほかのセッションの宣言の上に takeover: true の宣言を書いて成功する', async () => {
  const f = fakeIo([claimComment(manual(OTHER, { stage: 'implement' }))]);
  const r = await postClaim(f.io, N, baseOpts({ takeover: true, stage: 'implement' }));
  assert.equal(errorOf(r), null);
  assert.equal(f.posted.length, 1);
  const v = claimValue(f.posted[0]!);
  assert.equal(v.takeover, true);
  assert.equal(v.session, SESSION);
  assert.equal(errorOf(await ensureOwnClaim(f.io, N, SESSION)), null, '引き継いだ側が持ち主');
});

test('postClaim：自分の宣言がある Issue に段階を変えて宣言し直すと成功する', async () => {
  const f = fakeIo([claimComment(manual(SESSION, { stage: 'plan' }))]);
  const r = await postClaim(f.io, N, baseOpts({ stage: 'plan-critique' }));
  assert.equal(errorOf(r), null);
  assert.equal(f.posted.length, 1);
  assert.equal(claimValue(f.posted[0]!).stage, 'plan-critique');
});

// ---- AC6：ID が得られないとき、手動の宣言は投稿しない ----

test('postClaim：今のセッションの ID が null なら、手動の宣言は投稿せずに error', async () => {
  for (const current of [null, '']) {
    const f = fakeIo();
    const r = await postClaim(f.io, N, baseOpts({ current }));
    const error = errorOf(r);
    assert.ok(error, `止まる: ${JSON.stringify(current)}`);
    assert.match(error, /セッションの ID/);
    assert.equal(f.posted.length, 0, 'io.comment を呼ばない');
  }
});

// ---- AC5：読み直しで気づかなくても ensureOwnClaim が止める ----

test('ensureOwnClaim：ほかのセッションの宣言より後の自分の宣言だけがある並びでは error（読み直しで気づかなかった場合）', async () => {
  const f = fakeIo([claimComment(manual(OTHER, { stage: 'plan' })), claimComment(manual(SESSION, { stage: 'plan' })), claimComment(manual(SESSION, { stage: 'plan-critique' }))]);
  const error = errorOf(await ensureOwnClaim(f.io, N, SESSION));
  assert.ok(error, '後の側は止まる');
  assert.match(error, /9b8c7d6e/, '持ち主のセッションを示す');
  assert.equal(errorOf(await ensureOwnClaim(f.io, N, OTHER)), null, '先の側は通る');
  assert.equal(f.posted.length, 0, 'ensureOwnClaim は書かない');
});

test('ensureOwnClaim：宣言が無い・今のセッションの ID が無いと error', async () => {
  assert.ok(errorOf(await ensureOwnClaim(fakeIo().io, N, SESSION)), '宣言が無い');
  assert.ok(errorOf(await ensureOwnClaim(fakeIo([claimComment(manual(SESSION))]).io, N, null)), 'ID が無い');
});

// ---- AC7：クラウドの付き添いのセッションでも確かめる ----

test('ensureOwnClaim：今のセッションがクラウドの URL でも、ほかのセッションの宣言で error を返す', async () => {
  const f = fakeIo([claimComment(manual(OTHER, { stage: 'plan' })), claimComment(manual(CLOUD, { stage: 'plan' }))]);
  assert.ok(errorOf(await ensureOwnClaim(f.io, N, CLOUD)));
  assert.ok(errorOf(await ensureOwnClaim(fakeIo([claimComment(manual(OTHER))]).io, N, CLOUD)));
});

test('ensureOwnClaim：今のセッションがクラウドの URL で、自分の手動の宣言が持ち主なら通る', async () => {
  const f = fakeIo([claimComment(manual(CLOUD, { stage: 'plan-critique' }))]);
  assert.equal(errorOf(await ensureOwnClaim(f.io, N, CLOUD)), null);
});

test('postClaim：クラウドの付き添いのセッションの手動の宣言も、読み直して負けたら取り下げる', async () => {
  const f = fakeIo([], { beforePost: (list) => void list.push(claimComment(manual(OTHER, { stage: 'plan' }))) });
  const r = await postClaim(f.io, N, baseOpts({ current: CLOUD }));
  assert.ok(errorOf(r));
  const withdrawn = claimValue(f.posted.at(-1)!);
  assert.equal(withdrawn.released, true);
  assert.equal(withdrawn.session, CLOUD);
});

// ---- agent.ts：環境変数で Routine を見分けて確かめを飛ばさない ----

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

test('agent.ts：isRoutine() が無く、ensureOwnClaim が CLAUDE_CODE_REMOTE_SESSION_ID で早抜けしない', () => {
  const src = agentSource();
  assert.doesNotMatch(src, /\bisRoutine\b/, 'isRoutine が残っている');
  const i = src.indexOf('function ensureOwnClaim');
  if (i >= 0) {
    const body = src.slice(i, src.indexOf('\n}\n', i));
    assert.doesNotMatch(body, /CLAUDE_CODE_REMOTE_SESSION_ID|sessionUrl\(\)/, 'ensureOwnClaim が Routine の環境変数を見ている');
  }
});

test('agent.ts：claim は lib/claim.ts の postClaim を使い、worktree は --routine のときだけ宣言を確かめない', () => {
  const src = agentSource();
  assert.match(src, /from '(?:\.\.\/)+lib\/claim\.ts'/);
  assert.match(src, /\bpostClaim\(/);
  assert.match(src, /worktreeClaimIssue\([^)]*args\.includes\('--routine'\)\)/);
});

test('agent.ts：ensure-claim <番号> のコマンドがあり、使い方に書かれている', () => {
  const src = agentSource();
  assert.match(src, /'ensure-claim'/, 'コマンドの分岐');
  const usage = (src.match(/\/\*\*[\s\S]*?\*\//g) ?? []).filter((c) => c.includes('node harness/scripts/agent.ts')).join('\n');
  assert.match(usage, /^\s*\*\s+node harness\/scripts\/agent\.ts ensure-claim <番号>/m, '使い方のコメント');
});

test('implement の skill：gh pr create の前に ensure-claim <番号> で宣言を確かめる', () => {
  const skill = read('.claude/skills/implement/SKILL.md');
  const ensure = skill.indexOf('ensure-claim <番号>');
  const create = skill.indexOf('gh pr create');
  assert.ok(ensure >= 0, 'ensure-claim の手順がありません');
  assert.ok(create >= 0 && ensure < create, 'ensure-claim は gh pr create より前');
});

test('routine.md：実装・修正・衝突の解消の worktree の呼び出しに --routine を付ける（--detach は除く）', () => {
  const lines = read('.claude/routine.md').split('\n').filter((l) => /agent\.ts worktree /.test(l) && !l.includes('--detach'));
  assert.ok(lines.length > 0, 'worktree の呼び出しがありません');
  for (const l of lines) assert.match(l, /--routine/, l);
});
