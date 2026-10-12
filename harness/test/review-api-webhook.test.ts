// review-api の Webhook の受け口（review-api/src/webhook.ts）の、署名の検証（verifySignature・constantTimeEqual）と、
// 対象の判定（decideReview）と、PR 本文の閉じる Issue の読み取り（closingIssueNumbers）を、外部 API を呼ばずに確かめる（Issue #878）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadReviewConfig } from '../../review-api/src/config.ts';
import { closingIssueNumbers, constantTimeEqual, decideReview, verifySignature } from '../../review-api/src/webhook.ts';
import type { PullRequestEvent, ReviewEnv } from '../../review-api/src/webhook.ts';

// GitHub の公式のテストベクタ（Webhook の署名の検証の説明にある例）
const SECRET = "It's a Secret to Everybody";
const BODY = 'Hello, World!';
const SIGNATURE = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

test('公式のテストベクタで署名の検証が真（本文が string でも Uint8Array でも）', async () => {
  assert.equal(await verifySignature(SECRET, BODY, SIGNATURE), true);
  assert.equal(await verifySignature(SECRET, new TextEncoder().encode(BODY), SIGNATURE), true);
});

const badHeaders: [string, string | null][] = [
  ['1文字違い', SIGNATURE.slice(0, -1) + '8'],
  ['sha1=', 'sha1=' + SIGNATURE.slice('sha256='.length)],
  ['空', ''],
  ['null', null],
  ['63 桁', SIGNATURE.slice(0, -1)],
  ['65 桁', SIGNATURE + '0'],
];
for (const [name, header] of badHeaders) {
  test(`署名の header が${name}なら偽`, async () => {
    assert.equal(await verifySignature(SECRET, BODY, header), false);
  });
}

test('constantTimeEqual は同じ内容で真、1バイト違い・長さ違いで偽', () => {
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 0])), false);
});

const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
const baseConfig = loadReviewConfig(JSON.parse(readFileSync(configPath, 'utf8')));
const baseEnv: ReviewEnv = { ALLOWED_REPOS: 'owner/repo', GITHUB_INSTALLATION_ID: '42' };
const baseEvent = (): PullRequestEvent => ({
  action: 'opened',
  sender: { type: 'User', login: 'someone' },
  repository: { full_name: 'owner/repo' },
  installation: { id: 42 },
  pull_request: { head: { ref: 'claude/issue-1-x' }, body: 'Closes #1' },
});

// ケースごとに event・trigger・env の差分と、期待する reason
const cases: {
  name: string;
  event?: (e: PullRequestEvent) => void;
  trigger?: Partial<typeof baseConfig.trigger>;
  env?: Partial<ReviewEnv>;
  reason: string;
}[] = [
  { name: '対象', reason: 'ok' },
  { name: 'pull_request が無い', event: (e) => { delete e.pull_request; }, reason: 'not-pull-request' },
  { name: 'action が対象外', event: (e) => { e.action = 'closed'; }, reason: 'action' },
  { name: 'action が無い', event: (e) => { delete e.action; }, reason: 'action' },
  { name: 'sender.type が Bot', event: (e) => { e.sender = { type: 'Bot', login: 'x' }; }, reason: 'bot-sender' },
  { name: 'login が [bot] で終わる', event: (e) => { e.sender = { type: 'User', login: 'app[bot]' }; }, reason: 'bot-sender' },
  { name: 'skipBotSenders が偽なら Bot を通す', event: (e) => { e.sender = { type: 'Bot', login: 'app[bot]' }; }, trigger: { skipBotSenders: false }, reason: 'ok' },
  { name: 'allowlist の外', env: { ALLOWED_REPOS: 'owner/other' }, reason: 'repo-not-allowed' },
  { name: 'ALLOWED_REPOS が空', env: { ALLOWED_REPOS: '' }, reason: 'repo-not-allowed' },
  { name: 'allowlist は大文字小文字と前後の空白を区別しない', event: (e) => { e.repository = { full_name: 'Owner/Repo' }; }, env: { ALLOWED_REPOS: ' other/x , OWNER/REPO ' }, reason: 'ok' },
  { name: 'installation id 違い', event: (e) => { e.installation = { id: 7 }; }, reason: 'installation-mismatch' },
  { name: 'GITHUB_INSTALLATION_ID が空', env: { GITHUB_INSTALLATION_ID: '' }, reason: 'installation-mismatch' },
  { name: 'installation.id が無い', event: (e) => { delete e.installation; }, reason: 'installation-mismatch' },
  { name: 'ブランチの接頭辞違い', event: (e) => { e.pull_request!.head = { ref: 'feature/x' }; }, reason: 'branch-prefix' },
  { name: 'branchPrefix が空なら全部', event: (e) => { e.pull_request!.head = { ref: 'feature/x' }; }, trigger: { branchPrefix: '' }, reason: 'ok' },
  { name: 'Closes 無し', event: (e) => { e.pull_request!.body = 'Refs #1'; }, reason: 'no-closes' },
  { name: 'requireClosesIssue が偽なら Closes 無しでも対象', event: (e) => { e.pull_request!.body = null; }, trigger: { requireClosesIssue: false }, reason: 'ok' },
];
for (const c of cases) {
  test(`decideReview: ${c.name}なら ${c.reason}`, () => {
    const event = baseEvent();
    c.event?.(event);
    const config = { trigger: { ...baseConfig.trigger, ...c.trigger } };
    assert.deepEqual(decideReview(event, config, { ...baseEnv, ...c.env }), { review: c.reason === 'ok', reason: c.reason });
  });
}

// harness/lib/state.ts の bodyIssueRefs の閉じる側と同じ規則
const bodies: [string, string | null, number[]][] = [
  ['null', null, []],
  ['Closes', 'Closes #1', [1]],
  ['別形と : と大文字小文字', 'fixes: #2\nResolved #3\nclose #4\nFIXED #5\nresolves #6', [2, 3, 4, 5, 6]],
  ['重複は1つで出てくる順', 'Fixes #9\nCloses #2\ncloses #9', [9, 2]],
  ['Refs と owner/repo#N は読まない', 'Refs #3\nCloses owner/repo#4\nCloses #5', [5]],
  ['HTML コメントの中は読まない', '<!-- Closes #1 -->\nCloses #2', [2]],
  ['``` のフェンスの中は読まない', '```\nCloses #1\n```\nCloses #2', [2]],
  ['~~~ のフェンスの中は読まない', '~~~\nCloses #1\n~~~\nCloses #2', [2]],
];
for (const [name, body, expected] of bodies) {
  test(`closingIssueNumbers: ${name}`, () => {
    assert.deepEqual(closingIssueNumbers(body), expected);
  });
}
