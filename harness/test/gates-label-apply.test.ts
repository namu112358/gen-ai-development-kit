import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { TimelineEvent } from '../lib/state.ts';
import {
  appLabeledSet,
  decideJevLabels,
  JEV_PER_RUN,
  labelApply,
  onScheduleWithLabels,
  planLabelChanges,
  riskLabelChanges,
  type LabelTarget,
} from '../gates/label-apply.ts';
import { onIssue } from '../gates/on-issue.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { acceptanceFake, APP, config, ctxFor, FakeGitHub, pr } from './support/gate-fixtures.ts';

const NONE = new Set<string>();
const issueTarget = (title: string, labels: string[], patch: Partial<LabelTarget> = {}): LabelTarget => ({ kind: 'issue', title, labels, ...patch });
const labeledBy = (label: string, login: string, event = 'labeled'): TimelineEvent => ({ event, label: { name: label }, actor: { login } });

// --- 判断（純粋な関数） ---

test('type：タイトルから決まる type:* が無ければ足す（Issue・PR とも）', () => {
  assert.deepEqual(planLabelChanges(config, issueTarget('feat(x): a', ['agent:ready']), NONE).add, ['type:feat']);
  assert.deepEqual(planLabelChanges(config, { kind: 'pr', title: 'docs: a', labels: ['size:S'] }, NONE).add, ['type:docs']);
  assert.deepEqual(planLabelChanges(config, issueTarget('fix: a', ['type:fix']), NONE), { add: [], remove: [], kept: [], mismatches: [] }, '揃っていれば何もしない');
});

test('type：App が付けた食い違う type:* は付け替え、人が付けたもの（見分けられないものを含む）は外さず知らせる', () => {
  const byApp = planLabelChanges(config, issueTarget('feat: a', ['type:fix']), new Set(['type:fix']));
  assert.deepEqual(byApp.remove, ['type:fix']);
  assert.deepEqual(byApp.add, ['type:feat']);
  assert.deepEqual(byApp.mismatches, []);

  const byHuman = planLabelChanges(config, issueTarget('feat: a', ['type:fix']), NONE);
  assert.deepEqual(byHuman.remove, []);
  assert.deepEqual(byHuman.add, [], '人の type を残したまま2つ目の type は足さない');
  assert.deepEqual(byHuman.kept, ['type:fix']);
  assert.match(byHuman.mismatches[0]!, /タイトルの type は `feat`.*`type:fix`/);
});

test('type：タイトルの形式が違う Issue・PR には type を付けず、外しもしない', () => {
  assert.deepEqual(planLabelChanges(config, issueTarget('用語集に追加', []), NONE).add, []);
  assert.deepEqual(planLabelChanges(config, { kind: 'pr', title: 'Update README', labels: ['type:docs'] }, new Set(['type:docs'])), { add: [], remove: [], kept: [], mismatches: [] });
});

test('epic：子を持つ Issue に epic を足し、App が付けた type:* を外す。人が付けたものは知らせる', () => {
  const byApp = planLabelChanges(config, issueTarget('feat: 大きな機能', ['type:feat', 'priority:high'], { subIssues: 2 }), new Set(['type:feat']));
  assert.deepEqual(byApp.add, ['epic']);
  assert.deepEqual(byApp.remove, ['type:feat']);

  const byHuman = planLabelChanges(config, issueTarget('feat: 大きな機能', ['epic', 'type:feat'], { subIssues: 2 }), NONE);
  assert.deepEqual(byHuman.add, []);
  assert.deepEqual(byHuman.remove, []);
  assert.match(byHuman.mismatches[0]!, /Epic.*`type:feat`/);

  assert.deepEqual(planLabelChanges(config, issueTarget('feat: 子の無い Issue', []), NONE).add, ['type:feat'], '子が無ければ epic は付けない');
});

test('area：計画ゲートを通った計画の files から、area:* が無いときだけ足す', () => {
  assert.deepEqual(planLabelChanges(config, issueTarget('docs: a', ['type:docs'], { plannedFiles: ['docs/a.md', 'harness/lib/x.ts'] }), NONE).add, ['area:docs', 'area:harness']);
  assert.deepEqual(planLabelChanges(config, issueTarget('docs: a', ['type:docs', 'area:docs'], { plannedFiles: ['harness/lib/x.ts'] }), NONE).add, [], '人が付けた area があれば足さない');
  assert.deepEqual(planLabelChanges(config, issueTarget('docs: a', ['type:docs'], { plannedFiles: null }), NONE).add, [], '計画が無ければ App は area を決めない');
});

test('App が付けたかは、そのラベルを最後に付けた labeled の actor で見分ける', () => {
  const events = [
    labeledBy('type:fix', APP),
    labeledBy('type:docs', APP), labeledBy('type:docs', APP, 'unlabeled'), labeledBy('type:docs', 'me'),
    labeledBy('type:chore', 'me'),
  ];
  assert.deepEqual([...appLabeledSet(config, events, ['type:fix', 'type:docs', 'type:chore', 'type:test'])], ['type:fix']);
});

test('PR の risk:*：受け付けた判定の段階1つにそろえる', () => {
  assert.deepEqual(riskLabelChanges([], 'low'), { add: ['risk:low'], remove: [] });
  assert.deepEqual(riskLabelChanges(['risk:low', 'risk:critical', 'type:feat'], 'medium'), { add: ['risk:medium'], remove: ['risk:low', 'risk:critical'] });
  assert.deepEqual(riskLabelChanges(['risk:high'], 'high'), { add: [], remove: [] });
});

const summary = (priority: [string, number], area: [string, number]) => ({ priority, area });

test('Jev：確率が下限以上なら付け、未満・下限の設定なし・当たるラベルが無いときは付けない', () => {
  const both = { priority: true, area: true };
  const ok = decideJevLabels(config, summary(['high', 0.9], ['docs', 0.85]), both);
  assert.deepEqual(ok.map((r) => [r.label, r.applied]), [['priority:high', true], ['area:docs', true]]);

  const low = decideJevLabels(config, summary(['high', 0.5], ['docs', 0.95]), both);
  assert.deepEqual(low.map((r) => [r.label, r.applied]), [['priority:high', false], ['area:docs', true]]);
  assert.match(low[0]!.reason!, /下限 80% 未満/);

  const noThreshold: HarnessConfig = { ...config, jev: { ...config.jev, thresholds: { lowProbability: 0.9, noulSafe: 0.9 } } };
  assert.ok(decideJevLabels(noThreshold, summary(['high', 1], ['docs', 1]), both).every((r) => !r.applied));

  const other = decideJevLabels(config, summary(['high', 0.9], ['other', 0.99]), { priority: false, area: true });
  assert.deepEqual(other.map((r) => [r.label, r.applied]), [[null, false]]);
});

// --- ゲート（偽の GitHub と偽の Jev） ---

const FORM_BODY = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\nx`).join('\n\n');
const labels = (...names: string[]) => names.map((name) => ({ name }));
const issue = (number: number, title: string, names: string[], patch: Record<string, unknown> = {}) => ({
  number, title, body: FORM_BODY, html_url: `https://x/${number}`, updated_at: '2026-09-27T00:00:00Z', labels: labels(...names), user: { login: 'me' }, ...patch,
});
const appRecord = (id: number, kind: string, value: unknown) => ({
  id, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\nx\n${renderBlock('agent-app', value)}`,
});

interface World {
  issues?: unknown[];
  prs?: unknown[];
  events?: Record<number, TimelineEvent[]>;
  comments?: Record<number, unknown[]>;
}

function worldFake(w: World): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&per_page/, () => w.issues ?? [])
    .on('GET', /\/pulls\?state=open/, () => w.prs ?? [])
    .on('GET', /\/issues\/(\d+)\/events/, (m) => w.events?.[Number(m[1])] ?? [])
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => w.comments?.[Number(m[1])] ?? [])
    .on('POST', /\/issues\/(\d+)\/labels$/, (m, body) => {
      // 付けたラベルを一覧に反映する（後で読むダッシュボードが付与の後の状態を見る）
      const item = (w.issues as { number: number; labels: { name: string }[] }[] | undefined)?.find((i) => i.number === Number(m[1]));
      item?.labels.push(...(body.labels as string[]).map((name) => ({ name })));
      return [];
    })
    .on('DELETE', /\/labels\//, () => null)
    .on('POST', /\/issues\/\d+\/comments$/, () => ({ id: 1, html_url: 'u' }));
}

/** 番号つきの書き込み（`#10 label+type:feat` の形） */
function numbered(fake: FakeGitHub): string[] {
  const names = fake.writes();
  return fake.calls
    .filter((c) => c.method !== 'GET' && !(c.path === '/graphql' && String(c.body?.query).startsWith('query')))
    .map((c, k) => `#${c.path.match(/\/issues\/(\d+)/)?.[1] ?? '?'} ${names[k]}`);
}

type Answers = Parameters<typeof summaryAnswers>[0];
function summaryAnswers(p: { priority?: Record<string, number>; area?: Record<string, number> }) {
  return {
    type: { type: 'choice', probabilities: { feature: 0.9 } },
    area: { type: 'choice', probabilities: p.area ?? { docs: 0.9 } },
    priority: { type: 'choice', probabilities: p.priority ?? { high: 0.9 } },
    ac_verifiable: { type: 'noul', noul: 0.9 },
    requirements_clear: { type: 'noul', noul: 0.9 },
  };
}

/** 偽の Jev。問われた Issue のタイトルを記録する */
function fakeJev(answers: Answers = {}) {
  const asked: string[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(String((request.state as { title: string }).title));
    return { status: 'ok', model: 'jev-test', answers: summaryAnswers(answers) };
  };
  return { asked, fn };
}

const withJev = (jev: ReturnType<typeof fakeJev>, patch: { config?: HarnessConfig } = {}) => ({ secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn, ...patch });

test('定期実行：agent:ready の無い Issue にも付け、ダッシュボードと /issues に混ざる PR は除く。Agent PR にも type を付ける', async () => {
  const fake = worldFake({
    issues: [
      issue(10, 'feat: ready の無い Issue', ['priority:medium', 'area:harness']),
      issue(1, config.dashboardIssueTitle, ['agent:auto-merge-stopped'], { user: { login: APP } }),
      issue(20, 'fix: /issues に混ざった PR', [], { pull_request: {} }),
    ],
    prs: [
      pr({ number: 30, title: 'docs: agent pr', labels: labels('size:S', 'area:docs'), head: { ref: 'claude/issue-10', sha: 'a'.repeat(40), repo: { full_name: 'o/r' } } }),
      pr({ number: 31, title: 'chore: human pr', labels: [], head: { ref: 'feature/x', sha: 'c'.repeat(40), repo: { full_name: 'o/r' } } }),
    ],
  });
  await labelApply(ctxFor(fake, 'schedule', {}));
  assert.deepEqual(numbered(fake), ['#10 label+type:feat', '#30 label+type:docs']);
});

test('定期実行：子を持つ Issue に epic を付け、App が付けた type:* を外す。計画ゲートを通った計画から area を付ける', async () => {
  const gate = appRecord(90, 'plan-gate', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files: ['docs/a.md'] } });
  const fake = worldFake({
    issues: [
      issue(12, 'feat: epic', ['type:feat', 'priority:high', 'area:harness'], { sub_issues_summary: { total: 2 } }),
      issue(13, 'docs: 計画済み', ['type:docs', 'priority:low', 'agent:plan-ok']),
    ],
    events: { 12: [labeledBy('type:feat', APP)] },
    comments: { 13: [gate] },
  });
  await labelApply(ctxFor(fake, 'schedule', {}));
  assert.deepEqual(numbered(fake), ['#12 label-type:feat', '#12 label+epic', '#13 label+area:docs']);
});

test('定期実行：人が付けた type:* は外さず知らせ、同じ食い違いは二度知らせない', async () => {
  const world: World = { issues: [issue(14, 'feat: a', ['type:fix', 'priority:low', 'area:docs'])], events: { 14: [labeledBy('type:fix', 'me')] } };
  const first = worldFake(world);
  await labelApply(ctxFor(first, 'schedule', {}));
  assert.deepEqual(numbered(first), ['#14 comment:label-mismatch']);
  const body = String(first.calls.find((c) => c.method === 'POST' && c.path.endsWith('/comments'))!.body.body);
  assert.match(body, /"labels": \[\s*"type:fix"/);

  const again = worldFake({ ...world, comments: { 14: [{ ...appRecord(1, 'label-mismatch', { version: 1, title: 'feat: a', labels: ['type:fix'] }) }] } });
  await labelApply(ctxFor(again, 'schedule', {}));
  assert.deepEqual(numbered(again), []);
});

test('Jev：確率が下限以上なら priority・area を付け、label-triage に記録する', async () => {
  const jev = fakeJev();
  const fake = worldFake({ issues: [issue(15, 'feat: a', [])] });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(jev)));
  assert.deepEqual(jev.asked, ['feat: a']);
  assert.deepEqual(numbered(fake), ['#15 label+type:feat', '#15 label+priority:high,area:docs', '#15 comment:label-triage']);
  const body = String(fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/comments'))!.body.body);
  assert.match(body, /"added": \[\s*"priority:high",\s*"area:docs"/);
});

test('Jev：確率が下限未満なら付けずに知らせる', async () => {
  const jev = fakeJev({ priority: { high: 0.5, medium: 0.5 } });
  const fake = worldFake({ issues: [issue(16, 'feat: a', ['type:feat', 'area:docs'])] });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(jev)));
  assert.deepEqual(numbered(fake), ['#16 comment:label-triage']);
  const body = String(fake.calls.find((c) => c.method === 'POST')!.body.body);
  assert.match(body, /付けなかったもの/);
  assert.match(body, /`priority:high` — 確率 50% が下限 80% 未満/);
});

test('Jev：labelProbability が無ければ付けない（提案のコメントだけ）', async () => {
  const jev = fakeJev();
  const noThreshold: HarnessConfig = { ...config, jev: { ...config.jev, thresholds: { lowProbability: 0.9, noulSafe: 0.9 } } };
  const fake = worldFake({ issues: [issue(17, 'feat: a', ['type:feat', 'area:docs'])] });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(jev, { config: noThreshold })));
  assert.deepEqual(numbered(fake), ['#17 comment:label-triage']);
});

test('Jev：同じ Issue に二度問わない（issue-triage か label-triage の記録があれば問わない）。Issue Form でない本文は問わない', async () => {
  const jev = fakeJev();
  const fake = worldFake({
    issues: [
      issue(18, 'feat: シャドーで問い済み', ['type:feat']),
      issue(19, 'feat: label で問い済み', ['type:feat']),
      issue(21, 'feat: 本文が Form でない', ['type:feat'], { body: 'なんとなく直したい' }),
    ],
    comments: {
      18: [appRecord(1, 'issue-triage', { version: 1, model: 'm', answers: {} })],
      19: [appRecord(2, 'label-triage', { version: 1, model: 'm', answers: {}, added: [] })],
    },
  });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(jev)));
  assert.deepEqual(jev.asked, []);
  assert.deepEqual(numbered(fake), []);
});

test('Jev：classification.issueTriage が label でなければ問わない', async () => {
  const jev = fakeJev();
  const shadow: HarnessConfig = { ...config, classification: { ...config.classification, issueTriage: 'shadow' } };
  const fake = worldFake({ issues: [issue(22, 'feat: a', ['type:feat'])] });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(jev, { config: shadow })));
  assert.deepEqual(jev.asked, []);
});

test(`Jev：1回の定期実行で問う Issue は ${JEV_PER_RUN} 件まで`, async () => {
  const jev = fakeJev();
  const issues = Array.from({ length: JEV_PER_RUN + 2 }, (_, k) => issue(40 + k, `feat: ${k}`, ['type:feat']));
  const fake = worldFake({ issues });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(jev)));
  assert.equal(jev.asked.length, JEV_PER_RUN);
  assert.equal(numbered(fake).filter((w) => w.endsWith('comment:label-triage')).length, JEV_PER_RUN);
});

test('定期実行の入口：ラベルを付けてからダッシュボードを書き直す', async () => {
  const fake = worldFake({ issues: [issue(10, 'feat: a', ['agent:ready', 'priority:medium', 'area:harness'])] })
    .on('GET', /\/repos\/o\/r$/, () => ({ allow_auto_merge: true }))
    .on('GET', /\/issues\?state=open&creator=/, () => [{ number: 1, title: config.dashboardIssueTitle, user: { login: APP }, labels: [] }])
    .on('GET', /\/issues\/1$/, () => ({ body: '' }))
    .on('PATCH', /\/issues\/1$/, () => ({}));
  await onScheduleWithLabels(ctxFor(fake, 'schedule', {}), new Date('2026-09-27T01:00:00Z'));
  const w = fake.writes();
  assert.ok(w.indexOf('label+type:feat') >= 0 && w.indexOf('label+type:feat') < w.indexOf('PATCH /repos/o/r/issues/1'), w.join(' '));
  const body = String(fake.calls.find((c) => c.method === 'PATCH')!.body.body);
  assert.ok(!body.includes('#10'), 'ダッシュボードは付けた後の状態を映す');
});

// --- イベント ---

const issueEvent = (action: string, title: string, names: string[], patch: Record<string, unknown> = {}) => ({
  action, sender: { login: 'me' }, issue: { number: 50, title, body: FORM_BODY, state: 'open', labels: labels(...names) }, ...patch,
});

test('Issue の作成でタイトルから type を付け、タイトルの編集で App が付けたものだけ付け替える', async () => {
  const opened = worldFake({});
  await onIssue(ctxFor(opened, 'issues', issueEvent('opened', 'feat: a', ['agent:ready'])));
  assert.deepEqual(numbered(opened), ['#50 label+type:feat']);

  const edited = worldFake({ events: { 50: [labeledBy('type:feat', APP)] } });
  await onIssue(ctxFor(edited, 'issues', issueEvent('edited', 'fix: a', ['type:feat'], { changes: { title: { from: 'feat: a' } } })));
  assert.deepEqual(numbered(edited), ['#50 label-type:feat', '#50 label+type:fix']);

  const human = worldFake({ events: { 50: [labeledBy('type:feat', 'me')] } });
  await onIssue(ctxFor(human, 'issues', issueEvent('edited', 'fix: a', ['type:feat'], { changes: { title: { from: 'feat: a' } } })));
  assert.deepEqual(numbered(human), ['#50 comment:label-mismatch']);

  const bodyOnly = worldFake({});
  await onIssue(ctxFor(bodyOnly, 'issues', issueEvent('edited', 'fix: a', [], { changes: { body: { from: 'x' } } })));
  assert.equal(bodyOnly.calls.length, 0, '本文の編集では動かない');

  const dashboard = worldFake({});
  await onIssue(ctxFor(dashboard, 'issues', issueEvent('opened', config.dashboardIssueTitle, [])));
  assert.equal(dashboard.calls.length, 0);
});

test('PR の作成とタイトルの編集で type を付ける（App が付けたものだけ付け替える）', async () => {
  const opened = acceptanceFake({ pr: pr({ title: 'docs: t' }), dashboardLabels: [] });
  await onPullRequest(ctxFor(opened, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(opened.writes().includes('label+type:docs'));

  const edited = acceptanceFake({ pr: pr({ title: 'fix: t', labels: labels('type:docs') }), dashboardLabels: [] })
    .on('GET', /\/issues\/5\/events/, () => [labeledBy('type:docs', APP)]);
  await onPullRequest(ctxFor(edited, 'pull_request_target', { action: 'edited', changes: { title: { from: 'docs: t' } }, pull_request: { number: 5 } }));
  assert.deepEqual(edited.writes().filter((w) => w.startsWith('label')), ['label-type:docs', 'label+type:fix']);

  const bodyOnly = acceptanceFake({ pr: pr({ title: 'fix: t', labels: labels('type:docs') }), dashboardLabels: [] });
  await onPullRequest(ctxFor(bodyOnly, 'pull_request_target', { action: 'edited', changes: { body: { from: 'x' } }, pull_request: { number: 5 } }));
  assert.deepEqual(bodyOnly.writes().filter((w) => w.startsWith('label')), []);
});

test('agent:ready（label）：提案のコメントを出して足りないものを付ける。問い済みなら問い直さず、コメントも出さない', async () => {
  const jev = fakeJev();
  const fresh = worldFake({});
  await onIssue(ctxFor(fresh, 'issues', issueEvent('labeled', 'feat: a', ['agent:ready', 'type:feat', 'priority:low'], { label: { name: 'agent:ready' } }), withJev(jev)));
  assert.deepEqual(numbered(fresh), ['#50 label+area:docs', '#50 comment:label-triage']);

  const full = worldFake({});
  await onIssue(ctxFor(full, 'issues', issueEvent('labeled', 'feat: a', ['agent:ready', 'type:feat', 'priority:low', 'area:docs'], { label: { name: 'agent:ready' } }), withJev(jev)));
  assert.deepEqual(numbered(full), ['#50 comment:label-triage'], '足りないものが無くても提案のコメントは続ける');

  const asked = worldFake({ comments: { 50: [appRecord(1, 'label-triage', { version: 1, model: 'm', answers: {}, added: [] })] } });
  await onIssue(ctxFor(asked, 'issues', issueEvent('labeled', 'feat: a', ['agent:ready'], { label: { name: 'agent:ready' } }), withJev(jev)));
  assert.deepEqual(numbered(asked), []);
  assert.equal(jev.asked.length, 2);
});
