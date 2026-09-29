import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { claimAt, commitSessions, sessionKey, unclaimedPushNotified, unclaimedPushReason, UNCLAIMED_PUSH_KIND } from '../lib/push-claim.ts';
import type { Claim } from '../lib/queue.ts';
import { APP, HEAD, claimComment, config, verdictComment } from './support/gate-fixtures.ts';

const S1 = 'https://claude.ai/code/session_01AAAAAAAAAAAAAAAAAAAAAAAA';
const S2 = 'https://claude.ai/code/session_01BBBBBBBBBBBBBBBBBBBBBBBB';
const CO = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

// --- commitSessions（commit の trailer） ---

test('commitSessions：末尾の段落の Claude-Session を集め、claude を真にする', () => {
  const r = commitSessions([`feat: a\n\n本文\n\nClaude-Session: ${S1}\n${CO}`]);
  assert.deepEqual(r, { claude: true, sessions: [S1] });
});

test('commitSessions：Claude の Co-Authored-By だけでも claude を真にする（sessions は空）', () => {
  assert.deepEqual(commitSessions([`fix: b\n\n${CO}`]), { claude: true, sessions: [] });
});

test('commitSessions：Claude-Session だけでも claude を真にする', () => {
  assert.deepEqual(commitSessions([`fix: b\n\nClaude-Session: ${S1}`]), { claude: true, sessions: [S1] });
});

test('commitSessions：キーの大文字小文字を区別しない（Co-authored-by・claude-session）', () => {
  assert.deepEqual(commitSessions(['fix: b\n\nCo-authored-by: Claude <noreply@anthropic.com>']), { claude: true, sessions: [] });
  assert.deepEqual(commitSessions([`fix: b\n\nclaude-session: ${S2}`]), { claude: true, sessions: [S2] });
});

test('commitSessions：複数の commit の session を重複なしで集める', () => {
  const r = commitSessions([`a\n\nClaude-Session: ${S1}`, `b\n\nClaude-Session: ${S2}`, `c\n\nClaude-Session: ${S1}\n${CO}`]);
  assert.equal(r.claude, true);
  assert.deepEqual([...r.sessions].sort(), [S1, S2].sort());
});

test('commitSessions：本文の途中（末尾の段落でない）の同じ形の行は読まない', () => {
  const msg = `docs: trailer の説明\n\nClaude-Session: ${S1}\n${CO}\n\nこの段落が最後なので上の行は trailer ではない。`;
  assert.deepEqual(commitSessions([msg]), { claude: false, sessions: [] });
});

test('commitSessions：1行だけのメッセージは trailer なし', () => {
  assert.deepEqual(commitSessions([`Claude-Session: ${S1}`]), { claude: false, sessions: [] });
});

test('commitSessions：人の commit（trailer が無い・ほかの Co-Authored-By）は claude が偽', () => {
  assert.deepEqual(commitSessions(['fix: c\n\n本文', 'feat: d\n\nCo-Authored-By: Someone <someone@example.com>', "Merge branch 'main' into claude/issue-3"]), { claude: false, sessions: [] });
  assert.deepEqual(commitSessions([]), { claude: false, sessions: [] });
});

// --- sessionKey ---

test('sessionKey：session_X と cse_X の URL は同じ鍵になる', () => {
  assert.equal(sessionKey('https://claude.ai/code/session_X'), 'session_X');
  assert.equal(sessionKey('https://claude.ai/code/cse_X'), 'session_X');
  assert.equal(sessionKey('https://claude.ai/code/cse_X'), sessionKey('https://claude.ai/code/session_X'));
});

test('sessionKey：URL でない値（付き添いのセッションの ID）はそのままで、URL のセッションとは合わない', () => {
  const local = '8f2c1d3e-0000-4000-8000-123456789abc';
  assert.equal(sessionKey(local), local);
  assert.notEqual(sessionKey(local), sessionKey(S1));
  assert.notEqual(sessionKey(S1), sessionKey(S2));
});

// --- claimAt ---

const T = (h: number) => new Date(Date.UTC(2026, 8, 28) + h * 3600_000).toISOString();

test('claimAt：push より前の宣言は有効', () => {
  const c = claimComment({ at: T(1), stage: 'implement' });
  assert.equal(claimAt([c], T(2))?.stage, 'implement');
});

test('claimAt：push の後の解除があっても、push の時点では有効', () => {
  const comments = [claimComment({ at: T(1), stage: 'implement' }), claimComment({ at: T(3), released: true })];
  assert.notEqual(claimAt(comments, T(2)), null);
});

test('claimAt：push の後の判定コメントがあっても、push の時点では有効', () => {
  const comments = [claimComment({ at: T(1), stage: 'judge' }), { ...verdictComment(), created_at: T(3) }];
  assert.notEqual(claimAt(comments, T(2)), null);
});

test('claimAt：push の後の宣言は数えない', () => {
  assert.equal(claimAt([claimComment({ at: T(3) })], T(2)), null);
});

test('claimAt：push より前に解除されていれば null', () => {
  const comments = [claimComment({ at: T(1) }), claimComment({ at: T(1.5), released: true })];
  assert.equal(claimAt(comments, T(2)), null);
});

// --- unclaimedPushReason（表の各行） ---

const manual = (session?: string): Claim => ({ by: 'manual', at: T(1), ...(session ? { session } : {}) });

test('unclaimedPushReason：Claude の印が無い（人の push）なら null', () => {
  assert.equal(unclaimedPushReason({ claims: [], commits: { claude: false, sessions: [] } }), null);
  assert.equal(unclaimedPushReason({ claims: [null], commits: { claude: false, sessions: [] } }), null);
});

test('unclaimedPushReason：有効な宣言が1つも無ければ no-claim', () => {
  assert.equal(unclaimedPushReason({ claims: [], commits: { claude: true, sessions: [S1] } }), 'no-claim');
  assert.equal(unclaimedPushReason({ claims: [null, null], commits: { claude: true, sessions: [] } }), 'no-claim');
  assert.equal(unclaimedPushReason({ claims: [{ ...manual(S1), released: true }], commits: { claude: true, sessions: [S1] } }), 'no-claim');
});

test('unclaimedPushReason：session のある宣言のどれとも合わなければ session-mismatch', () => {
  assert.equal(unclaimedPushReason({ claims: [manual(S2)], commits: { claude: true, sessions: [S1] } }), 'session-mismatch');
  assert.equal(unclaimedPushReason({ claims: [null, { by: 'routine', session: S2, at: T(1) }], commits: { claude: true, sessions: [S1] } }), 'session-mismatch');
});

test('unclaimedPushReason：どれかの宣言の session と合えば null（cse_ と session_ の違いは同じとみなす）', () => {
  assert.equal(unclaimedPushReason({ claims: [manual(S1)], commits: { claude: true, sessions: [S1] } }), null);
  assert.equal(unclaimedPushReason({ claims: [manual(S2), manual(S1)], commits: { claude: true, sessions: [S1] } }), null);
  assert.equal(unclaimedPushReason({ claims: [manual('https://claude.ai/code/session_X')], commits: { claude: true, sessions: ['https://claude.ai/code/cse_X'] } }), null);
});

test('unclaimedPushReason：commit に session が無い、または session のある宣言が無ければ null', () => {
  assert.equal(unclaimedPushReason({ claims: [manual(S2)], commits: { claude: true, sessions: [] } }), null);
  assert.equal(unclaimedPushReason({ claims: [manual()], commits: { claude: true, sessions: [S1] } }), null);
});

// --- unclaimedPushNotified ---

const record = (headSha: string, login = APP) => ({
  id: 300, created_at: T(4), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login, type: 'Bot' },
  body: `${appMark(UNCLAIMED_PUSH_KIND)}\n知らせ\n${renderBlock('agent-app', { version: 1, headSha, reason: 'no-claim', commitSessions: [S1], claimSessions: [] })}`,
});

test('unclaimedPushNotified：同じ head の App の記録があれば真、別の head・App でない書き手なら偽', () => {
  assert.equal(UNCLAIMED_PUSH_KIND, 'unclaimed-push');
  assert.equal(unclaimedPushNotified(config, [record(HEAD)], HEAD), true);
  assert.equal(unclaimedPushNotified(config, [record('d'.repeat(40))], HEAD), false);
  assert.equal(unclaimedPushNotified(config, [record(HEAD, 'me')], HEAD), false);
  assert.equal(unclaimedPushNotified(config, [{ ...record(HEAD), body: `${claudeMark()}\n${renderBlock('agent-app', { headSha: HEAD })}` }], HEAD), false);
});
