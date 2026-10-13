// review-api の Claude への問い（review-api/src/claude.ts）が、偽のクライアントで外部 API を呼ばずに、
// ツールのループを maxToolCalls で止め（ツールの実行は maxToolCalls 回、最後の問いだけ tool_choice none）、最後の text の JSON を返すこと、
// JSON が読めない・refusal・max_tokens・上限の後のツールの要求でそれぞれの理由を返すこと、usage がモデルごとに足されること、
// 400・401・403 で NonRetryableError を投げ 429・500 では元のエラーのままにすること、
// ツールのループで最新の tool_result だけに cache_control を付け、前の回のものからは外し、材料のブロックの cache_control は残すこと（Issue #960）、
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
  // 先頭の2つは同じ。前の回の tool_result は cache_control が外れるだけで、ほかは同じ（付け外しは Issue #960 のテストで見る）
  const withoutCache = (blocks: Record<string, unknown>[]) => blocks.map(({ cache_control: _c, ...b }) => b);
  assert.deepEqual(m2.slice(0, 2), m1.slice(0, 2));
  assert.deepEqual(withoutCache(m2[2]!.content as Record<string, unknown>[]), withoutCache(r1));
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

test('askWithTools は最新の tool_result だけに cache_control を付け、前の回の tool_result からは外し、材料のブロックの cache_control は残す', async () => {
  const EPHEMERAL = { type: 'ephemeral' };
  const materialBlocks = [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b', cache_control: EPHEMERAL },
  ];
  const params: MessagesParams = { ...baseParams(), messages: [{ role: 'user', content: materialBlocks }] };
  const original = structuredClone(params.messages);
  const { client, calls } = fakeClient([
    msg([toolUse('t1')], 'tool_use'),
    msg([toolUse('t2')], 'tool_use'),
    msg([text('{"ok":true}')], 'end_turn'),
  ]);

  const result = await askWithTools(client, params, countingTool().runTool, 5);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(params.messages, original, '呼び出し元の params.messages は変えない');

  // (1) 材料（params.messages 由来）のブロックの cache_control は 1〜3 回目のすべてで残る
  for (const [i, c] of calls.entries()) assert.deepEqual(c.messages[0], original[0], `${i + 1} 回目の材料`);

  const lastUserBlocks = (i: number): Record<string, unknown>[] => {
    const m = calls[i]!.messages;
    const last = m.at(-1)!;
    assert.equal(last.role, 'user', `${i + 1} 回目の末尾は user`);
    return last.content as Record<string, unknown>[];
  };

  // (2) 2 回目：1 回目の tool_result（末尾の user メッセージの最後のブロック）に cache_control が付く
  const r1 = lastUserBlocks(1);
  assert.equal(calls[1]!.messages.length, 3);
  assert.deepEqual(calls[1]!.messages[1], { role: 'assistant', content: [toolUse('t1')] }, 'assistant の content は触らない');
  assert.equal(r1.length, 1);
  assert.equal(r1[0]!.tool_use_id, 't1');
  assert.deepEqual(r1[0]!.cache_control, EPHEMERAL, '2 回目の tool_result に cache_control がない');

  // (3) 3 回目：前の回の tool_result からは外れ、新しい tool_result だけに付く
  const m3 = calls[2]!.messages;
  assert.equal(m3.length, 5);
  const prev = m3[2]!.content as Record<string, unknown>[];
  assert.equal(prev[0]!.tool_use_id, 't1');
  assert.equal('cache_control' in prev[0]!, false, '3 回目で前の回の tool_result に cache_control が残っている');
  assert.deepEqual({ ...prev[0], cache_control: EPHEMERAL }, r1[0], 'cache_control 以外は 2 回目の tool_result と同じ');
  assert.deepEqual(m3[3], { role: 'assistant', content: [toolUse('t2')] }, 'assistant の content は触らない');
  const r2 = lastUserBlocks(2);
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.tool_use_id, 't2');
  assert.deepEqual(r2[0]!.cache_control, EPHEMERAL, '3 回目の tool_result に cache_control がない');
  // 3 回目で cache_control を持つのは、材料の最後のブロックと最新の tool_result だけ
  const cached = m3.flatMap((m, i) => (Array.isArray(m.content) ? m.content : []).map((b, j) => [i, j, (b as Record<string, unknown>).cache_control] as const))
    .filter(([, , cc]) => cc !== undefined)
    .map(([i, j]) => [i, j]);
  assert.deepEqual(cached, [[0, 1], [4, 0]]);
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
