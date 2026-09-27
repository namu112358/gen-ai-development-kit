import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import { testsHumanMergeReasons, type Acceptance } from '../lib/merge-route.ts';
import { patchId } from '../lib/patch-id.ts';
import { DEFAULT_TEST_PATTERNS, detectTestTampering, renderTamperForHumanMerge, renderTamperSummary } from '../lib/test-tamper.ts';
import { renderHumanReview } from '../gates/apply.ts';
import { onComment } from '../gates/on-comment.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { testsOutcome } from '../gates/tests-check.ts';
import { APP, HEAD, acceptanceFake, config, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

/** 人が Merge する PR（Human Merge）では、テストの改ざんの検査（agent/tests）を止めずに Merge の判断にまとめる（#125） */

// ---- 差分と偽の GitHub ----

/** 1ファイル・1 hunk の差分 */
const fileDiff = (path: string, lines: string[], start = 1): string => {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
};

const TEST_FILE = 'harness/test/a.test.ts';
/** テストの assert の行を変える差分（検出 1 件：harness/test/a.test.ts:5） */
const ASSERT_DIFF = fileDiff(TEST_FILE, ['-  assert.equal(f(), 2);', '+  assert.equal(f(), 3);'], 5);
/** ガードレール（harness/gates/run.ts）とテストの行を変える差分 */
const GUARD_DIFF = fileDiff('harness/gates/run.ts', ['-a', '+b']) + ASSERT_DIFF;
/** humanMergePaths（src/auth/**）とテストの行を変える差分 */
const AUTH_DIFF = fileDiff('src/auth/login.ts', ['-a', '+b']) + ASSERT_DIFF;

const GUARD_FILES = ['harness/gates/run.ts', TEST_FILE];
const AUTH_FILES = ['src/auth/login.ts', TEST_FILE];
const TEST_ONLY = [TEST_FILE];

let nextId = 200;
const appComment = (kind: string, value: unknown) => ({
  id: nextId++, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\n${renderBlock('agent-app', value)}`,
});

/** 受け付けの記録（App の構造化コメント、kind=acceptance） */
const acceptance = (diff: string, patch: Partial<Acceptance> = {}): Acceptance => ({
  version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(diff), reviewPass: true, riskLevel: 'critical', riskOk: false,
  scopeOk: true, outside: [], guardrail: [], humanMerge: [], autoEligible: false, reasons: ['Risk レベルが critical'], ...patch,
});
const acceptanceRecord = (diff: string, patch: Partial<Acceptance> = {}) => appComment('acceptance', acceptance(diff, patch));

/** App が test:exempt を付けた時点の差分で残した記録 */
const exemptRecord = (diff: string) => appComment('test-exempt', { version: 1, label: 'test:exempt', action: 'labeled', by: 'me', patchId: patchId(diff), headSha: HEAD });

/** 計画ゲートを通った計画（files は変更ファイルをすべて含める＝範囲内） */
const planGate = (files: string[]) => appComment('plan-gate', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } });

/** 差分・変更ファイル・PR のコメントなどを差し替えた偽の GitHub */
function fakeFor(opts: {
  diff: string; files: string[]; pr?: Record<string, unknown>; prComments?: unknown[]; dashboardLabels?: string[]; allowAutoMerge?: boolean;
}): FakeGitHub {
  return acceptanceFake({ pr: pr(opts.pr ?? {}), dashboardLabels: opts.dashboardLabels ?? [], prComments: opts.prComments ?? [], allowAutoMerge: opts.allowAutoMerge })
    .on('GET', /\/compare\//, (_m, _b, o) => (o.raw ? opts.diff : { behind_by: 0 }))
    .on('GET', /\/pulls\/5\/files/, () => opts.files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/3\/comments/, () => [planGate(opts.files)]);
}

const withHumanMerge = (paths: string[]): HarnessConfig => ({ ...config, humanMergePaths: paths });
const sync = { action: 'synchronize', pull_request: { number: 5 } };

/** agent/tests の書き込み（順に） */
const testsChecks = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === 'agent/tests').map((c) => c.body);
const lastTests = (fake: FakeGitHub) => testsChecks(fake).at(-1);
const conclusions = (fake: FakeGitHub) => testsChecks(fake).map((b) => b.conclusion as string);
const humanReviewBody = (fake: FakeGitHub): string =>
  String(fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/5/comments') && /kind=human-review/.test(String(c.body.body)))?.body.body ?? '');

const findings = detectTestTampering(ASSERT_DIFF, DEFAULT_TEST_PATTERNS);

// ---- 純粋関数：testsHumanMergeReasons ----

test('testsHumanMergeReasons：ガードレール・humanMergePaths に当たれば、ファイル名を含む理由をそれぞれ1つ返す', () => {
  const g = testsHumanMergeReasons({ guardrail: ['harness/gates/run.ts'], humanMerge: [], acceptance: null });
  assert.equal(g.length, 1);
  assert.match(g[0]!, /harness\/gates\/run\.ts/);

  const h = testsHumanMergeReasons({ guardrail: [], humanMerge: ['src/auth/login.ts'], acceptance: null });
  assert.equal(h.length, 1);
  assert.match(h[0]!, /src\/auth\/login\.ts/);

  const both = testsHumanMergeReasons({ guardrail: ['harness/gates/run.ts'], humanMerge: ['src/auth/login.ts'], acceptance: null });
  assert.equal(both.length, 2);
});

test('testsHumanMergeReasons：合格かつ自動 Merge の対象外の受け付けなら、その理由を足す', () => {
  const r = testsHumanMergeReasons({ guardrail: [], humanMerge: [], acceptance: acceptance(ASSERT_DIFF) });
  assert.deepEqual(r, ['Risk レベルが critical']);
});

test('testsHumanMergeReasons：何も当たらない・自動 Merge の対象・reviewPass: false の記録は空（Human Merge とみなさない）', () => {
  assert.deepEqual(testsHumanMergeReasons({ guardrail: [], humanMerge: [], acceptance: null }), []);
  assert.deepEqual(testsHumanMergeReasons({ guardrail: [], humanMerge: [], acceptance: acceptance(ASSERT_DIFF, { riskLevel: 'low', riskOk: true, autoEligible: true, reasons: [] }) }), []);
  assert.deepEqual(testsHumanMergeReasons({ guardrail: [], humanMerge: [], acceptance: acceptance(ASSERT_DIFF, { reviewPass: false, reasons: ['Reviewer のブロッキング指摘があります'] }) }), []);
});

// ---- 純粋関数：renderTamperForHumanMerge・renderTamperSummary ----

test('renderTamperForHumanMerge：平易な説明と見つけた行を出し、test:exempt を付けさせる文と「通し方」は出さない', () => {
  const s = renderTamperForHumanMerge(findings);
  assert.match(s, /何を見張っているか/);
  assert.match(s, /人が確かめること/);
  assert.match(s, /人が Merge/, '止めていない理由（人が Merge する PR）');
  assert.match(s, /コメント/, '問題があれば Merge せずコメントで直してもらう');
  assert.match(s, /`harness\/test\/a\.test\.ts:5（変更前）`/);
  assert.match(s, /変更前：`assert\.equal\(f\(\), 2\);`/);
  assert.match(s, /変更後：`assert\.equal\(f\(\), 3\);`/);
  assert.ok(s.indexOf('何を見張っているか') < s.indexOf('a.test.ts:5'), '説明が先、一覧が後');
  assert.doesNotMatch(s, /### 通し方/);
  assert.doesNotMatch(s, /付けます/);
  assert.doesNotMatch(s, /を付けてください/);
});

test('renderTamperForHumanMerge：limit を超えた分は「ほか N 件」にまとめる', () => {
  const many = detectTestTampering(fileDiff(TEST_FILE, ['-  assert.ok(a);', '-  assert.ok(b);', '-  assert.ok(c);', '+  assert.ok(x);']), DEFAULT_TEST_PATTERNS);
  assert.ok(many.length >= 2);
  assert.match(renderTamperForHumanMerge(many, 1), new RegExp(`ほか ${many.length - 1} 件`));
});

test('renderTamperSummary の出力は変わらない（「### 通し方」と test:exempt が出る）', () => {
  const s = renderTamperSummary(findings, 100, 'test:exempt');
  assert.match(s, /### 通し方/);
  assert.match(s, /`test:exempt` を付けます/);
  assert.match(s, /`harness\/test\/a\.test\.ts:5（変更前）`/);
});

// ---- 純粋関数：testsOutcome ----

test('testsOutcome：検出0件は success', () => {
  const o = testsOutcome([], ['ガードレールに触れます: harness/gates/run.ts']);
  assert.equal(o.conclusion, 'success');
  assert.equal(o.title, 'テストを弱める変更はありません');
});

test('testsOutcome：検出ありで Human Merge の理由が無ければ failure（今までどおりの要約）', () => {
  const o = testsOutcome(findings, []);
  assert.equal(o.conclusion, 'failure');
  assert.equal(o.title, 'テストを弱める変更が 1 件');
  assert.equal(o.summary, renderTamperSummary(findings, 100, 'test:exempt'));
});

test('testsOutcome：検出ありで Human Merge の理由があれば neutral、理由と Merge の判断向けの一覧を載せる', () => {
  const o = testsOutcome(findings, ['Risk レベルが critical']);
  assert.equal(o.conclusion, 'neutral');
  assert.equal(o.title, '人の確認が要るテストの変更が 1 件（Human Merge）');
  assert.ok(o.summary.startsWith('人の確認が要る変更あり。この PR は人が Merge するので止めていません（理由：'), o.summary.slice(0, 80));
  assert.match(o.summary, /Risk レベルが critical/);
  assert.match(o.summary, /自動 Merge の経路に変わると止めます。/);
  assert.ok(o.summary.includes(renderTamperForHumanMerge(findings)), '続けて renderTamperForHumanMerge');
  assert.doesNotMatch(o.summary, /### 通し方/);
});

// ---- 純粋関数：renderHumanReview ----

test('renderHumanReview：検出が無ければ今と同じ出力', () => {
  const a = acceptance(ASSERT_DIFF);
  const why = ['Risk レベルが critical'];
  assert.equal(renderHumanReview('me', a, why, { findings: [], relaxed: true }), renderHumanReview('me', a, why));
  assert.doesNotMatch(renderHumanReview('me', a, why), /\[!IMPORTANT\]/);
});

test('renderHumanReview：検出があれば1行目の直後（懸念点より前）に枠を出し、relaxed で文を書き分ける', () => {
  const a = acceptance(ASSERT_DIFF);
  const relaxed = renderHumanReview('me', a, ['Risk レベルが critical'], { findings, relaxed: true });
  const lines = relaxed.split('\n');
  assert.match(lines[0]!, /^@me レビューをお願いします（Human Merge）/);
  const box = relaxed.indexOf('> [!IMPORTANT]');
  assert.ok(box > lines[0]!.length && box < relaxed.indexOf('### 懸念点'), '1行目の直後、懸念点より前');
  assert.match(relaxed, /テストの行を変える変更が 1 件あります。/);
  assert.match(relaxed, /`agent\/tests` は Human Merge のため止めていません。/);
  assert.match(relaxed, /### テストの変更（Merge の前に確かめる）/);
  assert.ok(relaxed.includes(renderTamperForHumanMerge(findings, 30)));
  assert.doesNotMatch(relaxed, /を付けてください/);

  const strict = renderHumanReview('me', a, ['自動 Merge モードが無効です'], { findings, relaxed: false });
  assert.match(strict, /> \[!IMPORTANT\]/);
  assert.match(strict, /`agent\/tests` は止めています（自動 Merge に戻りうるため）。/);
  assert.match(strict, /`test:exempt` を付けてください。/);
});

// ---- AC1：Human Merge の PR では agent/tests が失敗しない（push の時点） ----

test('AC1：ガードレールに触れる Agent PR の push では、テストの行の変更があっても agent/tests は neutral で、要約に行が出る', async () => {
  const fake = fakeFor({ diff: GUARD_DIFF, files: GUARD_FILES });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  assert.ok(fake.writes().includes('check:agent/tests=neutral'));
  assert.ok(!conclusions(fake).includes('failure'));
  const body = lastTests(fake);
  assert.equal(body.head_sha, HEAD);
  assert.match(body.output.summary, /人の確認が要る変更あり/);
  assert.match(body.output.summary, /harness\/test\/a\.test\.ts:5/);
});

test('AC1：humanMergePaths に触れる Agent PR の push でも agent/tests は neutral', async () => {
  const fake = fakeFor({ diff: AUTH_DIFF, files: AUTH_FILES });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, { config: withHumanMerge(['src/auth/**']) }));
  assert.equal(lastTests(fake).conclusion, 'neutral');
  assert.ok(!conclusions(fake).includes('failure'));
});

test('AC1：リネームの旧パスがガードレールに当たる PR でも neutral', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY })
    .on('GET', /\/pulls\/5\/files/, () => [{ filename: TEST_FILE, additions: 1, deletions: 1 }, { filename: 'harness/x.ts', previous_filename: 'harness/gates/run.ts', additions: 0, deletions: 0 }]);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  assert.equal(lastTests(fake).conclusion, 'neutral');
});

test('AC1（判定後）：ガードレールの外でも、同じ patch-id に合格かつ自動 Merge の対象外の受け付けがあれば neutral', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY, prComments: [acceptanceRecord(ASSERT_DIFF)] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  const cs = conclusions(fake);
  assert.ok(cs.length > 0);
  assert.ok(cs.every((c) => c === 'neutral'), `agent/tests: ${cs.join(',')}`);
});

// ---- AC2：Human Merge の依頼に、見つけた行と説明が載る ----

test('AC2：critical の判定を受け付けると、agent/tests=neutral を Ready 化より前に書き、依頼のコメントに枠・行・説明が載る', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY });
  const v = verdict({ risk: { ...verdict().risk, level: 'critical' } });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v))));
  const w = fake.writes();
  assert.ok(w.includes('check:agent/tests=neutral'));
  assert.ok(!w.includes('check:agent/tests=failure'));
  assert.ok(w.indexOf('check:agent/tests=neutral') < w.indexOf('markPullRequestReadyForReview'), 'Ready 化より前');
  assert.ok(!w.includes('enablePullRequestAutoMerge'));

  const body = humanReviewBody(fake);
  const concerns = body.indexOf('### 懸念点');
  assert.ok(concerns > 0);
  const box = body.indexOf('[!IMPORTANT]');
  assert.ok(box > 0 && box < concerns, '枠は懸念点より前');
  assert.match(body, /テストの行を変える変更が 1 件あります。/);
  assert.match(body, /Human Merge のため止めていません/);
  assert.match(body, /何を見張っているか/, '平易な説明');
  assert.match(body, /`harness\/test\/a\.test\.ts:5（変更前）`/);
  assert.match(body, /変更前：`assert\.equal\(f\(\), 2\);`/);
  assert.match(body, /変更後：`assert\.equal\(f\(\), 3\);`/);
  assert.doesNotMatch(body, /を付けてください/);
  assert.doesNotMatch(body, /### 通し方/);
});

// ---- AC3：自動 Merge の対象の PR は今までどおり止まる ----

test('AC3：ガードレールの外・受け付けの記録なしの PR の push は failure', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.ok(!conclusions(fake).includes('neutral'));
});

test('AC3：low の判定（自動 Merge の対象）を受け付けると、agent/tests=failure を auto-merge の設定より前に書き、付けた後にもう一度書く', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  const enable = w.indexOf('enablePullRequestAutoMerge');
  assert.ok(enable >= 0, '自動 Merge の対象');
  assert.ok(w.indexOf('check:agent/tests=failure') < enable, 'auto-merge の設定より前');
  assert.ok(w.lastIndexOf('check:agent/tests=failure') > enable, 'armed の後にもう一度 failure');
  assert.ok(!w.includes('check:agent/tests=neutral') && !w.includes('check:agent/tests=success'));
  assert.equal(humanReviewBody(fake), '', 'Human Merge の依頼は出ない');
});

test('AC3：auto-merge を付けられず直接 Merge に進むときも、agent/tests=failure を Merge より前に書く', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY });
  fake.on('POST', /\/graphql/, (_m, body) => {
    if (String(body.query).includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: 'o/r' } }] } } } } };
    if (String(body.query).includes('enablePullRequestAutoMerge')) throw new Error('Pull request is in clean status');
    return { data: {} };
  });
  fake.on('PUT', /\/pulls\/5\/merge/, () => ({}));
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  const merge = w.indexOf('PUT /repos/o/r/pulls/5/merge');
  assert.ok(merge >= 0, '直接 Merge の経路');
  const failure = w.indexOf('check:agent/tests=failure');
  assert.ok(failure >= 0 && failure < merge, 'Merge より前に failure');
  assert.ok(!w.includes('check:agent/tests=neutral'));
});

test('AC3：リポジトリ設定の Allow auto-merge が切れていても（自動 Merge モードの停止だけが理由）、agent/tests は failure', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY, allowAutoMerge: false });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(w.includes('check:agent/tests=failure'));
  assert.ok(!w.includes('check:agent/tests=neutral'));
});

// ---- 要件：経路が後から自動 Merge に変わったら止める側に戻る ----

test('要件：同じ patch-id に自動 Merge の対象外の古い記録があっても、low の新しい判定では failure を auto-merge の設定より前に書く', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY, prComments: [acceptanceRecord(ASSERT_DIFF)] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  const enable = w.indexOf('enablePullRequestAutoMerge');
  assert.ok(enable >= 0);
  const failure = w.indexOf('check:agent/tests=failure');
  assert.ok(failure >= 0 && failure < enable);
  assert.ok(!w.includes('check:agent/tests=neutral'));
});

test('要件：push のときも最新の記録（自動 Merge の対象）で見て failure', async () => {
  const prComments = [
    acceptanceRecord(ASSERT_DIFF),
    acceptanceRecord(ASSERT_DIFF, { verdictCommentId: 71, riskLevel: 'low', riskOk: true, autoEligible: true, reasons: [] }),
  ];
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY, prComments });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  const w = fake.writes();
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.ok(!w.includes('check:agent/tests=neutral'));
  const enable = w.indexOf('enablePullRequestAutoMerge');
  if (enable >= 0) assert.ok(w.indexOf('check:agent/tests=failure') < enable, 'auto-merge の設定より前');
});

// ---- 緩めない場合 ----

test('緩めない：reviewPass: false の記録だけなら failure', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY, prComments: [acceptanceRecord(ASSERT_DIFF, { reviewPass: false, reasons: ['Reviewer のブロッキング指摘があります'] })] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.ok(!conclusions(fake).includes('neutral'));
});

test('緩めない：Agent PR でない（ブランチが claude/ でない）PR はガードレールに触れても failure', async () => {
  const fake = fakeFor({ diff: GUARD_DIFF, files: GUARD_FILES, pr: { head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } } });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.ok(!conclusions(fake).includes('neutral'));
});

test('緩めない：fork の PR はガードレールに触れても failure', async () => {
  const fake = fakeFor({ diff: GUARD_DIFF, files: GUARD_FILES, pr: { head: { ref: 'claude/issue-3', sha: HEAD, repo: { full_name: 'evil/r' } } } });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.ok(!conclusions(fake).includes('neutral'));
});

test('緩めない：PR に auto-merge が付いていれば、ガードレールに触れても failure', async () => {
  const fake = fakeFor({ diff: GUARD_DIFF, files: GUARD_FILES, pr: { auto_merge: { enabled: true } } });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'reopened', pull_request: { number: 5 } }));
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.ok(!conclusions(fake).includes('neutral'));
});

test('緩めない：途中で auto-merge が付いたら（書く直前に取り直した PR で）failure', async () => {
  const fake = fakeFor({ diff: GUARD_DIFF, files: GUARD_FILES });
  let reads = 0;
  // 最初の取得では auto-merge なし、その後は付いている
  fake.on('GET', /\/pulls\/5$/, () => ({ ...pr(), auto_merge: reads++ === 0 ? null : { enabled: true } }));
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.ok(!conclusions(fake).includes('neutral'));
});

test('緩めない：自動 Merge モードの停止だけが理由の Human Merge の依頼では、agent/tests は failure のままで、枠に test:exempt を求める文が出る', async () => {
  const fake = fakeFor({ diff: ASSERT_DIFF, files: TEST_ONLY, dashboardLabels: [config.autoMergeStopLabel] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(w.includes('check:agent/tests=failure'));
  assert.ok(!w.includes('check:agent/tests=neutral'));
  const body = humanReviewBody(fake);
  const box = body.indexOf('[!IMPORTANT]');
  assert.ok(box > 0 && box < body.indexOf('### 懸念点'));
  assert.match(body, /`agent\/tests` は止めています（自動 Merge に戻りうるため）。/);
  assert.match(body, /`test:exempt` を付けてください。/);
});

// ---- test:exempt が効いているとき・検出0件のとき ----

test('test:exempt が効いていれば、ガードレールに触れる PR でも今までどおり success（例外）', async () => {
  const fake = fakeFor({ diff: GUARD_DIFF, files: GUARD_FILES, pr: { labels: [{ name: 'test:exempt' }] }, prComments: [exemptRecord(GUARD_DIFF)] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  assert.deepEqual(conclusions(fake), ['success']);
  assert.match(lastTests(fake).output.title, /例外/);
});

test('test:exempt が効いていれば、判定の受け付け（applyAcceptance）は agent/tests を書かない', async () => {
  const fake = fakeFor({ diff: GUARD_DIFF, files: GUARD_FILES, pr: { labels: [{ name: 'test:exempt' }] }, prComments: [exemptRecord(GUARD_DIFF)] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.ok(fake.writes().includes('comment:acceptance'));
  assert.deepEqual(testsChecks(fake), []);
});

test('検出0件なら、判定の受け付けは agent/tests を書かない', async () => {
  const fake = fakeFor({ diff: fileDiff('docs/a.md', ['-a', '+b']), files: ['docs/a.md'] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict({ risk: { ...verdict().risk, level: 'critical' } })))));
  assert.ok(fake.writes().includes('comment:human-review'));
  assert.deepEqual(testsChecks(fake), []);
  assert.doesNotMatch(humanReviewBody(fake), /\[!IMPORTANT\]/);
});

test('検出0件なら、ガードレールに触れる PR の push でも success', async () => {
  const diff = fileDiff('harness/gates/run.ts', ['-a', '+b']);
  const fake = fakeFor({ diff, files: ['harness/gates/run.ts'] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  assert.deepEqual(conclusions(fake), ['success']);
});
