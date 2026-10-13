// auto mode が有効で Jev の危険の判定で保留の PR は、委任承認（計画＋Merge）で乗れても自動経路に乗せない（auto-merge を付けない・外す、agent/tests は Human Merge）ことを、
// 偽の GitHub と偽の Jev で確かめる（Issue #942）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig } from '../lib/auto-mode.ts';
import { renderBlock } from '../lib/blocks.ts';
import { CHECKS, delegateConfig, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { AUTO_MODE_HOLD_REASON_PREFIX } from '../lib/merge-route.ts';
import { patchId } from '../lib/patch-id.ts';
import { onComment } from '../gates/on-comment.ts';
import { onIssue } from '../gates/on-issue.ts';
import { DIFF, acceptanceFake, config as base, ctxFor, delegateWorldFake, pr, verdict, verdictEvent, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, dashboardLabelEvent, postedBodies, postedRecord } from './support/stack-fixtures.ts';

/** 判定の受け付けで Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の危険の問いは jev.mode と独立） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };

const AUTO = autoModeConfig(config).label;
const DELEGATE = delegateConfig(config).mergeLabel;
/** ガードレールに当たるが delegateMergeExclude には当たらない（委任で乗る） */
const GUARDED = 'harness/lib/epic.ts';
const SKIP_DIFF = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n";

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const ev = (name: string, at: string) => ({ event: 'labeled', created_at: at, actor: { login: 'me' }, label: { name } });
const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

/** 計画ゲートを通った記録（files 指定） */
const planGate = (files: string[]) => appRecordComment(90, 'plan-gate', 'ok', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } });

/** 偽の Jev。危険の問い（danger）にだけ answer で答える */
const fakeJev = (answer: number): typeof askJev => async (_key, request) => {
  if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
  return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
};

/** 判定の受け付け（onComment）用。変更ファイルと計画の files は同じ（範囲内） */
function verdictFake(o: { dashboardLabels: string[]; events: unknown[]; files: string[]; diff?: string }): FakeGitHub {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: o.dashboardLabels, dashboardEvents: o.events, prComments: [] })
    .on('GET', /\/issues\/3\/comments/, () => [planGate(o.files)])
    .on('GET', /\/pulls\/5\/files/, () => o.files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/5\/events/, () => []);
  if (o.diff) fake.on('GET', /\/compare\//, (_m, _b, opts) => (opts.raw ? o.diff : { behind_by: 0 }));
  return fake;
}

/** 判定コメントを受け付ける。Jev は危険（0.5。保留）と答える */
async function acceptHeld(fake: FakeGitHub): Promise<void> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', critical())), { config, secrets: { jevApiKey: 'jev-key' }, askJev: fakeJev(0.5) }));
}

/** 書いたチェック（名前指定） */
function checks(fake: FakeGitHub, name: string): { conclusion: string; title: string }[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === name)
    .map((c) => ({ conclusion: c.body.conclusion, title: String(c.body.output?.title ?? '') }));
}

/** GraphQL の mutation（名前指定）の対象の PR の node_id を呼んだ順に */
function mutationIds(fake: FakeGitHub, name: string): string[] {
  return fake.calls.filter((c) => c.path === '/graphql' && String(c.body?.query).includes(`{${name}(`)).map((c) => String(c.body.variables?.id));
}

/** PR（番号指定）への App のコメントの kind を書いた順に */
function kindsOn(fake: FakeGitHub, issue: number): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${issue}/comments`))
    .map((c) => String(c.body.body).match(/kind=([\w-]+)/)?.[1] ?? '?');
}

test('(a) auto mode と委任承認（計画＋Merge）が有効でも、Jev の危険の判定で保留の PR には auto-merge を付けず、delegated-merge を書かず、human-review に保留の1行を出す', async () => {
  const fake = verdictFake({ dashboardLabels: [DELEGATE, AUTO], events: [ev(AUTO, minutesAgo(300)), ev(DELEGATE, minutesAgo(10))], files: [GUARDED] });
  await acceptHeld(fake);
  const w = fake.writes();
  assert.equal(postedRecord(fake, 'acceptance').delegate?.eligible, true, '前提：委任なら乗れる受け付け');
  assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:delegated-merge'), w.join('\n'));
  assert.ok(!w.includes('comment:auto-mode-merge'), w.join('\n'));
  assert.ok(w.includes('comment:human-review'), w.join('\n'));
  const body = postedBodies(fake, 'human-review').at(-1) ?? '';
  assert.ok(body.includes(AUTO_MODE_HOLD_REASON_PREFIX), body);
  assert.notEqual(checks(fake, CHECKS.mergeRoute).at(-1)?.title, '委任承認（計画＋Merge）の条件を満たしています');
});

test('(b) 委任承認で auto-merge を付けた後に auto mode を付けると、保留の PR は auto-merge を外し、delegated-merge-end（ineligible）と human-review を出す', async () => {
  const head = '5'.repeat(40);
  const since = minutesAgo(30);
  const heldAcceptance = acceptanceComment(91, {
    riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${GUARDED}`],
    delegate: { eligible: true, reasons: [], skipped: [`ガードレールに触れます: ${GUARDED}`, 'Risk が critical です'], scopeOk: true, outside: [], exclude: [] },
    autoMode: {
      eligible: false, hold: true, reasons: [`${AUTO_MODE_HOLD_REASON_PREFIX}: Jev：危険の確率 50%（安全側の下限 90%）（危険。保留）`], skipped: [],
      jev: { status: 'ok', detail: 'jev', yes: 0.5, questionSet: AUTO_MODE_JEV_QUESTION_SET },
    },
  });
  const delegateArmed = appRecordComment(92, 'delegated-merge', '委任承認（計画＋Merge）で自動経路に乗せました。', { version: 1, headSha: head, patchId: patchId(DIFF), since, until: null, by: 'me', skipped: [] });
  const w: DelegateWorld = {
    prs: [pr({ number: 5, node_id: 'PR_5', draft: false, head: { ref: 'claude/issue-5', sha: head, repo: { full_name: 'o/r' } }, auto_merge: { enabled: true } })],
    comments: { 5: [heldAcceptance, delegateArmed] },
    files: { 5: [GUARDED] },
    dashboardLabels: [DELEGATE, AUTO],
    dashboardEvents: [ev(DELEGATE, since), ev(AUTO, minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardLabelEvent('labeled', AUTO, 'me', [DELEGATE, AUTO]), { config, secrets: { jevApiKey: 'jev-key' }, askJev: fakeJev(0.5) }));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(!w.prs[0]!.auto_merge, 'auto-merge が外れている');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('delegated-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('human-review'), kinds.join(','));
  assert.equal(postedRecord(fake, 'delegated-merge-end').reason, 'ineligible');
  assert.ok((postedBodies(fake, 'human-review').at(-1) ?? '').includes(AUTO_MODE_HOLD_REASON_PREFIX), postedBodies(fake, 'human-review').at(-1));
});

test('(c) auto mode と委任承認が有効で保留の PR にテストを弱める変更があると、agent/tests は neutral（Human Merge）', async () => {
  const fake = verdictFake({ dashboardLabels: [DELEGATE, AUTO], events: [ev(AUTO, minutesAgo(300)), ev(DELEGATE, minutesAgo(10))], files: [GUARDED, 'a.test.ts'], diff: SKIP_DIFF });
  await acceptHeld(fake);
  const tests = checks(fake, CHECKS.tests);
  assert.ok(tests.length > 0, 'agent/tests を書いていません');
  assert.equal(tests.at(-1)?.conclusion, 'neutral', JSON.stringify(tests));
});
