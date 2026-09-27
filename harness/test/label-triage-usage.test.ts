import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlock } from '../lib/blocks.ts';
import { parseIssueBody } from '../lib/issue-form.ts';
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

async function run(jev: ReturnType<typeof fakeJev>): Promise<FakeGitHub> {
  const fake = fakeGitHub();
  const ctx = ctxFor(fake, 'issues', {}, { secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn });
  const asked = await triageLabels(ctx, ISSUE, [], { proposal: true });
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

test('label-triage の size.chars・jaRatio は buildTriageRequest の要求を measureRequest で測った値', async () => {
  const record = triageRecord(await run(fakeJev(10)));
  const form = parseIssueBody(FORM_BODY);
  assert.ok(form.ok);
  const m = measureRequest(buildTriageRequest(config, ISSUE.title, form.contract));
  assert.equal(record.size.chars, m.chars);
  assert.equal(record.size.jaRatio, m.jaRatio);
  assert.ok(record.size.jaRatio > 0, 'タイトル・本文に日本語があるのに割合が 0');
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
