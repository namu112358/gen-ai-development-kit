// 下限に届かず付かなかった既存の Issue の扱い（#229）：定期実行（labelApply）が label-triage の記録を見直した下限で読み直し、
// Jev を呼ばずに付け直して label-reapply を書くことを、偽の GitHub で確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import type { askJev } from '../lib/jev.ts';
import type { TimelineEvent } from '../lib/state.ts';
import { JEV_PER_RUN, labelApply, reapplyJevLabels } from '../gates/label-apply.ts';
import { APP, config, ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

// --- 偽の GitHub と偽の Jev（gates-label-apply.test.ts と同じ形） ---

const FORM_BODY = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\nx`).join('\n\n');
const labels = (...names: string[]) => names.map((name) => ({ name }));
const issue = (number: number, title: string, names: string[], patch: Record<string, unknown> = {}) => ({
  number, title, body: FORM_BODY, html_url: `https://x/${number}`, updated_at: '2026-09-27T00:00:00Z', labels: labels(...names), user: { login: 'me' }, ...patch,
});
const appRecord = (id: number, kind: string, value: unknown, login = APP) => ({
  id, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login, type: login === APP ? 'Bot' : 'User' },
  body: `${appMark(kind)}\nx\n${renderBlock('agent-app', value)}`,
});

interface World {
  issues?: unknown[];
  events?: Record<number, TimelineEvent[]>;
  comments?: Record<number, unknown[]>;
}

function worldFake(w: World): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&per_page/, () => w.issues ?? [])
    .on('GET', /\/pulls\?state=open/, () => [])
    .on('GET', /\/pulls\?state=closed/, () => [])
    .on('GET', /\/issues\/(\d+)\/events/, (m) => w.events?.[Number(m[1])] ?? [])
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => w.comments?.[Number(m[1])] ?? [])
    .on('POST', /\/issues\/(\d+)\/labels$/, (m, body) => {
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

/** 偽の Jev。問われた Issue のタイトルを記録する */
function fakeJev() {
  const asked: string[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(String((request.state as { title: string }).title));
    return {
      status: 'ok', model: 'jev-test', answers: {
        type: { type: 'choice', probabilities: { feature: 0.9 } },
        area: { type: 'choice', probabilities: { docs: 0.9 } },
        priority: { type: 'choice', probabilities: { high: 0.9 } },
        ac_verifiable: { type: 'noul', noul: 0.9 },
        requirements_clear: { type: 'noul', noul: 0.9 },
      },
    };
  };
  return { asked, fn };
}

const withJev = (jev: ReturnType<typeof fakeJev>, patch: { config?: HarnessConfig } = {}) => ({ secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn, ...patch });

// --- 記録 ---

const TRIAGE_ID = 501;
/** #229 と同じ形の label-triage の記録（medium 0.66 が下限 80% で付かなかった） */
const triage229 = (patch: Record<string, unknown> = {}) => ({
  version: 1, model: 'm', answers: {}, threshold: 0.8, added: [],
  notApplied: [{ question: 'priority', choice: 'medium', probability: 0.66, label: 'priority:medium', reason: '確率 66% が下限 80% 未満' }],
  ...patch,
});
const triageComment = (value: unknown = triage229(), id = TRIAGE_ID, login = APP) => appRecord(id, 'label-triage', value, login);
const HAS_TYPE_AREA = ['type:feat', 'area:harness'];

const commentBody = (fake: FakeGitHub, kind: string): string => {
  const c = fake.calls.find((x) => x.method === 'POST' && x.path.endsWith('/comments') && String(x.body?.body).includes(appMark(kind)));
  assert.ok(c, `${kind} のコメントが無い`);
  return String(c.body.body);
};

// --- 定期実行 ---

test('付け直し：#229 と同じ記録の Issue に、Jev を呼ばずに priority:medium を付けて label-reapply を書く', async () => {
  const jev = fakeJev();
  const fake = worldFake({ issues: [issue(229, 'feat: ラベルの下限を見直す', HAS_TYPE_AREA)], comments: { 229: [triageComment()] } });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(jev)));
  assert.deepEqual(jev.asked, []);
  assert.deepEqual(numbered(fake), ['#229 label+priority:medium', '#229 comment:label-reapply']);
  const block = extractBlock(commentBody(fake, 'label-reapply'), 'agent-app');
  assert.ok(block.found && block.ok);
  assert.deepEqual(block.value, { version: 1, triageCommentId: TRIAGE_ID, added: [{ label: 'priority:medium', probability: 0.66, threshold: 0.5 }] });
});

test('付け直し：jevApiKey が無くても動く', async () => {
  const fake = worldFake({ issues: [issue(229, 'feat: a', HAS_TYPE_AREA)], comments: { 229: [triageComment()] } });
  await labelApply(ctxFor(fake, 'schedule', {}));
  assert.deepEqual(numbered(fake), ['#229 label+priority:medium', '#229 comment:label-reapply']);
});

test('付け直し：label-reapply の記録がある Issue には何もしない', async () => {
  const done = appRecord(502, 'label-reapply', { version: 1, triageCommentId: TRIAGE_ID, added: [{ label: 'priority:medium', probability: 0.66, threshold: 0.5 }] });
  const fake = worldFake({ issues: [issue(229, 'feat: a', HAS_TYPE_AREA)], comments: { 229: [triageComment(), done] } });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(fakeJev())));
  assert.deepEqual(numbered(fake), []);
});

test('付け直し：既に priority:* がある Issue には何もしない', async () => {
  const fake = worldFake({ issues: [issue(229, 'feat: a', [...HAS_TYPE_AREA, 'priority:low'])], comments: { 229: [triageComment()] } });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(fakeJev())));
  assert.deepEqual(numbered(fake), []);
});

test('付け直し：確率が見直した下限に届かない（high 0.79）Issue には何もしない（コメントも書かない）', async () => {
  const high = triage229({ notApplied: [{ question: 'priority', choice: 'high', probability: 0.79, label: 'priority:high', reason: '確率 79% が下限 80% 未満' }] });
  const fake = worldFake({ issues: [issue(229, 'feat: a', HAS_TYPE_AREA)], comments: { 229: [triageComment(high)] } });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(fakeJev())));
  assert.deepEqual(numbered(fake), []);
});

test('付け直し：notApplied の無い古い記録には何もしない', async () => {
  const old = { version: 1, model: 'm', answers: {}, added: [] };
  const fake = worldFake({ issues: [issue(229, 'feat: a', HAS_TYPE_AREA)], comments: { 229: [triageComment(old)] } });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(fakeJev())));
  assert.deepEqual(numbered(fake), []);
});

test('付け直し：最新の label-triage の記録で判断する', async () => {
  const newer = triage229({ notApplied: [{ question: 'priority', choice: 'medium', probability: 0.3, label: 'priority:medium', reason: '確率 30% が下限 80% 未満' }] });
  const fake = worldFake({ issues: [issue(229, 'feat: a', HAS_TYPE_AREA)], comments: { 229: [triageComment(), triageComment(newer, 503)] } });
  await labelApply(ctxFor(fake, 'schedule', {}));
  assert.deepEqual(numbered(fake), []);
});

test('付け直し：classification.issueTriage が label でなければ動かない', async () => {
  const shadow: HarnessConfig = { ...config, classification: { ...config.classification, issueTriage: 'shadow' } };
  const fake = worldFake({ issues: [issue(229, 'feat: a', HAS_TYPE_AREA)], comments: { 229: [triageComment()] } });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(fakeJev(), { config: shadow })));
  assert.deepEqual(numbered(fake), []);
});

test('付け直し：App の名義でない label-triage 風のコメントは読まない', async () => {
  const fake = worldFake({ issues: [issue(229, 'feat: a', HAS_TYPE_AREA)], comments: { 229: [triageComment(triage229(), TRIAGE_ID, 'me')] } });
  await labelApply(ctxFor(fake, 'schedule', {}));
  assert.deepEqual(numbered(fake), []);
});

test(`付け直しは Jev に問う件数（${JEV_PER_RUN} 件）に数えない`, async () => {
  const jev = fakeJev();
  const asking = Array.from({ length: JEV_PER_RUN }, (_, k) => issue(70 + k, `feat: 問う ${k}`, ['type:feat']));
  const fake = worldFake({ issues: [issue(60, 'feat: 付け直す', HAS_TYPE_AREA), ...asking], comments: { 60: [triageComment()] } });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(jev)));
  assert.equal(jev.asked.length, JEV_PER_RUN);
  const w = numbered(fake);
  assert.ok(w.includes('#60 label+priority:medium'), w.join(' '));
  assert.ok(w.includes('#60 comment:label-reapply'), w.join(' '));
  assert.equal(w.filter((x) => x.endsWith('comment:label-triage')).length, JEV_PER_RUN);
});

test('label-triage の記録に、ラベルごとの下限の写し thresholdByLabel を残す（無ければ {}）', async () => {
  const fake = worldFake({ issues: [issue(80, 'feat: a', ['type:feat'])] });
  await labelApply(ctxFor(fake, 'schedule', {}, withJev(fakeJev())));
  const block = extractBlock(commentBody(fake, 'label-triage'), 'agent-app');
  assert.ok(block.found && block.ok);
  const value = block.value as { threshold: unknown; thresholdByLabel: unknown };
  assert.equal(value.threshold, 0.8);
  assert.deepEqual(value.thresholdByLabel, { 'priority:medium': 0.5 });

  const plain: HarnessConfig = { ...config, jev: { ...config.jev, thresholds: { lowProbability: 0.9, noulSafe: 0.9, labelProbability: 0.8 } } };
  const none = worldFake({ issues: [issue(81, 'feat: a', ['type:feat'])] });
  await labelApply(ctxFor(none, 'schedule', {}, withJev(fakeJev(), { config: plain })));
  const b2 = extractBlock(commentBody(none, 'label-triage'), 'agent-app');
  assert.ok(b2.found && b2.ok);
  assert.deepEqual((b2.value as { thresholdByLabel: unknown }).thresholdByLabel, {});
});

// --- reapplyJevLabels を直に ---

test('reapplyJevLabels：付けたラベルを返す。付けるものが無ければ [] で何も書かない', async () => {
  const fake = worldFake({});
  const added = await reapplyJevLabels(ctxFor(fake, 'schedule', {}), { number: 229, labels: HAS_TYPE_AREA }, [triageComment() as unknown as IssueComment]);
  assert.deepEqual(added, ['priority:medium']);
  assert.deepEqual(numbered(fake), ['#229 label+priority:medium', '#229 comment:label-reapply']);

  const none = worldFake({});
  const nothing = await reapplyJevLabels(ctxFor(none, 'schedule', {}), { number: 229, labels: [...HAS_TYPE_AREA, 'priority:high'] }, [triageComment() as unknown as IssueComment]);
  assert.deepEqual(nothing, []);
  assert.equal(none.calls.length, 0);
});
