import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlock } from '../lib/blocks.ts';
import { parseIssueBody, type IssueContract } from '../lib/issue-form.ts';
import { buildTriageRequest } from '../lib/issue-triage.ts';
import { measureRequest, type askJev } from '../lib/jev.ts';
import { triageLabels } from '../gates/label-apply.ts';
import { config, ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

// Issue の分類（label-triage の記録）にも、送った材料の大きさと input_tokens を残す（Issue #129）

const FORM_BODY = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\n日本語の説明 x`).join('\n\n');
const ISSUE = { number: 60, title: 'feat: 分類の記録に大きさを残す', body: FORM_BODY, labels: [] as string[] };

const ANSWERS = {
  type: { type: 'choice', probabilities: { feature: 0.9 } },
  area: { type: 'choice', probabilities: { docs: 0.9 } },
  priority: { type: 'choice', probabilities: { high: 0.9 } },
  ac_verifiable: { type: 'noul', noul: 0.9 },
  requirements_clear: { type: 'noul', noul: 0.9 },
};

/** 偽の Jev。inputTokens を渡せば戻り値に入れる（undefined ならキーを入れない）。問われた要求を記録する */
function fakeJev(inputTokens?: number | null) {
  const requests: { state: unknown; questions: Record<string, unknown> }[] = [];
  const fn = (async (_key: string, request: { model: string; state: unknown; questions: Record<string, unknown> }) => {
    requests.push(request);
    return { status: 'ok', model: 'jev-test', answers: ANSWERS, ...(inputTokens === undefined ? {} : { inputTokens }) };
  }) as unknown as typeof askJev;
  return { requests, fn };
}

function fakeGitHub(): FakeGitHub {
  return new FakeGitHub()
    .on('POST', /\/issues\/\d+\/labels$/, () => [])
    .on('POST', /\/issues\/\d+\/comments$/, () => ({ id: 1, html_url: 'u' }));
}

/** 投稿された label-triage のコメントから記録（agent-app ブロックの JSON）を取り出す */
function triageRecord(fake: FakeGitHub): Record<string, any> {
  const post = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/comments') && String(c.body?.body).includes('kind=label-triage'));
  assert.ok(post, 'label-triage のコメントが無い');
  const block = extractBlock(String(post.body.body), 'agent-app');
  assert.ok(block.found && block.ok, '記録のブロックが読めない');
  return (block as { value: Record<string, any> }).value;
}

type Target = { number: number; title: string; body: string; labels: string[]; subIssues?: number };
/** 材料（ラベル・子の数）を持つ Issue（#259） */
const ISSUE_WITH_CONTEXT: Target = { ...ISSUE, number: 61, labels: ['type:feat', 'area:harness', 'agent:ready'], subIssues: 2 };

async function run(jev: ReturnType<typeof fakeJev>, issue: Target = ISSUE): Promise<FakeGitHub> {
  const fake = fakeGitHub();
  const ctx = ctxFor(fake, 'issues', {}, { secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn });
  const asked = await (triageLabels as unknown as (...args: unknown[]) => Promise<boolean>)(ctx, issue, [], { proposal: true });
  assert.equal(asked, true);
  return fake;
}

test('label-triage の記録に size（chars・jaRatio・inputTokens）が入る', async () => {
  const jev = fakeJev(2345);
  const record = triageRecord(await run(jev));
  assert.equal(jev.requests.length, 1);
  const m = measureRequest(jev.requests[0]!);
  assert.deepEqual(record.size, { chars: m.chars, jaRatio: m.jaRatio, inputTokens: 2345 });
});

/** triageLabels と同じ context（その Issue の labels・subIssues）で作った要求を測る */
function measureExpected(issue: Target) {
  const form = parseIssueBody(issue.body);
  assert.ok(form.ok);
  const build = buildTriageRequest as unknown as (c: typeof config, t: string, k: IssueContract, ctx?: { labels?: string[]; subIssues?: number }) => Parameters<typeof measureRequest>[0];
  return measureRequest(build(config, issue.title, form.contract, { labels: issue.labels, subIssues: issue.subIssues }));
}

test('label-triage の size.chars・jaRatio は buildTriageRequest の要求を measureRequest で測った値', async () => {
  for (const issue of [ISSUE, ISSUE_WITH_CONTEXT]) {
    const record = triageRecord(await run(fakeJev(10), issue));
    const m = measureExpected(issue);
    assert.equal(record.size.chars, m.chars, `#${issue.number}`);
    assert.equal(record.size.jaRatio, m.jaRatio, `#${issue.number}`);
    assert.ok(record.size.jaRatio > 0, 'タイトル・本文に日本語があるのに割合が 0');
  }
});

test('ラベルと子を持つ Issue の size は、新しい材料（known_labels・sub_issue_count）を含む要求を測っている', async () => {
  const jev = fakeJev(10);
  const record = triageRecord(await run(jev, ISSUE_WITH_CONTEXT));
  const state = jev.requests[0]!.state as Record<string, unknown>;
  assert.deepEqual(state.known_labels, ['area:harness', 'type:feat']);
  assert.equal(state.sub_issue_count, 2);
  const form = parseIssueBody(FORM_BODY);
  assert.ok(form.ok);
  const without = measureRequest(buildTriageRequest(config, ISSUE_WITH_CONTEXT.title, form.contract));
  assert.ok(record.size.chars > without.chars, '材料を含まない要求の大きさと同じ');
  assert.equal(record.size.chars, measureRequest(jev.requests[0]!).chars);
});

test('偽の askJev が inputTokens を返さないときは size.inputTokens が null', async () => {
  const record = triageRecord(await run(fakeJev()));
  assert.ok(record.size, 'size が無い');
  assert.equal(record.size.inputTokens, null);
  assert.equal(typeof record.size.chars, 'number');
  assert.equal(typeof record.size.jaRatio, 'number');
});

test('既存の記録の項目（version・model・answers・added）は残る', async () => {
  const record = triageRecord(await run(fakeJev(1)));
  assert.equal(record.version, 1);
  assert.equal(record.model, 'jev-test');
  assert.ok(record.answers);
  assert.ok(Array.isArray(record.added));
});
