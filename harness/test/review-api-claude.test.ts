// review-api の Claude への問い（review-api/src/claude.ts）が、偽のクライアントで外部 API を呼ばずに、
// ツールのループを maxToolCalls で止め（ツールの実行は maxToolCalls 回、最後の問いだけ tool_choice none）、最後の text の JSON を返すこと、
// JSON が読めない・refusal・max_tokens・上限の後のツールの要求でそれぞれの理由を返すこと、usage がモデルごとに足されること、
// 400・401・403 で NonRetryableError を投げ 429・500 では元のエラーのままにすること、
// claude.ts が @anthropic-ai/sdk・cloudflare:workers・cloudflare:workflows・node:・harness/lib を import しないことを確かめる（Issue #910）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  askWithTools,
  NonRetryableError,
  type AskFailure,
  type ContentBlock,
  type Message,
  type MessagesClient,
  type MessagesParams,
  type RawUsage,
} from '../../review-api/src/claude.ts';
import type { Usage } from '../../review-api/src/cost.ts';

const claudePath = fileURLToPath(new URL('../../review-api/src/claude.ts', import.meta.url));

function fakeClient(responses: Array<Message | Error>): { client: MessagesClient; calls: MessagesParams[] } {
  const calls: MessagesParams[] = [];
  let i = 0;
  const client: MessagesClient = {
    async create(params) {
      calls.push(structuredClone(params));
      const r = responses[i++];
      if (r === undefined) throw new Error(`偽のクライアントの応答が足りない（${i}回目）`);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { client, calls };
}

function countingTool(): { runTool: (call: { name: string; input: unknown }) => Promise<{ content: string; isError?: boolean }>; seen: { name: string; input: unknown }[] } {
  const seen: { name: string; input: unknown }[] = [];
  return {
    seen,
    runTool: async (call) => {
      seen.push(call);
      return seen.length === 1 ? { content: `result-${seen.length}`, isError: true } : { content: `result-${seen.length}` };
    },
  };
}

const MODEL = 'claude-opus-5-5';
const u = (input = 1, output = 1): RawUsage => ({ input_tokens: input, output_tokens: output });
const msg = (content: ContentBlock[], stop_reason: string | null, usage: RawUsage = u(), model = MODEL): Message => ({
  model,
  content,
  stop_reason,
  usage,
});
const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read_file', input: { path: `${id}.ts` } });
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const baseParams = (): MessagesParams => ({
  model: MODEL,
  max_tokens: 1000,
  output_config: { effort: 'high' },
  messages: [{ role: 'user', content: 'review this' }],
});

test('askWithTools はツールを maxToolCalls 回だけ実行し、最後の問いだけ tool_choice none にして、最後の text の JSON を返す', async () => {
  const thinking: ContentBlock = { type: 'thinking', thinking: 'まず読む', signature: 'sig-1' };
  const second: ContentBlock[] = [thinking, toolUse('t2'), toolUse('t3')];
  const { client, calls } = fakeClient([
    msg([toolUse('t1')], 'tool_use'),
    msg(second, 'tool_use'),
    msg([text('  {"verdict":"pass","n":1}  ')], 'end_turn'),
  ]);
  const { runTool, seen } = countingTool();
  const params = baseParams();
  const original = structuredClone(params.messages);

  const result = await askWithTools(client, params, runTool, 2);

  assert.deepEqual(result.ok && result.value, { verdict: 'pass', n: 1 });
  assert.equal(result.toolCalls, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((c) => c.name), ['read_file', 'read_file']);
  assert.deepEqual(params.messages, original, '呼び出し元の params.messages は変えない');
  assert.equal(calls.length, 3);

  // tool_choice は最後の問いだけ none。それより前は付けない
  assert.equal('tool_choice' in calls[0]!, false);
  assert.equal('tool_choice' in calls[1]!, false);
  assert.deepEqual(calls[2]!.tool_choice, { type: 'none' });
  // output_config は毎回そのまま届く
  for (const c of calls) assert.deepEqual(c.output_config, { effort: 'high' });

  // 1回目の後：前の回の assistant の content がそのまま入り、tool_result の is_error は runTool の isError
  const m1 = calls[1]!.messages;
  assert.equal(m1.length, 3);
  assert.deepEqual(m1[0], original[0]);
  assert.deepEqual(m1[1], { role: 'assistant', content: [toolUse('t1')] });
  assert.equal(m1[2]!.role, 'user');
  const r1 = m1[2]!.content as Record<string, unknown>[];
  assert.equal(r1.length, 1);
  assert.equal(r1[0]!.type, 'tool_result');
  assert.equal(r1[0]!.tool_use_id, 't1');
  assert.equal(r1[0]!.content, 'result-1');
  assert.equal(r1[0]!.is_error, true);

  // 2回目の後：thinking を含む content がそのまま、tool_result は1つの user メッセージにまとまり、上限の後のものは is_error
  const m2 = calls[2]!.messages;
  assert.equal(m2.length, 5);
  assert.deepEqual(m2.slice(0, 3), m1);
  assert.deepEqual(m2[3], { role: 'assistant', content: second });
  assert.equal(m2[4]!.role, 'user');
  const r2 = m2[4]!.content as Record<string, unknown>[];
  assert.deepEqual(r2.map((b) => [b.type, b.tool_use_id]), [['tool_result', 't2'], ['tool_result', 't3']]);
  assert.equal(r2[0]!.content, 'result-2');
  assert.notEqual(r2[0]!.is_error, true);
  assert.equal(r2[1]!.is_error, true);
});

test('askWithTools は失敗の理由を返し、途中までの toolCalls を残す', async () => {
  const cases: [string, Message[], number, AskFailure, number][] = [
    ['JSON が読めない text', [msg([text('not json')], 'end_turn')], 2, 'invalid-json', 0],
    ['text が無い', [msg([], 'end_turn')], 2, 'invalid-json', 0],
    ['tool_use なのに tool_use のブロックが無い', [msg([text('{}')], 'tool_use')], 2, 'invalid-json', 0],
    ['refusal', [msg([text('{"a":1}')], 'refusal')], 2, 'refusal', 0],
    ['max_tokens', [msg([text('{"a":')], 'max_tokens')], 2, 'max-tokens', 0],
    ['最後の1回の後も tool_use', [msg([toolUse('t1')], 'tool_use'), msg([toolUse('t2')], 'tool_use')], 1, 'tool-limit', 1],
    ['maxToolCalls が 0 でも tool_use', [msg([toolUse('t1')], 'tool_use')], 0, 'tool-limit', 0],
  ];
  for (const [name, responses, max, reason, runs] of cases) {
    const { client, calls } = fakeClient(responses);
    const { runTool, seen } = countingTool();
    const result = await askWithTools(client, baseParams(), runTool, max);
    assert.equal(result.ok, false, name);
    assert.equal(!result.ok && result.reason, reason, name);
    assert.equal(seen.length, runs, `${name}: runTool の回数`);
    assert.equal(result.toolCalls, runs, `${name}: toolCalls`);
    assert.equal(calls.length, responses.length, `${name}: 問いの回数`);
    assert.ok(result.usage[MODEL], `${name}: 失敗でも usage を返す`);
    if (reason === 'tool-limit') assert.deepEqual(calls.at(-1)!.tool_choice, { type: 'none' }, `${name}: 最後の問いは tool_choice none`);
  }
});

test('askWithTools は usage をモデルごとに足し、cache_creation の内訳があれば cache_creation_input_tokens を数えない', async () => {
  const other = 'claude-haiku-5-5';
  const { client } = fakeClient([
    msg([toolUse('t1')], 'tool_use', {
      input_tokens: 10,
      output_tokens: 1,
      cache_creation_input_tokens: 999,
      cache_read_input_tokens: 3,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 },
    }),
    msg([toolUse('t2')], 'tool_use', {
      input_tokens: 20,
      output_tokens: 2,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: null,
      cache_creation: null,
    }, other),
    msg([text('{}')], 'end_turn', { input_tokens: 100, output_tokens: 10 }),
  ]);
  const result = await askWithTools(client, baseParams(), countingTool().runTool, 5);
  assert.equal(result.ok, true);
  const expected: Record<string, Usage> = {
    [MODEL]: { input: 110, output: 11, cacheWrite5m: 4, cacheWrite1h: 5, cacheRead: 3 },
    [other]: { input: 20, output: 2, cacheWrite5m: 6, cacheWrite1h: 0, cacheRead: 0 },
  };
  assert.deepEqual(result.usage, expected);
});

test('client.create の 400・401・403 は NonRetryableError（キーと本文を含まない）、429・500・status 無しは元のエラーのまま', async () => {
  const key = 'sk-ant-api03-FAKEKEY910';
  const marker = 'BODY-MARKER-910';
  const fail = (status: number | undefined): Error =>
    Object.assign(new Error(`request failed x-api-key=${key} body={"content":"${marker}"}`), status === undefined ? {} : { status });
  const params = (): MessagesParams => ({ ...baseParams(), messages: [{ role: 'user', content: marker }] });

  for (const status of [400, 401, 403]) {
    const { client } = fakeClient([fail(status)]);
    await assert.rejects(askWithTools(client, params(), countingTool().runTool, 2), (e: unknown) => {
      assert.ok(e instanceof NonRetryableError, `${status}`);
      assert.equal(e.name, 'NonRetryableError');
      assert.equal(e.status, status);
      assert.equal(e.message.includes(key), false, `${status}: API キー`);
      assert.equal(e.message.includes(marker), false, `${status}: リクエストの本文`);
      assert.equal(e.cause, undefined, `${status}: cause`);
      return true;
    });
  }
  for (const status of [429, 500, undefined]) {
    const original = fail(status);
    const { client } = fakeClient([original]);
    await assert.rejects(askWithTools(client, params(), countingTool().runTool, 2), (e: unknown) => {
      assert.strictEqual(e, original, `${status}`);
      assert.equal(e instanceof NonRetryableError, false, `${status}`);
      return true;
    });
  }
});

test('claude.ts は @anthropic-ai/sdk・cloudflare:workers・cloudflare:workflows・node:・harness/lib を import しない', () => {
  const source = readFileSync(claudePath, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
  const banned = specifiers.filter((s) => /^@anthropic-ai\/sdk|^cloudflare:workers$|^cloudflare:workflows$|^node:|harness\/lib/.test(s));
  assert.deepEqual(banned, [], specifiers.join(','));
});
