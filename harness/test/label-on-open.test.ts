// Issue の作成（opened）で、足りない priority:*・area:* を Jev に問って付けるかのテスト（#161）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { onIssue } from '../gates/on-issue.ts';
import { APP, config, ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

const FORM_BODY = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\nx`).join('\n\n');
const labels = (...names: string[]) => names.map((name) => ({ name }));
const N = 50;

const appRecord = (id: number, kind: string, value: unknown) => ({
  id, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\nx\n${renderBlock('agent-app', value)}`,
});

interface Current {
  title: string;
  body: string | null;
  state: string;
  labels: string[];
}

/**
 * 偽の GitHub。GET /issues/50 は読み直しの応答（current。付けたラベルは current に反映する）、
 * GET /issues/50/comments は comments、GET /issues/50/events は []
 */
function openFake(current: Current, comments: unknown[] = []): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\/(\d+)$/, (m) => ({ number: Number(m[1]), title: current.title, body: current.body, state: current.state, html_url: 'i', user: { login: 'me' }, labels: labels(...current.labels) }))
    .on('GET', /\/issues\/\d+\/comments/, () => comments)
    .on('GET', /\/issues\/\d+\/events/, () => [])
    .on('POST', /\/issues\/\d+\/labels$/, (_m, body) => {
      for (const l of body.labels as string[]) if (!current.labels.includes(l)) current.labels.push(l);
      return [];
    })
    .on('DELETE', /\/labels\//, () => null)
    .on('POST', /\/issues\/\d+\/comments$/, () => ({ id: 1, html_url: 'u' }));
}

function answers(p: { priority?: Record<string, number>; area?: Record<string, number> } = {}) {
  return {
    type: { type: 'choice', probabilities: { feature: 0.9 } },
    area: { type: 'choice', probabilities: p.area ?? { docs: 0.9 } },
    priority: { type: 'choice', probabilities: p.priority ?? { high: 0.9 } },
    ac_verifiable: { type: 'noul', noul: 0.9 },
    requirements_clear: { type: 'noul', noul: 0.9 },
  };
}

/** 偽の Jev。問われた Issue のタイトルを記録する */
function fakeJev(reply: 'ok' | 'error' | 'throw' = 'ok') {
  const asked: string[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(String((request.state as { title: string }).title));
    if (reply === 'throw') throw new Error('Jev に届きません');
    if (reply === 'error') return { status: 'error', detail: 'HTTP 500' };
    return { status: 'ok', model: 'jev-test', answers: answers() };
  };
  return { asked, fn };
}

const withJev = (jev: ReturnType<typeof fakeJev>, patch: { config?: HarnessConfig; secrets?: Record<string, string> } = {}) => ({ secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn, ...patch });

const openedEvent = (title: string, names: string[], patch: { body?: string | null; sender?: string; action?: string; changes?: unknown } = {}) => ({
  action: patch.action ?? 'opened',
  sender: { login: patch.sender ?? 'me' },
  issue: { number: N, title, body: patch.body === undefined ? FORM_BODY : patch.body, state: 'open', labels: labels(...names) },
  ...(patch.changes ? { changes: patch.changes } : {}),
});

/** 書き込みの短い名前（label+… / comment:…） */
const writes = (fake: FakeGitHub) => fake.writes();
const reread = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'GET' && /\/issues\/50$/.test(c.path));

// --- 問うとき ---

test('opened：label・鍵あり・Issue Form・priority と area が足りない → Jev に問い、下限以上を付けて label-triage を残す', async () => {
  const jev = fakeJev();
  const current: Current = { title: 'feat: a', body: FORM_BODY, state: 'open', labels: [] };
  const fake = openFake(current);
  await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', []), withJev(jev)));
  assert.deepEqual(jev.asked, ['feat: a']);
  assert.deepEqual(writes(fake), ['label+type:feat', 'label+priority:high,area:docs', 'comment:label-triage'], 'type:* を付けた後に Jev の付与と記録');
  assert.equal(reread(fake).length, 1, '問う前に Issue を1回読み直す');
  const body = String(fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/comments'))!.body.body);
  assert.match(body, /"added": \[\s*"priority:high",\s*"area:docs"/);
});

test('opened：priority だけが足りない → priority だけ付ける（area は人のものを残す）', async () => {
  const jev = fakeJev();
  const current: Current = { title: 'feat: a', body: FORM_BODY, state: 'open', labels: ['area:harness'] };
  const fake = openFake(current);
  await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', ['area:harness']), withJev(jev)));
  assert.deepEqual(jev.asked, ['feat: a']);
  assert.deepEqual(writes(fake), ['label+type:feat', 'label+priority:high', 'comment:label-triage']);
});

test('opened：area だけが足りない → area だけ付ける', async () => {
  const jev = fakeJev();
  const current: Current = { title: 'feat: a', body: FORM_BODY, state: 'open', labels: ['priority:low'] };
  const fake = openFake(current);
  await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', ['priority:low']), withJev(jev)));
  assert.deepEqual(jev.asked, ['feat: a']);
  assert.deepEqual(writes(fake), ['label+type:feat', 'label+area:docs', 'comment:label-triage']);
});

test('opened：読み直した本文とタイトルで問う（イベントの後に直されたもの）', async () => {
  const jev = fakeJev();
  const current: Current = { title: 'feat: 直したタイトル', body: FORM_BODY, state: 'open', labels: [] };
  const fake = openFake(current);
  await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', [], { body: 'まだ書いていない' }), withJev(jev)));
  assert.deepEqual(jev.asked, ['feat: 直したタイトル']);
});

// --- 問わないとき ---

test('opened：issueTriage が label でなければ問わず、API を増やさない', async () => {
  for (const mode of ['shadow', 'off'] as const) {
    const jev = fakeJev();
    const cfg: HarnessConfig = { ...config, classification: { ...config.classification, issueTriage: mode } };
    const fake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'open', labels: [] });
    await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', []), withJev(jev, { config: cfg })));
    assert.deepEqual(jev.asked, [], mode);
    assert.deepEqual(fake.calls.map((c) => `${c.method} ${c.path}`), ['POST /repos/o/r/issues/50/labels'], `${mode}：type:* の付与だけ`);
  }
});

test('opened：Jev の鍵が無ければ問わず、API を増やさない', async () => {
  const jev = fakeJev();
  const fake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'open', labels: [] });
  await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', []), { askJev: jev.fn }));
  assert.deepEqual(jev.asked, []);
  assert.deepEqual(fake.calls.map((c) => `${c.method} ${c.path}`), ['POST /repos/o/r/issues/50/labels']);
});

test('opened：Issue Form として読めない本文なら問わない', async () => {
  const jev = fakeJev();
  const fake = openFake({ title: 'feat: a', body: 'なんとなく直したい', state: 'open', labels: [] });
  await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', [], { body: 'なんとなく直したい' }), withJev(jev)));
  assert.deepEqual(jev.asked, []);
  assert.deepEqual(writes(fake), ['label+type:feat']);
});

test('opened：タイトルの形式が違えば問わない', async () => {
  const jev = fakeJev();
  const fake = openFake({ title: '用語集に追加', body: FORM_BODY, state: 'open', labels: [] });
  await onIssue(ctxFor(fake, 'issues', openedEvent('用語集に追加', []), withJev(jev)));
  assert.deepEqual(jev.asked, []);
  assert.deepEqual(writes(fake), []);
});

test('opened：ダッシュボードには何もしない', async () => {
  const jev = fakeJev();
  const fake = openFake({ title: config.dashboardIssueTitle, body: FORM_BODY, state: 'open', labels: [] });
  await onIssue(ctxFor(fake, 'issues', openedEvent(config.dashboardIssueTitle, [], { sender: APP }), withJev(jev)));
  assert.deepEqual(jev.asked, []);
  assert.equal(fake.calls.length, 0);
});

test('opened：問い済み（label-triage か issue-triage の記録がある）なら問わない', async () => {
  for (const kind of ['label-triage', 'issue-triage']) {
    const jev = fakeJev();
    const fake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'open', labels: [] }, [appRecord(1, kind, { version: 1, model: 'm', answers: {}, added: [] })]);
    await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', []), withJev(jev)));
    assert.deepEqual(jev.asked, [], kind);
    assert.deepEqual(writes(fake), ['label+type:feat'], kind);
  }
});

test('opened：足りないものが無ければ問わない（イベントのラベルは足りなくても、読み直したラベルで足りていれば問わない）', async () => {
  const full = fakeJev();
  const fullFake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'open', labels: ['priority:low', 'area:docs'] });
  await onIssue(ctxFor(fullFake, 'issues', openedEvent('feat: a', ['priority:low', 'area:docs']), withJev(full)));
  assert.deepEqual(full.asked, []);
  assert.deepEqual(writes(fullFake), ['label+type:feat']);

  const later = fakeJev();
  const laterFake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'open', labels: ['priority:low', 'area:docs'] });
  await onIssue(ctxFor(laterFake, 'issues', openedEvent('feat: a', []), withJev(later)));
  assert.deepEqual(later.asked, [], '作成の後に人が付けたラベルを読み直して判断する');
  assert.deepEqual(writes(laterFake), ['label+type:feat']);
});

test('opened：読み直した Issue が Close 済みなら問わない', async () => {
  const jev = fakeJev();
  const fake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'closed', labels: [] });
  await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', []), withJev(jev)));
  assert.deepEqual(jev.asked, []);
  assert.deepEqual(writes(fake), ['label+type:feat']);
});

test('opened：送り主が App（App が作った Issue）なら問わない', async () => {
  const jev = fakeJev();
  const fake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'open', labels: [] });
  await onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', [], { sender: APP }), withJev(jev)));
  assert.deepEqual(jev.asked, []);
  assert.ok(!writes(fake).includes('comment:label-triage'));
});

test('edited（タイトル）では Jev に問わない', async () => {
  const jev = fakeJev();
  const fake = openFake({ title: 'fix: a', body: FORM_BODY, state: 'open', labels: [] });
  await onIssue(ctxFor(fake, 'issues', openedEvent('fix: a', [], { action: 'edited', changes: { title: { from: 'feat: a' } } }), withJev(jev)));
  assert.deepEqual(jev.asked, []);
  assert.deepEqual(writes(fake), ['label+type:fix']);
  assert.equal(reread(fake).length, 0);
});

// --- Jev の失敗 ---

test('opened：Jev が ok を返さなくても処理は止まらず、type:* は付く', async () => {
  const jev = fakeJev('error');
  const fake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'open', labels: [] });
  await assert.doesNotReject(onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', []), withJev(jev))));
  assert.deepEqual(jev.asked, ['feat: a']);
  assert.deepEqual(writes(fake), ['label+type:feat']);
});

test('opened：Jev が例外を投げても処理は止まらず、type:* は付く', async () => {
  const jev = fakeJev('throw');
  const fake = openFake({ title: 'feat: a', body: FORM_BODY, state: 'open', labels: [] });
  await assert.doesNotReject(onIssue(ctxFor(fake, 'issues', openedEvent('feat: a', []), withJev(jev))));
  assert.deepEqual(jev.asked, ['feat: a']);
  assert.deepEqual(writes(fake), ['label+type:feat']);
});
