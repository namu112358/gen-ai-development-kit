// Issue #565：定期実行の Epic の振り分け（epicTriage・onScheduleWithLabels）を偽の GitHub と偽の Jev で確かめる。
// 下限・差・問い済みの除外の細かい場合は epic-triage.test.ts（#564 の純粋な関数）に任せ、ここでは AC ごとに最小の1件にする
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock, extractBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { epicTriage } from '../gates/epic-triage.ts';
import { onScheduleWithLabels } from '../gates/label-apply.ts';
import { APP, config, ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

type Mode = 'shadow' | 'enforce';

const configWith = (mode: Mode): HarnessConfig => ({
  ...config,
  jev: { ...config.jev, epicTriage: mode, thresholds: { ...config.jev.thresholds, epicProbability: 0.9, epicMargin: 0.2 } },
});

const labels = (...names: string[]) => names.map((name) => ({ name }));

/** 開いた Epic（#436・#437）。closeDoneEpics が閉じないよう、子の数の要約は持たせない */
const epic = (number: number) => ({
  id: 9000 + number, number, title: `Epic ${number}`, body: `### Goal\n\nEpic ${number} の目的`, html_url: `https://x/${number}`,
  state: 'open', updated_at: '2026-09-27T00:00:00Z', user: { login: 'me' }, labels: labels('epic'),
});

/** 振り分けの対象 #500（id 9500）。type・priority・area を付けておき、labelApply の Jev の分類の問いが起きないようにする */
const target = () => ({
  id: 9500, number: 500, title: 'feat: Jev の振り分けを足す', body: '### Goal\n\nx', html_url: 'https://x/500',
  state: 'open', updated_at: '2026-09-27T00:00:00Z', user: { login: 'me' }, labels: labels('type:feat', 'priority:medium', 'area:harness'),
});

/** App の名義の epic-triage の記録 */
const triageRecord = (id: number, probabilities: Record<string, number | null>, added: number[]) => ({
  id, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('epic-triage')}\nx\n${renderBlock('agent-app', {
    version: 1, questionSet: 1, mode: 'shadow', model: 'jev-test', probabilities,
    decision: { epic: null, probability: null, second: null }, added, size: null,
  })}`,
});

interface World {
  /** Epic の番号 → sub-issues の子 */
  subIssues?: Record<number, { id: number; number: number; title: string }[]>;
  /** Issue ごとのコメント（App のコメントの POST が足される） */
  comments?: Record<number, unknown[]>;
  /** Issue ごとの親（無ければ null。404 の allow404 と同じ） */
  parents?: Record<number, unknown>;
}

function worldFake(w: World = {}): FakeGitHub {
  const comments = (w.comments ??= {});
  let nextId = 5000;
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&per_page/, () => [epic(436), epic(437), target()])
    .on('GET', /\/pulls\?state=open/, () => [])
    .on('GET', /\/pulls\?state=closed/, () => [])
    .on('GET', /\/issues\/(\d+)\/(events|timeline)/, () => [])
    .on('GET', /\/issues\/(\d+)\/sub_issues/, (m) => w.subIssues?.[Number(m[1])] ?? [])
    .on('GET', /\/issues\/(\d+)\/parent/, (m) => w.parents?.[Number(m[1])] ?? null)
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => comments[Number(m[1])] ?? [])
    .on('POST', /\/issues\/(\d+)\/sub_issues$/, () => ({}))
    .on('POST', /\/issues\/(\d+)\/labels$/, () => [])
    .on('DELETE', /\/labels\//, () => null)
    .on('POST', /\/issues\/(\d+)\/comments$/, (m, body) => {
      const c = { id: nextId++, created_at: new Date().toISOString(), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: String(body.body) };
      (comments[Number(m[1])] ??= []).push(c);
      return c;
    });
}

/** 偽の Jev。epic_<n> の問いにだけ確率（Epic の番号 → noul）で答え、問うた要求を控える */
function fakeJev(probabilities: Record<number, number>) {
  const requests: { questions: Record<string, unknown> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    const questions = (request as { questions: Record<string, unknown> }).questions;
    const keys = Object.keys(questions).filter((k) => /^epic_\d+$/.test(k));
    if (keys.length > 0) requests.push({ questions });
    const answers = Object.fromEntries(
      keys.filter((k) => probabilities[Number(k.slice(5))] !== undefined).map((k) => [k, { type: 'noul', noul: probabilities[Number(k.slice(5))] }]),
    );
    return { status: 'ok', model: 'jev-test', answers } as Awaited<ReturnType<typeof askJev>>;
  };
  return { requests, fn };
}

const withJev = (jev: ReturnType<typeof fakeJev>, mode: Mode) => ({ config: configWith(mode), secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn });

const subIssuePosts = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && /\/sub_issues$/.test(c.path));
const triageComments = (fake: FakeGitHub) =>
  fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/issues/500/comments') && String(c.body?.body).includes(appMark('epic-triage')));

/** 投稿された epic-triage のコメントの記録（agent-app） */
function postedRecord(fake: FakeGitHub): { body: string; value: { added: number[]; probabilities: Record<string, number | null> } } {
  const posted = triageComments(fake);
  assert.equal(posted.length, 1, '#500 に epic-triage の記録が1つ');
  const body = String(posted[0]!.body.body);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok);
  return { body, value: block.value as { added: number[]; probabilities: Record<string, number | null> } };
}

test('enforce：一番高い確率が下限以上で差も十分な Epic の sub-issues に足し、理由と記録を残す', async () => {
  const jev = fakeJev({ 436: 0.95, 437: 0.3 });
  const fake = worldFake();
  const result = await epicTriage(ctxFor(fake, 'schedule', {}, withJev(jev, 'enforce')));
  const posts = subIssuePosts(fake);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.path, /\/issues\/436\/sub_issues$/);
  assert.deepEqual(posts[0]!.body, { sub_issue_id: 9500 });
  const { body, value } = postedRecord(fake);
  assert.deepEqual(value.added, [436]);
  assert.ok(body.includes('外して'), '外し方を書く');
  assert.deepEqual(result?.unassigned.map((r) => r.number), []);
  assert.deepEqual(result?.failures, []);
});

test('下限未満：足さずに記録だけ残し、ダッシュボードの「Epic に入っていない Issue」に出る', async () => {
  const jev = fakeJev({ 436: 0.5, 437: 0.3 });
  const fake = worldFake()
    .on('GET', /\/repos\/o\/r$/, () => ({ allow_auto_merge: true }))
    .on('GET', /\/issues\?state=open&creator=/, () => [{ number: 1, title: config.dashboardIssueTitle, user: { login: APP }, labels: [] }])
    .on('GET', /\/issues\/1$/, () => ({ body: '' }))
    .on('PATCH', /\/issues\/1$/, () => ({}));
  await onScheduleWithLabels(ctxFor(fake, 'schedule', {}, withJev(jev, 'enforce')), new Date('2026-09-27T01:00:00Z'));
  assert.equal(subIssuePosts(fake).length, 0);
  assert.deepEqual(postedRecord(fake).value.added, []);
  const dashboard = String(fake.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1'))!.body.body);
  const start = dashboard.indexOf('### Epic に入っていない Issue');
  assert.ok(start >= 0, dashboard);
  const next = dashboard.indexOf('\n### ', start + 1);
  const section = dashboard.slice(start, next < 0 ? undefined : next);
  assert.ok(section.includes('#500'), section);
  assert.ok(section.includes('#436'), 'Jev の一番高い Epic を出す');
});

test('shadow：記録だけ残し、sub-issues を変えず親も読まない', async () => {
  const jev = fakeJev({ 436: 0.95, 437: 0.3 });
  const fake = worldFake();
  await epicTriage(ctxFor(fake, 'schedule', {}, withJev(jev, 'shadow')));
  assert.equal(triageComments(fake).length, 1);
  assert.equal(subIssuePosts(fake).length, 0);
  assert.equal(fake.calls.filter((c) => c.method === 'GET' && /\/parent$/.test(c.path)).length, 0);
});

test('同じ Issue と Epic の組に二度問わない（問い済みの Epic は問いから外し、全部問い済みなら Jev を呼ばない）', async () => {
  const jev = fakeJev({ 437: 0.3 });
  const fake = worldFake({ comments: { 500: [triageRecord(1, { 436: 0.5 }, [])] } });
  await epicTriage(ctxFor(fake, 'schedule', {}, withJev(jev, 'shadow')));
  assert.deepEqual(jev.requests.map((r) => Object.keys(r.questions)), [['epic_437']]);

  const all = fakeJev({ 436: 0.5, 437: 0.3 });
  const done = worldFake({ comments: { 500: [triageRecord(1, { 436: 0.5, 437: 0.3 }, [])] } });
  await epicTriage(ctxFor(done, 'schedule', {}, withJev(all, 'shadow')));
  assert.equal(all.requests.length, 0);
});

test('added にある組（外された組）には二度と足さず、親のある Issue にも足さない。何度回してもコメントを積まない', async () => {
  // (a) 前に #436 に足した記録がある（人・セッションが外した）。確率が高くても足さない
  const removed = fakeJev({ 436: 0.99, 437: 0.1 });
  const a = worldFake({ comments: { 500: [triageRecord(1, { 436: 0.99, 437: 0.1 }, [436])] } });
  await epicTriage(ctxFor(a, 'schedule', {}, withJev(removed, 'enforce')));
  assert.equal(removed.requests.length, 0);
  assert.equal(subIssuePosts(a).length, 0);

  // (b) 全部問い済みで記録の確率なら足せるが、親がある
  const parented = fakeJev({ 436: 0.95, 437: 0.3 });
  const b = worldFake({ comments: { 500: [triageRecord(1, { 436: 0.95, 437: 0.3 }, [])] }, parents: { 500: { id: 9999, number: 999 } } });
  const ctx = ctxFor(b, 'schedule', {}, withJev(parented, 'enforce'));
  await epicTriage(ctx);
  await epicTriage(ctx);
  assert.equal(parented.requests.length, 0);
  assert.equal(subIssuePosts(b).length, 0);
  assert.equal(triageComments(b).length, 0);
});

test('既にいずれかの開いた Epic の sub-issues にある Issue は問わず、変えない', async () => {
  const jev = fakeJev({ 436: 0.95, 437: 0.3 });
  const fake = worldFake({ subIssues: { 436: [{ id: 9500, number: 500, title: 'feat: Jev の振り分けを足す' }] } });
  await epicTriage(ctxFor(fake, 'schedule', {}, withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET' && c.path.includes('/issues/500')), []);
  assert.equal(subIssuePosts(fake).length, 0);
});
