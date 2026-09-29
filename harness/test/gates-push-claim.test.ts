import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, claudeMark, extractBlock, renderBlock, shortSession } from '../lib/blocks.ts';
import type { Claim } from '../lib/queue.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, DIFF, HEAD, acceptanceFake, claimComment, ctxFor, hoursAgo, planGateComment, pr, type FakeGitHub } from './support/gate-fixtures.ts';

const BEFORE = 'c'.repeat(40);
const S1 = 'https://claude.ai/code/session_01AAAAAAAAAAAAAAAAAAAAAAAA';
const S2 = 'https://claude.ai/code/session_01BBBBBBBBBBBBBBBBBBBBBBBB';
const CO = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

/** 記録の session は全体の URL でも短い形でもよい（比べるのは短い形） */
const short = (xs: string[]) => xs.map(shortSession);

type Commit = { sha: string; commit: { message: string } };
const commit = (sha: string, message: string): Commit => ({ sha, commit: { message } });
const claudeCommit = (sha: string, session: string | null = S1) => commit(sha, `feat: x\n\n本文\n\n${session ? `Claude-Session: ${session}\n` : ''}${CO}`);
const humanCommit = (sha: string) => commit(sha, 'fix: 人の修正\n\n本文');
/** main にあった Claude の commit（別のセッションの trailer と Claude の Co-authored-by） */
const mainCommit = (sha: string) => commit(sha, `feat: main の変更\n\nClaude-Session: ${S2}\nCo-authored-by: Claude <noreply@anthropic.com>`);

/** session 付きの着手宣言（claimComment は session を持たないので本文を組み立て直す） */
function sessionClaim(session: string, at = hoursAgo(1)) {
  const base = claimComment({ at });
  const value: Claim = { by: 'manual', session, at, stage: 'implement' };
  return { ...base, body: [claudeMark(session), '着手しました（手動、段階 implement）。', '', renderBlock('agent-claim', value)].join('\n') };
}

interface World {
  prPatch?: Record<string, unknown>;
  prComments?: unknown[];
  /** Issue #3（closingIssuesReferences の相手）のコメント。既定は planGateComment だけ */
  issueComments?: unknown[];
  /** compare（before...after）の commits。undefined なら commits を返さない */
  compare?: Commit[] | 'error';
  compareStatus?: string;
  /** /pulls/5/commits */
  prCommits?: Commit[] | 'error';
  /** /commits/{after} */
  headCommit?: Commit | 'error';
}

function world(w: World): FakeGitHub {
  const fake = acceptanceFake({ pr: pr(w.prPatch ?? {}), dashboardLabels: [], prComments: w.prComments ?? [] });
  fake
    .on('GET', /\/issues\/3\/comments/, () => [planGateComment, ...(w.issueComments ?? [])])
    .on('GET', /\/compare\/c{40}\.\.\.a{40}/, (_m, _b, o) => {
      if (o.raw) return DIFF;
      if (w.compare === 'error') throw new Error('500 compare');
      return { behind_by: 0, ...(w.compareStatus ? { status: w.compareStatus } : {}), ...(w.compare ? { commits: w.compare } : {}) };
    })
    .on('GET', /\/pulls\/5\/commits/, () => {
      if (w.prCommits === 'error') throw new Error('500 pulls/commits');
      return w.prCommits ?? [];
    })
    .on('GET', /\/commits\/a{40}$/, () => {
      if (w.headCommit === 'error' || w.headCommit === undefined) throw new Error('500 commits');
      return w.headCommit;
    });
  return fake;
}

function event(patch: Record<string, unknown> = {}) {
  return { action: 'synchronize', before: BEFORE, after: HEAD, sender: { login: 'someone' }, pull_request: { number: 5, updated_at: new Date().toISOString() }, ...patch };
}

async function run(fake: FakeGitHub, ev: Record<string, unknown> = event()) {
  await onPullRequest(ctxFor(fake, 'pull_request_target', ev));
  return fake.writes();
}

/** POST された unclaimed-push のコメントの記録 */
function records(fake: FakeGitHub): any[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && /\/issues\/5\/comments$/.test(c.path) && String(c.body?.body).includes(appMark('unclaimed-push')))
    .map((c) => {
      const b = extractBlock(c.body.body, 'agent-app');
      assert.ok(b.found && b.ok, '記録（agent-app）がある');
      return b.value;
    });
}

test('宣言の無い Agent PR に Claude のセッションの commit が push されたら、App が知らせる（no-claim）', async () => {
  const c = claudeCommit(HEAD, S1);
  const fake = world({ compare: [c], prCommits: [c] });
  const w = await run(fake);
  assert.ok(w.includes('comment:unclaimed-push'), w.join('\n'));
  const [r] = records(fake);
  assert.equal(r.version, 1);
  assert.equal(r.headSha, HEAD);
  assert.equal(r.reason, 'no-claim');
  assert.deepEqual(short(r.commitSessions), [shortSession(S1)]);
  assert.deepEqual(r.claimSessions, []);
});

test('Claude の Co-Authored-By だけの commit でも、宣言が無ければ知らせる', async () => {
  const c = claudeCommit(HEAD, null);
  const fake = world({ compare: [c], prCommits: [c] });
  assert.ok((await run(fake)).includes('comment:unclaimed-push'));
  assert.equal(records(fake)[0].reason, 'no-claim');
});

test('PR の宣言の session と commit の trailer が同じなら知らせない', async () => {
  const c = claudeCommit(HEAD, S1);
  const fake = world({ compare: [c], prCommits: [c], prComments: [sessionClaim(S1)] });
  assert.ok(!(await run(fake)).includes('comment:unclaimed-push'));
});

test('Issue（#3）の宣言の session と commit の trailer が同じなら知らせない', async () => {
  const c = claudeCommit(HEAD, S1);
  const fake = world({ compare: [c], prCommits: [c], issueComments: [sessionClaim(S1)] });
  assert.ok(!(await run(fake)).includes('comment:unclaimed-push'));
  assert.ok(fake.calls.some((x) => x.method === 'GET' && /\/issues\/3\/comments/.test(x.path)), 'Issue の宣言を読む');
});

test('宣言の session と cse_ の URL の trailer は同じセッションとみなす', async () => {
  const c = claudeCommit(HEAD, 'https://claude.ai/code/cse_01AAAAAAAAAAAAAAAAAAAAAAAA');
  const fake = world({ compare: [c], prCommits: [c], prComments: [sessionClaim(S1)] });
  assert.ok(!(await run(fake)).includes('comment:unclaimed-push'));
});

test('宣言の session と commit の trailer が食い違えば知らせる（session-mismatch）', async () => {
  const c = claudeCommit(HEAD, S1);
  const fake = world({ compare: [c], prCommits: [c], prComments: [sessionClaim(S2)] });
  assert.ok((await run(fake)).includes('comment:unclaimed-push'));
  const [r] = records(fake);
  assert.equal(r.reason, 'session-mismatch');
  assert.equal(r.headSha, HEAD);
  assert.deepEqual(short(r.commitSessions), [shortSession(S1)]);
  assert.deepEqual(short(r.claimSessions), [shortSession(S2)]);
});

test('push の後に出た宣言は数えない（push の時点で宣言が無ければ知らせる）', async () => {
  const c = claudeCommit(HEAD, S1);
  const pushedAt = hoursAgo(2);
  const fake = world({ compare: [c], prCommits: [c], prComments: [sessionClaim(S1, hoursAgo(1))] });
  await run(fake, event({ pull_request: { number: 5, updated_at: pushedAt } }));
  assert.equal(records(fake)[0]?.reason, 'no-claim');
});

test('人の push（Claude の trailer が無い commit）は知らせない', async () => {
  const c = humanCommit(HEAD);
  const fake = world({ compare: [c], prCommits: [c] });
  assert.ok(!(await run(fake)).includes('comment:unclaimed-push'));
});

test('同じ head への二度目は知らせない', async () => {
  const c = claudeCommit(HEAD, S1);
  const already = {
    id: 400, created_at: hoursAgo(0.5), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark('unclaimed-push')}\n知らせ\n${renderBlock('agent-app', { version: 1, headSha: HEAD, reason: 'no-claim', commitSessions: [S1], claimSessions: [] })}`,
  };
  const fake = world({ compare: [c], prCommits: [c], prComments: [already] });
  assert.ok(!(await run(fake)).includes('comment:unclaimed-push'));
});

test('別の head の記録があっても、新しい head には知らせる', async () => {
  const c = claudeCommit(HEAD, S1);
  const old = {
    id: 401, created_at: hoursAgo(0.5), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark('unclaimed-push')}\n知らせ\n${renderBlock('agent-app', { version: 1, headSha: 'd'.repeat(40), reason: 'no-claim', commitSessions: [S1], claimSessions: [] })}`,
  };
  const fake = world({ compare: [c], prCommits: [c], prComments: [old] });
  assert.ok((await run(fake)).includes('comment:unclaimed-push'));
});

test('人の Update branch（main の Claude の commit は PR の commit に無い）は知らせない', async () => {
  const main = mainCommit('e'.repeat(40));
  const merge = commit(HEAD, "Merge branch 'main' into claude/issue-3");
  const fake = world({ compare: [main, merge], prCommits: [claudeCommit('f'.repeat(40), S1), merge] });
  assert.ok(!(await run(fake)).includes('comment:unclaimed-push'));
});

test('宣言のある sync（main の別セッションの commit は PR の commit に無い）は知らせない', async () => {
  const main = mainCommit('e'.repeat(40));
  const merge = commit(HEAD, "Merge branch 'main' into claude/issue-3");
  const fake = world({ compare: [main, merge], prCommits: [claudeCommit('f'.repeat(40), S1), merge], prComments: [sessionClaim(S1)] });
  assert.ok(!(await run(fake)).includes('comment:unclaimed-push'));
});

test('force push（compare が diverged）でも、PR 自身の Claude の commit なら知らせる', async () => {
  const gone = claudeCommit('9'.repeat(40), S2);
  const c = claudeCommit(HEAD, S1);
  const fake = world({ compare: [gone, c], compareStatus: 'diverged', prCommits: [c] });
  assert.ok((await run(fake)).includes('comment:unclaimed-push'));
  const [r] = records(fake);
  assert.equal(r.reason, 'no-claim');
  assert.deepEqual(short(r.commitSessions), [shortSession(S1)], 'PR に無い commit の session は入れない');
});

test('sender が App の push は知らせない', async () => {
  const c = claudeCommit(HEAD, S1);
  const fake = world({ compare: [c], prCommits: [c] });
  assert.ok(!(await run(fake, event({ sender: { login: APP } }))).includes('comment:unclaimed-push'));
});

test('claude/ でないブランチの PR は知らせない', async () => {
  const c = claudeCommit(HEAD, S1);
  const fake = world({ prPatch: { head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }, compare: [c], prCommits: [c] });
  assert.ok(!(await run(fake)).includes('comment:unclaimed-push'));
});

test('before が無いときは /commits/{after} の1件を読む', async () => {
  const c = claudeCommit(HEAD, S1);
  const fake = world({ headCommit: c, prCommits: [c] });
  const ev = event();
  delete (ev as Record<string, unknown>).before;
  assert.ok((await run(fake, ev)).includes('comment:unclaimed-push'));
  assert.ok(fake.calls.some((x) => x.method === 'GET' && /\/commits\/a{40}$/.test(x.path)));
  assert.equal(records(fake)[0].headSha, HEAD);
});

test('compare が commits を返さないときは /commits/{after} の1件を読む', async () => {
  const c = claudeCommit(HEAD, S1);
  const fake = world({ headCommit: c, prCommits: [c] });
  assert.ok((await run(fake)).includes('comment:unclaimed-push'));
  assert.ok(fake.calls.some((x) => x.method === 'GET' && /\/commits\/a{40}$/.test(x.path)));
});

test('Claude の印が無ければ宣言（Issue のコメント）を読まない', async () => {
  const c = humanCommit(HEAD);
  const fake = world({ compare: [c], prCommits: [c] });
  const before = () => fake.calls.filter((x) => x.method === 'GET' && /\/issues\/3\/comments/.test(x.path)).length;
  // on-pr の他の処理（plan-link など）も Issue #3 を読むので、印のある場合との差で確かめる
  await run(fake);
  const human = before();
  const c2 = claudeCommit(HEAD, S1);
  const fake2 = world({ compare: [c2], prCommits: [c2] });
  await run(fake2);
  const claude = fake2.calls.filter((x) => x.method === 'GET' && /\/issues\/3\/comments/.test(x.path)).length;
  assert.ok(claude > human, `Claude の印があるときだけ宣言を読む（human=${human} claude=${claude}）`);
});

test('commit が読めなくても、ほかのチェックは書かれ、知らせない', async () => {
  const fake = world({ compare: 'error', prCommits: 'error', headCommit: 'error' });
  const w = await run(fake);
  assert.ok(!w.includes('comment:unclaimed-push'));
  assert.ok(w.some((x) => x.startsWith('check:agent/title=')), w.join('\n'));
  assert.ok(w.some((x) => x.startsWith('check:agent/tests=')), w.join('\n'));
  assert.ok(w.some((x) => x.startsWith('check:merge-route=')), w.join('\n'));
});
