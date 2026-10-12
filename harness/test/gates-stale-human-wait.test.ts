// Issue #804：定期実行（onSchedule）が、auto mode でも回らない人の判断待ち（Jev の保留の計画・PR、auto mode が無効なときの plan-review・Human Merge 待ち）のうち
// hq.humanWaitMinutes を超えたものをダッシュボードの節「時間を超えた人の判断待ち」に出し、知らせのコメント（kind=human-wait-digest）を 24 時間に1回だけ出すこと。
// 守り：auto mode の判定（agent:plan-review の付け外し・auto-merge の付け外し）は変わらない（節と知らせが加わるだけ）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig } from '../lib/auto-mode.ts';
import { renderBlock } from '../lib/blocks.ts';
import { LABELS, reasonMark, type HarnessConfig } from '../lib/config.ts';
import { humanWaitMinutes } from '../lib/fleet.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { onSchedule } from '../gates/stale.ts';
import { createHash } from 'node:crypto';
import { APP, CRITIQUE, claimComment, config as base, critiqueClaim, ctxFor, delegateWorldFake, pr, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment } from './support/stack-fixtures.ts';

/** Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の危険の問いは jev.mode と独立） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };
const AUTO = autoModeConfig(config).label;
const LIMIT = humanWaitMinutes(config);
const KIND = 'human-wait-digest';
const GUARDED = 'harness/lib/epic.ts';
const CONFIG_FILE = 'harness.config.json';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const OVER = minutesAgo(LIMIT + 60);
const autoOn = () => ({ event: 'labeled', created_at: minutesAgo(LIMIT * 10), actor: { login: 'me' }, label: { name: AUTO } });
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 偽の Jev。危険の問いに answer で答え、問った回数を残す（0.5 で保留、0.01 で安全） */
function fakeJev(answer: number) {
  const asked: unknown[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request);
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
  };
  return { asked, fn };
}

/** 偽の GitHub。issueFacts が読む blockedBy（GraphQL）にも空で答える（delegateWorldFake の GraphQL はそれを知らないため） */
function worldFake(w: DelegateWorld): FakeGitHub {
  const fake = delegateWorldFake(w);
  const request = fake.request.bind(fake);
  fake.request = async (method, path, opts = {}) => {
    if (path === '/graphql' && String((opts.body as { query?: unknown } | undefined)?.query).includes('blockedBy')) {
      fake.calls.push({ method, path, body: opts.body });
      return { data: { repository: { issue: { blockedBy: { nodes: [] } } } } };
    }
    return request(method, path, opts);
  };
  return fake;
}

async function schedule(fake: FakeGitHub, jev = fakeJev(0.5)): Promise<void> {
  await onSchedule(ctxFor(fake, 'schedule', {}, { config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }), new Date());
}

/**
 * ガードレールに触れて App のゲートで止まった計画（agent:plan-review、止まったのは since）を世界に足す。
 * auto mode が有効なら Jev の危険の問いに回る（安全なら通り、保留なら止まったまま）
 */
function addStoppedPlan(w: DelegateWorld, n: number, since = OVER, extra: unknown[] = []): void {
  const plan: Plan = { version: 1, issue: n, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [GUARDED], critique: CRITIQUE };
  const comment = { id: n * 100, created_at: since, updated_at: '', html_url: `p${n}`, author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: `計画です。\n\n${renderBlock('agent-plan', plan)}` };
  const record = { version: 1, planCommentId: comment.id, planBodySha256: sha256(comment.body), pass: false, reasons: ['止めた理由'], planReviewOrigin: 'gate', plan };
  const gate = { ...appRecordComment(n * 100 + 1, 'plan-gate', `${reasonMark('high-risk')}\n計画ゲートで停止しました。`, record), created_at: since };
  (w.issues ??= {})[n] = [LABELS.ready, LABELS.planReview];
  (w.comments ??= {})[n] = [critiqueClaim(), comment, gate, ...extra];
  (w.issueEvents ??= {})[n] = [{ event: 'labeled', created_at: since, actor: { login: APP }, label: { name: LABELS.planReview } }];
}

const agentPr = (n: number) =>
  pr({ number: n, node_id: `PR_${n}`, draft: false, title: `feat: PR ${n}`, html_url: `https://x/${n}`, head: { ref: `claude/issue-${n}`, sha: String(n % 10).repeat(40), repo: { full_name: 'o/r' } } });

/** 判定に合格し、自動 Merge の対象でない（Human Merge 待ち）PR の受け付けの記録（created_at が待ちの始まり） */
const humanMergeAcceptance = (id: number, since: string, autoMode?: unknown) => ({
  ...acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${CONFIG_FILE}`], ...(autoMode ? { autoMode } : {}) }),
  created_at: since,
});
const JEV_DANGER = { status: 'ok', detail: 'jev', yes: 0.5, questionSet: AUTO_MODE_JEV_QUESTION_SET };
const AUTO_HOLD = { eligible: false, reasons: ['Jev：危険の確率 50%（安全側の下限 90%）（危険。保留）'], skipped: [`ガードレールに触れます: ${CONFIG_FILE}`], jev: JEV_DANGER };

function dashboardBody(fake: FakeGitHub): string {
  const patch = fake.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1')).at(-1);
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  return String(patch.body.body);
}

/** 節「時間を超えた人の判断待ち…」（見出しから次の見出しまで） */
function digestSection(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.startsWith('### ') && l.includes('時間を超えた人の判断待ち'));
  assert.ok(start >= 0, `「時間を超えた人の判断待ち」の節がありません\n${body}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('### '));
  return lines.slice(start, end >= 0 ? end : undefined).join('\n');
}

/** ダッシュボード（#1）に投稿した知らせのコメントの本文 */
function digests(fake: FakeGitHub): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/issues/1/comments') && String(c.body?.body).includes(`kind=${KIND}`))
    .map((c) => String(c.body.body));
}

const rowOf = (section: string, n: number): string | undefined => section.split('\n').find((l) => new RegExp(`#${n}\\b`).test(l));
const mutations = (fake: FakeGitHub, name: string): number => fake.calls.filter((c) => c.path === '/graphql' && String(c.body?.query).includes(`{${name}(`)).length;
const labelDeletes = (fake: FakeGitHub, n: number): string[] => fake.calls.filter((c) => c.method === 'DELETE' && c.path.includes(`/issues/${n}/labels/`)).map((c) => c.path);

// ---- AC 1：auto mode でも回らない人の判断待ち ----

test('auto mode が有効でも、Jev が保留にした計画と PR は回らず（plan-review は外れず auto-merge も付かない）、時間を超えれば節に出て知らせのコメント（kind=human-wait-digest）が1回出る', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5)],
    comments: { 5: [humanMergeAcceptance(91, OVER, AUTO_HOLD)] },
    dashboardLabels: [AUTO],
    dashboardEvents: [autoOn()],
  };
  addStoppedPlan(w, 61);
  const fake = worldFake(w);
  const jev = fakeJev(0.5);
  await schedule(fake, jev);

  // 守り：auto mode の判定はそのまま（問いはするが保留。ラベルも auto-merge も変えない）
  assert.ok(jev.asked.length > 0, 'Jev に問っていません');
  assert.ok(w.issues![61]!.includes(LABELS.planReview), `#61: plan-review が外れた: ${w.issues![61]!.join(',')}`);
  assert.ok(!w.issues![61]!.includes(LABELS.planOk), '#61: 保留の計画を通した');
  assert.deepEqual(labelDeletes(fake, 61), []);
  assert.equal(mutations(fake, 'enablePullRequestAutoMerge'), 0, '保留の PR に auto-merge を付けた');
  assert.equal(w.prs[0]!.auto_merge, null);

  const section = digestSection(dashboardBody(fake));
  const planRow = rowOf(section, 61);
  const prRow = rowOf(section, 5);
  assert.ok(planRow, `#61 が節に無い\n${section}`);
  assert.ok(prRow, `#5 が節に無い\n${section}`);
  assert.ok(prRow.includes('危険の確率 50%'), `PR の行に保留の理由が無い: ${prRow}`);
  assert.ok(!planRow.includes('auto mode が無効'), planRow);

  const posted = digests(fake);
  assert.equal(posted.length, 1, `知らせのコメントの数: ${posted.length}`);
  assert.ok(/#61\b/.test(posted[0]!) && /#5\b/.test(posted[0]!), posted[0]);
});

test('auto mode が有効で Jev が安全なら、計画は今までどおり通り（agent:plan-ok）、節にも知らせにも出ない（0 件なら知らせのコメントは出さない）', async () => {
  const w: DelegateWorld = { prs: [], dashboardLabels: [AUTO], dashboardEvents: [autoOn()] };
  addStoppedPlan(w, 61);
  const fake = worldFake(w);
  await schedule(fake, fakeJev(0.01));
  assert.ok(w.issues![61]!.includes(LABELS.planOk), `#61: ${w.issues![61]!.join(',')}`);
  assert.equal(rowOf(digestSection(dashboardBody(fake)), 61), undefined);
  assert.deepEqual(digests(fake), []);
});

// ---- AC 2：auto mode が無効なら回さず、知らせは1日1回 ----

test('auto mode が無効なら、時間を超えた計画と Human Merge 待ちの PR は回らず（Jev に問わない・ラベルも auto-merge も変えない）、「auto mode が無効」の理由つきで節に出る。時間を超えていないものは出ない', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5), agentPr(6)],
    comments: { 5: [humanMergeAcceptance(91, OVER)], 6: [humanMergeAcceptance(92, minutesAgo(10))] },
    dashboardLabels: [],
  };
  addStoppedPlan(w, 61);
  addStoppedPlan(w, 62, minutesAgo(10));
  const fake = worldFake(w);
  const jev = fakeJev(0.01);
  await schedule(fake, jev);

  assert.equal(jev.asked.length, 0, 'auto mode が無効なのに Jev に問った');
  for (const n of [61, 62]) {
    assert.ok(w.issues![n]!.includes(LABELS.planReview) && !w.issues![n]!.includes(LABELS.planOk), `#${n}: ${w.issues![n]!.join(',')}`);
    assert.deepEqual(labelDeletes(fake, n), []);
  }
  assert.equal(mutations(fake, 'enablePullRequestAutoMerge'), 0);

  const section = digestSection(dashboardBody(fake));
  for (const n of [61, 5]) {
    const row = rowOf(section, n);
    assert.ok(row, `#${n} が節に無い\n${section}`);
    assert.ok(row.includes('auto mode が無効'), row);
  }
  for (const n of [62, 6]) assert.equal(rowOf(section, n), undefined, `時間を超えていない #${n} が出た\n${section}`);
  assert.equal(digests(fake).length, 1);
});

test('知らせのコメントは 24 時間に1回：直近 24 時間に App の human-wait-digest の記録があれば出さない（節は書く）。24 時間より前なら出す。続けて2回走らせても1回だけ', async () => {
  const cases: [string, string | null, number][] = [
    ['記録なし', null, 1],
    ['2 時間前の記録', minutesAgo(120), 0],
    ['25 時間前の記録', minutesAgo(25 * 60), 1],
  ];
  for (const [name, recordAt, expected] of cases) {
    const w: DelegateWorld = { prs: [], dashboardLabels: [] };
    addStoppedPlan(w, 61);
    if (recordAt) (w.comments ??= {})[1] = [{ ...appRecordComment(500, KIND, '時間を超えた人の判断待ちがあります。', { version: 1 }), created_at: recordAt }];
    const fake = worldFake(w);
    await schedule(fake);
    assert.ok(rowOf(digestSection(dashboardBody(fake)), 61), `${name}: 節に #61 が無い`);
    assert.equal(digests(fake).length, expected, name);
    // 続けてもう一度走らせても、知らせは増えない
    await schedule(fake);
    assert.ok(rowOf(digestSection(dashboardBody(fake)), 61), `${name}（2回目）: 節に #61 が無い`);
    assert.equal(digests(fake).length, expected, `${name}（2回目）`);
  }
});

test('App 以外が書いた human-wait-digest の印のコメントは記録に数えず、知らせを出す', async () => {
  const w: DelegateWorld = { prs: [], dashboardLabels: [] };
  addStoppedPlan(w, 61);
  const forged = { ...appRecordComment(500, KIND, '偽の記録', { version: 1 }), created_at: minutesAgo(60), user: { login: 'someone', type: 'User' }, author_association: 'NONE' };
  w.comments![1] = [forged];
  const fake = worldFake(w);
  await schedule(fake);
  assert.equal(digests(fake).length, 1);
});

// ---- 人かセッションが進めると決めた後の plan-review ----

test('agent:plan-review が付いていても、着手宣言の段階が implement の計画は節に出ない（解除済みの implement の宣言なら出る）', async () => {
  const w: DelegateWorld = { prs: [], dashboardLabels: [] };
  addStoppedPlan(w, 61, OVER, [claimComment({ stage: 'implement', id: 6199 })]);
  addStoppedPlan(w, 62, OVER, [claimComment({ stage: 'implement', id: 6298, at: minutesAgo(30) }), claimComment({ stage: 'implement', released: true, id: 6299 })]);
  const fake = worldFake(w);
  await schedule(fake);
  const section = digestSection(dashboardBody(fake));
  assert.equal(rowOf(section, 61), undefined, `#61 が出た\n${section}`);
  assert.ok(rowOf(section, 62), `#62 が節に無い\n${section}`);
});
