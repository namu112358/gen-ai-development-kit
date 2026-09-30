// auto mode で Agent PR に auto-merge を付ける動作（判定の受け付け・自動 Merge／委任／bypass との順番・agent/tests・委任と bypass との引き継ぎ）を、
// 偽の GitHub と偽の Jev で確かめる（Issue #346）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig } from '../lib/auto-mode.ts';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { bypassMergeConfig, CHECKS, delegateConfig, LABELS, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { patchId } from '../lib/patch-id.ts';
import type { Verdict } from '../lib/verdict.ts';
import { onComment } from '../gates/on-comment.ts';
import { onIssue } from '../gates/on-issue.ts';
import { APP, DIFF, HEAD, acceptanceFake, config as base, ctxFor, delegateWorldFake, pr, verdict, verdictEvent, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, dashboardLabelEvent, FEATURE_BASE, postedBodies, postedRecord } from './support/stack-fixtures.ts';

/** 判定の受け付けで Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の危険の問いは jev.mode と独立） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };

const AUTO = autoModeConfig(config).label;
const BYPASS = bypassMergeConfig(config).label;
const DELEGATE = delegateConfig(config).mergeLabel;
/** ガードレールにも delegateMergeExclude にも当たる（委任でも乗らない） */
const CONFIG_FILE = 'harness.config.json';
/** ガードレールに当たるが delegateMergeExclude には当たらない（委任で乗る） */
const GUARDED = 'harness/lib/epic.ts';
const SKIP_DIFF = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n";

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number): string => minutesAgo(h * 60);
const ev = (event: 'labeled' | 'unlabeled', name: string, at: string, login = 'me') => ({ event, created_at: at, actor: { login }, label: { name } });
const autoOn = (at = hoursAgo(5), login = 'me') => ev('labeled', AUTO, at, login);
const autoOff = (at = minutesAgo(1), login = 'me') => ev('unlabeled', AUTO, at, login);
const bypassOn = (at = hoursAgo(6), login = 'me') => ev('labeled', BYPASS, at, login);
const bypassOff = (at = minutesAgo(1), login = 'me') => ev('unlabeled', BYPASS, at, login);
const delegateOn = (at = minutesAgo(10), login = 'me') => ev('labeled', DELEGATE, at, login);
const delegateOff = (at = minutesAgo(1), login = 'me') => ev('unlabeled', DELEGATE, at, login);
const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

/** 計画ゲートを通った記録（files 指定） */
const planGate = (files: string[]) => ({
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } })}`,
});

/** 偽の Jev。危険の問い（danger）にだけ answer で答え、問った回数を残す */
function fakeJev(answer: number) {
  const asked: unknown[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request);
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
  };
  return { asked, fn };
}

/** 判定の受け付け（onComment）用。既定は、変更ファイルと計画の files がどちらも harness.config.json（範囲内・委任しないパス） */
function verdictFake(o: { dashboardLabels: string[]; events?: unknown[]; files?: string[]; planFiles?: string[]; pr?: ReturnType<typeof pr>; diff?: string; prComments?: unknown[] }): FakeGitHub {
  const files = o.files ?? [CONFIG_FILE];
  const fake = acceptanceFake({ pr: o.pr ?? pr(), dashboardLabels: o.dashboardLabels, dashboardEvents: o.events ?? [], prComments: o.prComments ?? [] })
    .on('GET', /\/issues\/3\/comments/, () => [planGate(o.planFiles ?? files)])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/5\/events/, () => []);
  if (o.diff) fake.on('GET', /\/compare\//, (_m, _b, opts) => (opts.raw ? o.diff : { behind_by: 0 }));
  return fake;
}

/** 判定コメントを受け付ける。既定は Jev が安全（0.01）と答え、鍵がある */
async function accept(fake: FakeGitHub, v: Verdict = critical(), o: { jev?: ReturnType<typeof fakeJev>; key?: boolean } = {}): Promise<void> {
  const jev = o.jev ?? fakeJev(0.01);
  const extra = { config, secrets: o.key === false ? {} : { jevApiKey: 'jev-key' }, askJev: jev.fn };
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), extra));
}

/** 書いたチェック（名前指定、sha を渡せばその head のものだけ） */
function checks(fake: FakeGitHub, name: string, sha?: string): { conclusion: string; title: string }[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === name && (sha === undefined || c.body.head_sha === sha))
    .map((c) => ({ conclusion: c.body.conclusion, title: String(c.body.output?.title ?? '') }));
}

/** GraphQL の mutation（名前指定）の対象の PR の node_id を呼んだ順に */
function mutationIds(fake: FakeGitHub, name: string): string[] {
  return fake.calls.filter((c) => c.path === '/graphql' && String(c.body?.query).includes(`{${name}(`)).map((c) => String(c.body.variables?.id));
}

/** Issue・PR（番号指定）への App のコメントの kind を書いた順に */
function kindsOn(fake: FakeGitHub, issue: number): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${issue}/comments`))
    .map((c) => String(c.body.body).match(/kind=([\w-]+)/)?.[1] ?? '?');
}

// ---- 受け付けの記録と App の記録（開いた PR のコメント） ----

const JEV_SAFE = { status: 'ok', detail: 'jev', yes: 0.01, questionSet: AUTO_MODE_JEV_QUESTION_SET };
const DELEGATE_NO = { eligible: false, reasons: [`委任しないパスに触れます（delegateMergeExclude）: ${CONFIG_FILE}`], skipped: [], scopeOk: true, outside: [], exclude: [CONFIG_FILE] };
const DELEGATE_OK = { eligible: true, reasons: [], skipped: [`ガードレールに触れます: ${GUARDED}`, 'Risk が critical です'], scopeOk: true, outside: [], exclude: [] };
const AUTO_OK = { eligible: true, reasons: [], skipped: ['Risk が critical です', `ガードレールに触れます: ${CONFIG_FILE}`, `委任しないパスに触れます（delegateMergeExclude）: ${CONFIG_FILE}`], jev: JEV_SAFE };
const BYPASS_OK = { eligible: true, reasons: [], skipped: AUTO_OK.skipped };
const BYPASS_NO = { eligible: false, reasons: ['計画の範囲外のファイルがあります: docs/x.md'], skipped: [] };

/** auto mode でも bypass でも乗る受け付け（委任しないパスに触れ、critical。委任では乗らない） */
const autoBypassAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${CONFIG_FILE}`], delegate: DELEGATE_NO, autoMode: AUTO_OK, bypass: BYPASS_OK });

/** 委任でも auto mode でも乗る受け付け（ガードレールに触れ、critical。bypass では乗らない） */
const delegateAutoAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${GUARDED}`], delegate: DELEGATE_OK, autoMode: { ...AUTO_OK, skipped: DELEGATE_OK.skipped }, bypass: BYPASS_NO });

/** auto mode で auto-merge を付けた App の記録（kind=auto-mode-merge） */
const autoArmed = (id: number, headSha: string, since: string) =>
  appRecordComment(id, 'auto-mode-merge', 'auto mode で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(DIFF), since, by: 'me', skipped: AUTO_OK.skipped });

/** bypass で auto-merge を付けた App の記録（kind=bypass-merge） */
const bypassArmed = (id: number, headSha: string, since: string) =>
  appRecordComment(id, 'bypass-merge', 'bypass モードで自動経路に乗せました。', { version: 1, headSha, patchId: patchId(DIFF), since, by: 'me', skipped: BYPASS_OK.skipped });

/** 委任で auto-merge を付けた App の記録（kind=delegated-merge） */
const delegateArmed = (id: number, headSha: string, since: string) =>
  appRecordComment(id, 'delegated-merge', '委任承認（計画＋Merge）で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(DIFF), since, until: null, by: 'me', skipped: DELEGATE_OK.skipped });

/** 開いた Agent PR（番号ごとに head・node_id を変える） */
const agentPr = (n: number, patch: Record<string, unknown> = {}) =>
  pr({ number: n, node_id: `PR_${n}`, draft: false, head: { ref: `claude/issue-${n}`, sha: String(n).repeat(40), repo: { full_name: 'o/r' } }, ...patch });
const sha = (n: number): string => String(n).repeat(40);
const ARMED = { auto_merge: { enabled: true } };

// ---- 受け付け：auto mode が有効なら、Jev が安全と答えた critical・ガードレール・delegateMergeExclude の PR に auto-merge を付ける ----

test('auto mode が有効：harness.config.json に触れ Risk が critical の PR を Jev が安全と答えれば、auto-mode-merge を記録してから auto-merge を付け、merge-route は success、human-review は出さない', async () => {
  const since = hoursAgo(5);
  const fake = verdictFake({ dashboardLabels: [AUTO], events: [autoOn(since)] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:auto-mode-merge'), w.join('\n'));
  assert.ok(w.indexOf('comment:auto-mode-merge') < w.indexOf('enablePullRequestAutoMerge'), 'auto-merge を付ける前に記録を書く');
  assert.ok(!w.includes('comment:human-review'), w.join('\n'));
  assert.ok(!w.includes('comment:delegated-merge'), '委任の記録は書かない');
  assert.ok(!w.includes('comment:bypass-merge'), 'bypass の記録は書かない');
  const route = checks(fake, CHECKS.mergeRoute).at(-1);
  assert.equal(route?.conclusion, 'success');
  assert.equal(route?.title, 'auto mode の条件を満たしています');

  const rec = postedRecord(fake, 'auto-mode-merge');
  assert.equal(rec.version, 1);
  assert.equal(rec.headSha, HEAD);
  assert.equal(rec.patchId, patchId(DIFF));
  assert.equal(rec.by, 'me');
  assert.equal(Date.parse(rec.since), Date.parse(since));
  assert.deepEqual(rec.skipped, postedRecord(fake, 'acceptance').autoMode?.skipped, 'skipped は受け付けの autoMode.skipped');
  assert.ok((rec.skipped as string[]).some((s) => s.includes(CONFIG_FILE)), JSON.stringify(rec.skipped));
});

test('auto mode が有効：同じ patchId・since の auto-mode-merge の記録が最新なら、記録を書き足さずに auto-merge を付ける', async () => {
  const since = hoursAgo(5);
  const fake = verdictFake({ dashboardLabels: [AUTO], events: [autoOn(since)], prComments: [autoArmed(92, HEAD, since)] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:auto-mode-merge'), w.join('\n'));
});

test('auto mode が有効でも、Jev が危険と答えた・鍵なしの PR には auto-merge を付けず、human-review に Jev の1行を載せる', async () => {
  const cases: [string, { jev?: ReturnType<typeof fakeJev>; key?: boolean }, RegExp][] = [
    ['危険', { jev: fakeJev(0.5) }, /危険の確率 50%/],
    ['鍵なし', { key: false }, /JEV_API_KEY/],
  ];
  for (const [name, o, detail] of cases) {
    const fake = verdictFake({ dashboardLabels: [AUTO], events: [autoOn()] });
    await accept(fake, critical(), o);
    const w = fake.writes();
    assert.ok(!w.includes('enablePullRequestAutoMerge'), `${name}: ${w.join('\n')}`);
    assert.ok(!w.includes('comment:auto-mode-merge'), `${name}: ${w.join('\n')}`);
    assert.ok(w.includes('comment:human-review'), `${name}: ${w.join('\n')}`);
    const body = postedBodies(fake, 'human-review').at(-1) ?? '';
    const lines = body.split('\n').filter((l) => l.includes('Jev：'));
    assert.ok(lines.length > 0, `${name}: human-review に Jev の行が無い\n${body}`);
    assert.ok(lines.some((l) => detail.test(l)), `${name}: Jev の行に ${detail} が無い\n${lines.join('\n')}`);
    assert.ok(body.includes('auto mode でも不可: '), `${name}: 自動 Merge しない理由に auto mode の理由が無い\n${body}`);
  }
});

test('auto mode が有効でも、自動 Merge の対象（low・docs）の PR は今までどおり自動 Merge として扱い、auto mode の記録は書かない', async () => {
  const fake = verdictFake({ dashboardLabels: [AUTO], events: [autoOn()], files: ['docs/a.md'] });
  await accept(fake, verdict());
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:auto-mode-merge'), w.join('\n'));
  assert.equal(checks(fake, CHECKS.mergeRoute).at(-1)?.title, '自動 Merge 条件を満たしています');
});

test('auto mode が有効でも、hold・計画の範囲外・ブロッキング指摘・base が既定でない PR には auto-merge を付けない', async () => {
  const blocking = verdict({ risk: critical().risk, review: { pass: false, blocking: [{ kind: 'ac-unmet', detail: 'AC 2' }], nonBlocking: [] } });
  const cases: [string, FakeGitHub, Verdict][] = [
    ['hold', verdictFake({ dashboardLabels: [AUTO], events: [autoOn()], pr: pr({ labels: [{ name: LABELS.hold }] }) }), critical()],
    ['範囲外', verdictFake({ dashboardLabels: [AUTO], events: [autoOn()], files: [CONFIG_FILE, 'docs/x.md'], planFiles: [CONFIG_FILE] }), critical()],
    ['ブロッキング指摘', verdictFake({ dashboardLabels: [AUTO], events: [autoOn()] }), blocking],
    ['base が既定でない', verdictFake({ dashboardLabels: [AUTO], events: [autoOn()], pr: pr({ base: FEATURE_BASE }) }), critical()],
  ];
  for (const [name, fake, v] of cases) {
    await accept(fake, v);
    const w = fake.writes();
    assert.ok(!w.includes('enablePullRequestAutoMerge'), `${name}: ${w.join('\n')}`);
    assert.ok(!w.includes('comment:auto-mode-merge'), `${name}: ${w.join('\n')}`);
  }
});

test('auto mode が有効でも、hold・計画の範囲外の PR には human-review を出す', async () => {
  for (const [name, fake] of [
    ['hold', verdictFake({ dashboardLabels: [AUTO], events: [autoOn()], pr: pr({ labels: [{ name: LABELS.hold }] }) })],
    ['範囲外', verdictFake({ dashboardLabels: [AUTO], events: [autoOn()], files: [CONFIG_FILE, 'docs/x.md'], planFiles: [CONFIG_FILE] })],
  ] as const) {
    await accept(fake);
    assert.ok(fake.writes().includes('comment:human-review'), `${name}: ${fake.writes().join('\n')}`);
  }
});

test('auto mode の App・Bot が付けたラベル・停止スイッチでは、今までどおり Human Merge', async () => {
  const cases: [string, FakeGitHub][] = [
    ['App', verdictFake({ dashboardLabels: [AUTO], events: [autoOn(hoursAgo(1), APP)] })],
    ['Bot', verdictFake({ dashboardLabels: [AUTO], events: [autoOn(hoursAgo(1), 'someone[bot]')] })],
    ['停止スイッチ', verdictFake({ dashboardLabels: [AUTO, config.autoMergeStopLabel], events: [autoOn()] })],
  ];
  for (const [name, fake] of cases) {
    await accept(fake);
    const w = fake.writes();
    assert.ok(!w.includes('enablePullRequestAutoMerge'), `${name}: ${w.join('\n')}`);
    assert.ok(!w.includes('comment:auto-mode-merge'), name);
    assert.ok(w.includes('comment:human-review'), name);
  }
});

// ---- 乗り方の順番：自動 Merge の対象 → 委任 → auto mode → bypass ----

test('委任と auto mode が両方有効：委任で乗る PR には委任の記録だけを書き、auto mode の記録は書かない', async () => {
  const fake = verdictFake({ dashboardLabels: [DELEGATE, AUTO], events: [autoOn(), delegateOn()], files: [GUARDED] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:delegated-merge'), w.join('\n'));
  assert.ok(!w.includes('comment:auto-mode-merge'), w.join('\n'));
  assert.equal(checks(fake, CHECKS.mergeRoute).at(-1)?.title, '委任承認（計画＋Merge）の条件を満たしています');
});

test('auto mode と bypass が両方有効：両方で乗る PR には auto mode の記録だけを書き、bypass の記録は書かない', async () => {
  const fake = verdictFake({ dashboardLabels: [AUTO, BYPASS], events: [bypassOn(), autoOn()] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:auto-mode-merge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'), w.join('\n'));
  assert.equal(checks(fake, CHECKS.mergeRoute).at(-1)?.title, 'auto mode の条件を満たしています');
});

test('auto mode の危険の判定で保留でも、bypass が有効で bypass で乗るなら bypass-merge を書いて auto-merge を付ける（bypass の動きは変えない）', async () => {
  const fake = verdictFake({ dashboardLabels: [AUTO, BYPASS], events: [bypassOn(), autoOn()] });
  await accept(fake, critical(), { jev: fakeJev(0.5) });
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:bypass-merge'), w.join('\n'));
  assert.ok(!w.includes('comment:auto-mode-merge'), w.join('\n'));
  assert.ok(!w.includes('comment:human-review'), w.join('\n'));
  assert.equal(checks(fake, CHECKS.mergeRoute).at(-1)?.title, 'bypass モードの条件を満たしています');
});

// ---- 新しい判定で乗らなくなったら外す ----

test('auto mode で付けた後に新しい判定で auto mode でも乗らなくなったら、auto-merge を外し auto-mode-merge-end（ineligible）と human-review を出す', async () => {
  const since = hoursAgo(5);
  const fake = verdictFake({
    dashboardLabels: [AUTO], events: [autoOn(since)], files: [CONFIG_FILE, 'docs/x.md'], planFiles: [CONFIG_FILE],
    pr: pr(ARMED), prComments: [autoArmed(92, HEAD, since)],
  });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('disablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:auto-mode-merge-end'), w.join('\n'));
  assert.ok(w.includes('comment:human-review'), w.join('\n'));
  const end = postedRecord(fake, 'auto-mode-merge-end');
  assert.equal(end.version, 1);
  assert.equal(end.reason, 'ineligible');
  assert.equal(end.headSha, HEAD);
});

// ---- agent/tests ----

test('auto mode で乗る PR でテストを弱める変更があると、agent/tests は failure（Human Merge とみなさない）', async () => {
  const files = [CONFIG_FILE, 'a.test.ts'];
  const fake = verdictFake({ dashboardLabels: [AUTO], events: [autoOn()], files, diff: SKIP_DIFF });
  await accept(fake);
  const tests = checks(fake, CHECKS.tests);
  assert.ok(tests.length > 0, 'agent/tests を書いていません');
  assert.ok(tests.every((t) => t.conclusion === 'failure'), JSON.stringify(tests));
});

test('auto mode が無効なら今までどおり：テストを弱める変更は neutral（Human Merge）', async () => {
  const files = [CONFIG_FILE, 'a.test.ts'];
  const fake = verdictFake({ dashboardLabels: [], files, diff: SKIP_DIFF });
  await accept(fake);
  assert.equal(checks(fake, CHECKS.tests).at(-1)?.conclusion, 'neutral');
});

// ---- 引き継ぎ：委任・bypass と auto mode のあいだ ----

const onDashboard = (fake: FakeGitHub, action: 'labeled' | 'unlabeled', label: string, labels: string[]) =>
  onIssue(ctxFor(fake, 'issues', dashboardLabelEvent(action, label, 'me', labels), { config, secrets: { jevApiKey: 'jev-key' }, askJev: fakeJev(0.01).fn }));

test('委任と auto mode が両方有効な間に委任のラベルを外すと、auto mode で乗る PR は auto-merge が付いたまま、delegated-merge-end の後に auto-mode-merge を書き、human-review は出さない', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [delegateAutoAcceptance(91), delegateArmed(92, sha(5), since)] },
    dashboardLabels: [AUTO],
    dashboardEvents: [autoOn(hoursAgo(5)), delegateOn(since), delegateOff()],
  };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'unlabeled', DELEGATE, [AUTO]);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), [], 'auto-merge は外さない');
  assert.ok(w.prs[0]!.auto_merge, 'auto-merge が付いたまま');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('delegated-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('auto-mode-merge'), kinds.join(','));
  assert.ok(kinds.indexOf('delegated-merge-end') < kinds.lastIndexOf('auto-mode-merge'), `delegated-merge-end の後に auto-mode-merge: ${kinds.join(',')}`);
  assert.ok(!kinds.includes('human-review'), kinds.join(','));
  assert.equal(checks(fake, CHECKS.mergeRoute, sha(5)).at(-1)?.conclusion, 'success');
});

test('auto mode と bypass が両方有効な間に auto mode のラベルを外すと、bypass で乗る PR は auto-merge が付いたまま、auto-mode-merge-end の後に bypass-merge を書き、human-review は出さない', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [autoBypassAcceptance(91), autoArmed(92, sha(5), since)] },
    dashboardLabels: [BYPASS],
    dashboardEvents: [bypassOn(hoursAgo(6)), autoOn(since), autoOff()],
  };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'unlabeled', AUTO, [BYPASS]);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), [], 'auto-merge は外さない');
  assert.ok(w.prs[0]!.auto_merge, 'auto-merge が付いたまま');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('auto-mode-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('bypass-merge'), kinds.join(','));
  assert.ok(kinds.indexOf('auto-mode-merge-end') < kinds.lastIndexOf('bypass-merge'), `auto-mode-merge-end の後に bypass-merge: ${kinds.join(',')}`);
  assert.ok(!kinds.includes('human-review'), kinds.join(','));
  assert.equal(checks(fake, CHECKS.mergeRoute, sha(5)).at(-1)?.conclusion, 'success');
});

test('auto mode と bypass が両方有効な間に bypass のラベルを外すと、auto mode で乗る PR は auto-merge が付いたまま、bypass-merge-end の後に auto-mode-merge を書き、human-review は出さない', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [autoBypassAcceptance(91), bypassArmed(92, sha(5), hoursAgo(6))] },
    dashboardLabels: [AUTO],
    dashboardEvents: [bypassOn(hoursAgo(6)), autoOn(minutesAgo(10)), bypassOff()],
  };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'unlabeled', BYPASS, [AUTO]);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), [], 'auto-merge は外さない');
  assert.ok(w.prs[0]!.auto_merge, 'auto-merge が付いたまま');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('bypass-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('auto-mode-merge'), kinds.join(','));
  assert.ok(kinds.indexOf('bypass-merge-end') < kinds.lastIndexOf('auto-mode-merge'), `bypass-merge-end の後に auto-mode-merge: ${kinds.join(',')}`);
  assert.ok(!kinds.includes('human-review'), kinds.join(','));
  assert.equal(checks(fake, CHECKS.mergeRoute, sha(5)).at(-1)?.conclusion, 'success');
});
