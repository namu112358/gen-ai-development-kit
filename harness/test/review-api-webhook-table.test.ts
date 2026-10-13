// review-api の Webhook の受け付けを、リポジトリの表（REVIEW_REPOS）で決めることを確かめる（Issue #1049）：
// decideReview が行ごとの installation・Webhook の秘密の名前・trigger の上書き（branchPrefix・requireClosesIssue・issueLink）で決めること、
// linkedIssueNumbers の closes-or-refs、verifyWithSecrets が通った秘密の名前をすべて返すこと、collectMaterial が issueLink で Refs #N の Issue を材料にすること。
// 外部 API は呼ばない。識別子はすべて架空の値
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectMaterial } from '../../review-api/src/collect.ts';
import type { IssueLink, ReviewConfig } from '../../review-api/src/config.ts';
import { createGitHubClient } from '../../review-api/src/github.ts';
import { parseRepoTable } from '../../review-api/src/repos.ts';
import { decideReview, linkedIssueNumbers, verifyWithSecrets, type PullRequestEvent } from '../../review-api/src/webhook.ts';

const row = (installationId: string, webhookSecret: string, trigger?: object) => ({
  installationId,
  app: { clientId: `cid-${installationId}`, privateKeySecret: `KEY_${webhookSecret}`, webhookSecret, login: `review-${installationId}[bot]` },
  gateAppLogin: `gate-${installationId}[bot]`,
  anthropicKeySecret: `CLAUDE_${webhookSecret}`,
  ...(trigger ? { trigger } : {}),
});
// o1/r1 は branchPrefix と issueLink を、o2/r2 は requireClosesIssue だけを上書きする
const { table } = parseRepoTable({
  REVIEW_REPOS: JSON.stringify({
    'o1/r1': row('111', 'HOOK_ONE', { branchPrefix: 'one/', issueLink: 'closes-or-refs' }),
    'o2/r2': row('222', 'HOOK_TWO', { requireClosesIssue: false }),
  }),
});
const config: Pick<ReviewConfig, 'trigger'> = {
  trigger: { actions: ['opened'], skipBotSenders: true, branchPrefix: 'claude/', requireClosesIssue: true, settleSeconds: 0 },
};
const event = (repo: string, installation: number, ref: string, body: string | null): PullRequestEvent => ({
  action: 'opened',
  sender: { type: 'User', login: 'someone' },
  repository: { full_name: repo },
  installation: { id: installation },
  pull_request: { head: { ref }, body },
});

// [名前, リポジトリ, installation, ブランチ, 本文, 通った秘密の名前, 期待する reason]
const cases: [string, string, number, string, string | null, string[], string][] = [
  ['o1/r1 を o1/r1 の installation と秘密で', 'o1/r1', 111, 'one/x', 'Closes #1', ['HOOK_ONE'], 'ok'],
  ['o2/r2 を o2/r2 の installation と秘密で', 'o2/r2', 222, 'claude/x', 'Closes #1', ['HOOK_TWO'], 'ok'],
  ['表に無いリポジトリ', 'o3/r3', 111, 'one/x', 'Closes #1', ['HOOK_ONE'], 'repo-not-allowed'],
  ['o2/r2 にほかの行の installation', 'o2/r2', 111, 'claude/x', 'Closes #1', ['HOOK_TWO'], 'installation-mismatch'],
  ['o1/r1 にほかの行の秘密だけ', 'o1/r1', 111, 'one/x', 'Closes #1', ['HOOK_TWO'], 'webhook-secret-mismatch'],
  ['通った秘密が無い', 'o1/r1', 111, 'one/x', 'Closes #1', [], 'webhook-secret-mismatch'],
  ['o1/r1 は行の branchPrefix で設定の接頭辞を通さない', 'o1/r1', 111, 'claude/x', 'Closes #1', ['HOOK_ONE'], 'branch-prefix'],
  ['o2/r2 は設定の branchPrefix のまま', 'o2/r2', 222, 'one/x', 'Closes #1', ['HOOK_TWO'], 'branch-prefix'],
  ['o1/r1 は closes-or-refs で Refs #N だけでも通す', 'o1/r1', 111, 'one/x', 'Refs #1', ['HOOK_ONE'], 'ok'],
  ['o1/r1 も結び付けが無ければ止める', 'o1/r1', 111, 'one/x', null, ['HOOK_ONE'], 'no-closes'],
  ['o2/r2 は行の requireClosesIssue: false で本文が無くても通す', 'o2/r2', 222, 'claude/x', null, ['HOOK_TWO'], 'ok'],
];
for (const [name, repo, installation, ref, body, verified, reason] of cases) {
  test(`decideReview（表）: ${name}なら ${reason}`, () => {
    assert.deepEqual(decideReview(event(repo, installation, ref, body), config, table, verified), { review: reason === 'ok', reason });
  });
}

test('linkedIssueNumbers: closes-or-refs は Refs #N も含め、同じ番号は先のものを残す。省略時は closes', () => {
  const body = 'Refs #3\nCloses #5\nCloses #3\n<!-- Refs #9 -->\nRefs owner/repo#4';
  assert.deepEqual(linkedIssueNumbers(body, 'closes-or-refs'), [3, 5]);
  assert.deepEqual(linkedIssueNumbers(body), [5]);
});

test('verifyWithSecrets は署名が通った秘密の名前をすべて返し、空の値は試さず、どれも通らなければ空', async () => {
  const sign = async (secret: string, body: string) => {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return 'sha256=' + Buffer.from(await crypto.subtle.sign('HMAC', key, enc.encode(body))).toString('hex');
  };
  // 空の値は試さない（Node の Web Crypto は長さ 0 の鍵で投げるので、試せばこのテストが落ちる）
  const candidates = [
    { name: 'HOOK_A', value: 's1' },
    { name: 'HOOK_EMPTY', value: '' },
    { name: 'HOOK_B', value: 's1' },
    { name: 'HOOK_C', value: 's2' },
  ];
  assert.deepEqual(await verifyWithSecrets(candidates, '{}', await sign('s1', '{}')), ['HOOK_A', 'HOOK_B']);
  assert.deepEqual(await verifyWithSecrets(candidates, '{}', await sign('s3', '{}')), []);
});

test('collectMaterial は issueLink: closes-or-refs で Refs #N の Issue を材料にし、省略時は読まない', async () => {
  const head = 'a'.repeat(40);
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request) => {
    const p = new URL(String(input instanceof Request ? input.url : input)).pathname.replace('/repos/o1/r1', '');
    if (p === '/pulls/5') return json({ number: 5, title: 't', body: 'Refs #7', state: 'open', draft: true, head: { ref: 'one/x', sha: head }, base: { ref: 'main', sha: 'b'.repeat(40) }, user: null });
    if (p === '/issues/7') return json({ number: 7, title: 'Issue の題', body: 'Issue の本文', state: 'open', labels: [] });
    if (p === '/issues/7/comments') return json([]);
    if (p === `/compare/main...${head}`) return new Response('');
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  const gh = createGitHubClient({ token: 't', owner: 'o1', repo: 'r1', fetch });
  const claude = { reviewModel: 'm', riskModel: 'm', effort: 'high', maxTokens: 1, maxToolCalls: 1, maxDiffChars: 10, maxFileChars: 10, diffOnlyExtensions: [] };
  const collect = (issueLink?: IssueLink) =>
    collectMaterial(gh, { claude }, { owner: 'o1', repo: 'r1', pr: 5, headSha: head, appLogin: 'gate[bot]', previous: false, ...(issueLink ? { issueLink } : {}) });
  assert.deepEqual((await collect('closes-or-refs')).issue, { number: 7, title: 'Issue の題', body: 'Issue の本文' });
  assert.equal((await collect()).issue, null);
});
