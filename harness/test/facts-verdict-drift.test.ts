import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import { prFacts } from '../lib/facts.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import { APP, DIFF, FakeGitHub, HEAD, config, pr, verdict } from './support/gate-fixtures.ts';

/**
 * prFacts の verdictAwaitingGate：最新の判定コメントの headSha が今の head と違っても、
 * 判定した head での PR の差分の patch-id が今の差分と同じ（App が受け付ける条件）で、App の返事がまだ無ければ受け付け待ちと数える。
 */

const CURRENT = 'c'.repeat(40);
const current = () => pr({ head: { ref: 'claude/issue-3-x', sha: CURRENT, repo: { full_name: 'o/r' } } });

let nextId = 1;
function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}
function verdictComment(headSha: string, createdAt = at(-60_000)): IssueComment {
  const id = nextId++;
  return {
    id, html_url: `u${id}`, created_at: createdAt, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' },
    body: `${CLAUDE_MARK}\n## 判定\n\n${renderBlock('agent-verdict', verdict({ headSha }))}`,
  };
}
function appReply(kind: 'acceptance' | 'verdict-rejected', createdAt: string): IssueComment {
  const id = nextId++;
  return {
    id, html_url: `u${id}`, created_at: createdAt, updated_at: '', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark(kind)}\n記録\n${renderBlock('agent-app', { version: 1, patchId: 'x' })}`,
  };
}

/** prFacts に必要な応答を揃えた偽の GitHub。diffs は head ごとの compare の diff（Error なら失敗させる） */
function factsFake(comments: IssueComment[], diffs: Record<string, string | Error>): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/pulls\/5$/, () => current())
    .on('GET', /\/issues\/5\/comments/, () => comments)
    .on('GET', /\/pulls\/5\/reviews/, () => [])
    .on('GET', /\/commits\/\w+$/, () => ({ commit: { committer: { date: '2026-09-27T00:00:00Z' } } }))
    .on('GET', /\/commits\/\w+\/check-runs/, () => ({ check_runs: [] }))
    .on('GET', /\/compare\/main\.\.\.(\w+)$/, (m) => {
      const d = diffs[m[1]!];
      if (d === undefined || d instanceof Error) throw d ?? new Error(`no diff for ${m[1]}`);
      return d;
    })
    .on('POST', /\/graphql/, (_m, body) => {
      if (String(body.query).includes('closingIssuesReferences')) {
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: 'o/r' } }] } } } } };
      }
      return { data: {} };
    });
}

const run = (fake: FakeGitHub) => prFacts(new GitHub(fake, 'o/r'), config, current() as never, new Map(), new Map());
const comparedHeads = (fake: FakeGitHub) => fake.calls.filter((c) => c.path.includes('/compare/')).map((c) => c.path.split('...').at(-1));

test('prFacts：判定の headSha が今の head と違っても、差分の patch-id が同じで App の返事がまだ無ければ受け付け待ち', async () => {
  const fake = factsFake([verdictComment(HEAD)], { [HEAD]: DIFF, [CURRENT]: DIFF });
  const f = await run(fake);
  assert.equal(f.verdictAwaitingGate, true);
  assert.equal(f.headSha, CURRENT);
});

test('prFacts：判定の headSha が今の head と違い、差分の patch-id が違えば受け付け待ちにしない', async () => {
  const fake = factsFake([verdictComment(HEAD)], { [HEAD]: DIFF, [CURRENT]: DIFF.replace('+b', '+changed') });
  assert.equal((await run(fake)).verdictAwaitingGate, false);
});

test('prFacts：判定した head の差分が取れなければ受け付け待ちにしない（judge を選び直す側）', async () => {
  const fake = factsFake([verdictComment(HEAD)], { [HEAD]: new Error('404'), [CURRENT]: DIFF });
  assert.equal((await run(fake)).verdictAwaitingGate, false);
});

test('prFacts：判定の後に App の返事（acceptance・verdict-rejected）があれば受け付け待ちにしない', async () => {
  for (const kind of ['acceptance', 'verdict-rejected'] as const) {
    const fake = factsFake([verdictComment(HEAD, at(-120_000)), appReply(kind, at(-60_000))], { [HEAD]: DIFF, [CURRENT]: DIFF });
    assert.equal((await run(fake)).verdictAwaitingGate, false, kind);
    assert.ok(!comparedHeads(fake).includes(HEAD), `${kind}：返事があれば判定した head の差分を取らない`);
  }
});

test('prFacts：古い判定（返事を待つ時間を過ぎた）は、差分が同じでも受け付け待ちにせず、判定した head の差分も取らない', async () => {
  const fake = factsFake([verdictComment(HEAD, at(-2 * 60 * 60_000))], { [HEAD]: DIFF, [CURRENT]: DIFF });
  assert.equal((await run(fake)).verdictAwaitingGate, false);
  assert.ok(!comparedHeads(fake).includes(HEAD));
});

test('prFacts：判定の headSha が今の head と同じなら、判定した head の差分を別に取らない（今までどおり受け付け待ち）', async () => {
  const fake = factsFake([verdictComment(CURRENT)], { [CURRENT]: DIFF });
  assert.equal((await run(fake)).verdictAwaitingGate, true);
  assert.deepEqual(comparedHeads(fake), [CURRENT]);
});
