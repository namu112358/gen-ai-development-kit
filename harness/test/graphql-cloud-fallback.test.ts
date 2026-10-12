// Issue #709：クラウドのセッション（CLAUDE_CODE_REMOTE=true）で GitHub が GraphQL に 403 を返しても、fleet-status の表・step の次の段階・judge-input の材料を REST だけで読む。
// Closes する PR は既定ブランチ宛て・同じリポジトリのものだけ、blocker は開いたものだけを数える。CLAUDE_CODE_REMOTE が無ければ restOnly は偽（GraphQL の経路は既存のテストが確かめる）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { LABELS } from '../lib/config.ts';
import { type FleetIssue, fleetStatus, renderFleetStatus, selectFleet } from '../lib/fleet.ts';
import { collectFleetIssues, type FleetIssueItem, prefetchedGitHub, readFleetSnapshot, readStepSnapshot } from '../lib/fleet-reads.ts';
import { GitHub, graphqlUnavailable, HttpError } from '../lib/github.ts';
import { pastPrsFor } from '../lib/past-pr-reads.ts';
import { renderJudgeInput } from '../lib/session-inputs.ts';
import { linkedIssues } from '../lib/state.ts';
import { decideStep } from '../lib/step.ts';
import { newGitHub } from '../scripts/agent/cli.ts';
import { config, type FakeGitHub } from './support/gate-fixtures.ts';
import { APP_SLUG, dashboardFake, REPO, restPr, type WComment, type World } from './support/dashboard-fixtures.ts';
import { stepInput } from './support/step-fixtures.ts';

const APP_ACTOR = { login: APP_SLUG, bot: true };
const T0 = '2026-09-26T00:00:00Z';
const MERGED_AT = '2026-09-20T00:00:00Z';
const PAST_SHA = 'c'.repeat(40);

const planC = (id: number): WComment => ({ id, body: [claudeMark(), '計画です。', '', renderBlock('agent-plan', { version: 1 })].join('\n') });
const planGateC = (id: number, planCommentId: number): WComment => ({
  id, author: APP_ACTOR, association: 'NONE',
  body: [appMark('plan-gate'), 'App です。', renderBlock('agent-app', { version: 1, planCommentId, pass: true, reasons: [], plan: { files: ['docs/**'], critique: { verdict: 'go', rounds: 1 } } })].join('\n'),
});
const planOk = (number: number, blockedBy: { number: number; state: string }[] = []) => ({
  number, title: `feat: ${number}`, labels: [LABELS.planOk], comments: [planC(number * 10), planGateC(number * 10 + 1, number * 10)],
  events: [{ event: 'labeled' as const, label: LABELS.planOk, created_at: '2026-09-26T01:00:00Z', actor: APP_ACTOR }], blockedBy,
});

/**
 * #20：開いた PR #21（main 宛て、Closes #20）と、既定ブランチ宛てでない PR #22（Closes #20。数えない）。
 * #30：Merge 済みの PR #31（timeline の cross-referenced）と、別のリポジトリの同じ形の cross-referenced（#32。数えない）。
 * #40：開いた blocker #41 と閉じた blocker #42（#42 は数えない）。#31 は PR #21 の変更ファイルを触った過去の PR
 */
const world: World = {
  issues: [
    { ...planOk(20), body: 'twenty の本文' },
    { number: 30, title: 'feat: 30' },
    planOk(40, [{ number: 41, state: 'open' }, { number: 42, state: 'closed' }]),
  ],
  prs: [
    { number: 21, body: 'Closes #20', headRef: 'claude/issue-20-x', headSha: 'a'.repeat(40) },
    { number: 22, body: 'Closes #20', headRef: 'claude/issue-20-y', headSha: 'd'.repeat(40), baseRef: 'feature/x' },
    { number: 31, state: 'closed', body: 'Closes #30', headRef: 'claude/issue-30-x', headSha: 'e'.repeat(40), comments: [{ id: 3100, body: '過去の人の指摘です' }] },
  ],
};

const firstPage = (path: string, list: unknown[]) => (Number(new URL(path, 'https://x.invalid').searchParams.get('page') ?? 1) > 1 ? [] : list);
const crossRef = (number: number, repo: string) => ({
  event: 'cross-referenced', created_at: T0,
  source: { type: 'issue', issue: { number, body: '', repository: { full_name: repo }, pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}`, merged_at: MERGED_AT } } },
});

/** dashboardFake に REST の道を足し、GraphQL には 403 を返す偽の GitHub */
function cloudFake(): FakeGitHub {
  return dashboardFake(world)
    .on('POST', /^\/graphql$/, () => { throw new HttpError(403, 'Resource not accessible by integration'); })
    .on('GET', /^\/repos\/o\/r\/pulls\/(\d+)$/, (m) => {
      const p = world.prs.find((x) => x.number === Number(m[1]));
      if (!p) throw new HttpError(404, `pulls/${m[1]}`);
      const r = restPr(p, true);
      return { ...r, merged_at: p.state === 'closed' ? MERGED_AT : null, base: { ...r.base, repo: { full_name: REPO, default_branch: config.defaultBranch } } };
    })
    .on('GET', /^\/repos\/o\/r\/pulls\/(\d+)\/comments/, () => [])
    .on('GET', /^\/repos\/o\/r\/pulls\/21\/files/, (m) => firstPage(m.input!, [{ filename: 'docs/a.md' }]))
    .on('GET', /^\/repos\/o\/r\/commits\?/, (m) => (decodeURIComponent(m.input!).includes('docs/a.md') ? [{ sha: PAST_SHA }] : []))
    .on('GET', /^\/repos\/o\/r\/commits\/(\w+)\/pulls/, (m) => (m[1] === PAST_SHA
      ? [{ number: 31, title: 'past 31', state: 'closed', merged_at: MERGED_AT, base: { ref: config.defaultBranch } }]
      : []))
    .on('GET', /^\/repos\/o\/r\/issues\/30\/timeline/, (m) => firstPage(m.input!, [{ event: 'mentioned', created_at: T0 }, crossRef(31, REPO), crossRef(32, 'x/other')]))
    .on('GET', /^\/repos\/o\/r\/issues\/(\d+)\/dependencies\/blocked_by/, (m) =>
      firstPage(m.input!, (world.issues.find((i) => i.number === Number(m[1]))?.blockedBy ?? []).map((b) => ({ number: b.number, state: b.state, title: `t${b.number}` }))));
}

function cloud(): { gh: GitHub; fake: FakeGitHub } {
  const fake = cloudFake();
  const gh = new GitHub(fake, REPO);
  gh.restOnly = graphqlUnavailable({ CLAUDE_CODE_REMOTE: 'true' });
  return { gh, fake };
}
const graphqlCalls = (fake: FakeGitHub) => fake.calls.filter((c) => c.path === '/graphql').length;
const item = (gh: GitHub, n: number) => gh.get<FleetIssueItem>(`/issues/${n}`);

test('AC1：GraphQL が 403 でも fleet-status が表を出し（既定ブランチ宛て・同じリポジトリの Closes と開いた blocker だけ）、step が次の段階を返す', async () => {
  const { gh, fake } = cloud();
  const items = await Promise.all([20, 30, 40].map((n) => item(gh, n)));
  const snap = await readFleetSnapshot(gh, config, [20, 30, 40]);
  const { issues } = await collectFleetIssues(prefetchedGitHub(gh, config, snap), config, items, snap);
  const of = (n: number) => issues.find((i) => i.facts.number === n)!;
  assert.deepEqual(of(20).prs.map((p) => [p.number, p.merged]), [[21, false]], '既定ブランチ宛てでない #22 は出ない');
  assert.deepEqual(of(30).prs.map((p) => [p.number, p.merged]), [[31, true]], '別のリポジトリの #32 は出ない');
  assert.deepEqual(of(40).facts.openBlockers, [41], '閉じた #42 は出ない');

  const facts = { issues, prConflicts: [] };
  const rows = fleetStatus(facts);
  const text = renderFleetStatus(rows, selectFleet(config, facts, rows, null, null, null), null);
  for (const n of [20, 30, 40]) assert.match(text, new RegExp(`#${n}\\b`));
  assert.equal(rows.find((r) => r.issue === 20)!.pr, 21);

  const stepSnap = await readStepSnapshot(gh, config, 20);
  const step = (await collectFleetIssues(prefetchedGitHub(gh, config, stepSnap), config, [await item(gh, 20)], stepSnap)).issues[0]! as FleetIssue;
  const d = decideStep(stepInput(step));
  assert.equal(d.result.kind, 'node');
  assert.equal(d.result.pr, 21);
  assert.equal(graphqlCalls(fake), 0, 'GraphQL に要求を送らない');
});

test('AC2：GraphQL が 403 でも judge-input の材料（Closes の Issue・過去の PR）を REST で読み、入力を書ける。既定ブランチ宛てでない PR の Closes は数えない', async () => {
  const { gh, fake } = cloud();
  const pr = await gh.get<{ number: number; body: string | null; base: { ref: string }; head: { sha: string } }>('/pulls/21');
  const linked = await linkedIssues(gh, config, pr);
  assert.deepEqual(linked, [20]);
  assert.deepEqual(await linkedIssues(gh, config, await gh.get('/pulls/22')), [], '既定ブランチ宛てでない PR');

  const pastPrs = await pastPrsFor(gh, config, 21);
  assert.deepEqual(pastPrs.prs.map((p) => p.number), [31]);
  const issues = [];
  for (const n of linked) {
    const i = await gh.get<{ title: string; body: string | null }>(`/issues/${n}`);
    issues.push({ number: n, title: i.title, body: i.body, comments: await gh.listComments(n) });
  }
  const text = renderJudgeInput(config, { pr: { number: 21, headSha: pr.head.sha, body: pr.body }, issues, prComments: [], checkRuns: [], pastPrs });
  assert.match(text, /^PR #21 issues=#20$/m);
  assert.match(text, /twenty の本文/);
  assert.match(text, /過去の人の指摘です/);
  assert.equal(graphqlCalls(fake), 0, 'GraphQL に要求を送らない');
});

test('AC3：CLAUDE_CODE_REMOTE が true のときだけ REST だけで読む（無い・false なら今どおり GraphQL）', () => {
  for (const [env, want] of [[{ CLAUDE_CODE_REMOTE: 'true' }, true], [{}, false], [{ CLAUDE_CODE_REMOTE: 'false' }, false]] as const) {
    assert.equal(graphqlUnavailable(env), want, JSON.stringify(env));
  }
  const saved = { remote: process.env.CLAUDE_CODE_REMOTE, repo: process.env.GITHUB_REPOSITORY };
  try {
    process.env.GITHUB_REPOSITORY = REPO;
    process.env.CLAUDE_CODE_REMOTE = 'true';
    assert.equal(newGitHub(null).restOnly, true);
    delete process.env.CLAUDE_CODE_REMOTE;
    assert.equal(newGitHub(null).restOnly, false);
    assert.equal(new GitHub(dashboardFake(world), REPO).restOnly, false, 'new GitHub の既定は偽');
  } finally {
    if (saved.remote === undefined) delete process.env.CLAUDE_CODE_REMOTE; else process.env.CLAUDE_CODE_REMOTE = saved.remote;
    if (saved.repo === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = saved.repo;
  }
});
