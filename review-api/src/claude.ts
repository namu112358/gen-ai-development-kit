// 注入した Claude のクライアントでツールのループを回し、最後の JSON とモデルごとの usage を返す askWithTools と、再試行しない印の NonRetryableError。
// SDK は import せず、使う形だけを最小の型で持つ（呼び出し元が構造の型で合わせて渡す）。import は ./cost.ts の型だけで、Node と Workers の両方で動く。
import type { Usage } from './cost.ts';

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | unknown[];
}

export type MessagesParams = Record<string, unknown> & { messages: MessageParam[] };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

export interface Message {
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  usage: RawUsage;
}

export interface MessagesClient {
  create(params: MessagesParams): Promise<Message>;
}

export type ToolRunner = (call: { name: string; input: unknown }) => Promise<{ content: string; isError?: boolean }>;

export type AskFailure = 'invalid-json' | 'refusal' | 'max-tokens' | 'tool-limit';

export type AskResult =
  | { ok: true; value: unknown; usage: Record<string, Usage>; toolCalls: number }
  | { ok: false; reason: AskFailure; usage: Record<string, Usage>; toolCalls: number };

/** 再試行しても直らない 400・401・403。message は固定の形で、元のエラーの message・リクエスト・API キーを入れない */
export class NonRetryableError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Claude API が ${status} を返しました（再試行しない）`);
    this.name = 'NonRetryableError';
    this.status = status;
  }
}

function isText(block: ContentBlock): block is { type: 'text'; text: string } {
  return block.type === 'text' && typeof block.text === 'string';
}

function isToolUse(block: ContentBlock): block is { type: 'tool_use'; id: string; name: string; input: unknown } {
  return block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string';
}

const n = (v: number | null | undefined): number => (typeof v === 'number' ? v : 0);

/** 応答の usage をモデル名の鍵に足す。cache_creation の内訳があれば内訳を、無ければ cache_creation_input_tokens を 5m に数える */
export function addUsage(acc: Record<string, Usage>, model: string, raw: RawUsage): void {
  const cur = (acc[model] ??= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  cur.input += n(raw.input_tokens);
  cur.output += n(raw.output_tokens);
  cur.cacheRead += n(raw.cache_read_input_tokens);
  if (raw.cache_creation) {
    cur.cacheWrite5m += n(raw.cache_creation.ephemeral_5m_input_tokens);
    cur.cacheWrite1h += n(raw.cache_creation.ephemeral_1h_input_tokens);
  } else {
    cur.cacheWrite5m += n(raw.cache_creation_input_tokens);
  }
}

async function create(client: MessagesClient, params: MessagesParams): Promise<Message> {
  try {
    return await client.create(params);
  } catch (e) {
    const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
    if (status === 400 || status === 401 || status === 403) throw new NonRetryableError(status);
    throw e;
  }
}

/**
 * ツールを呼びながら最後の JSON を受け取る。ツールの実行は maxToolCalls 回まで。
 * 達したら次の問いを最後の1回にして tool_choice none を付ける（any・tool は使わない）。
 * 履歴は足すだけ（返った assistant の content はそのまま）で、params.messages は書き換えない
 */
export async function askWithTools(client: MessagesClient, params: MessagesParams, runTool: ToolRunner, maxToolCalls: number): Promise<AskResult> {
  const messages: MessageParam[] = [...params.messages];
  const usage: Record<string, Usage> = {};
  let toolCalls = 0;
  const fail = (reason: AskFailure): AskResult => ({ ok: false, reason, usage, toolCalls });

  for (;;) {
    const last = toolCalls >= maxToolCalls;
    const request: MessagesParams = last ? { ...params, messages, tool_choice: { type: 'none' } } : { ...params, messages };
    const res = await create(client, request);
    addUsage(usage, res.model, res.usage);

    if (res.stop_reason === 'tool_use') {
      if (last) return fail('tool-limit');
      const uses = res.content.filter(isToolUse);
      if (uses.length === 0) return fail('invalid-json');
      messages.push({ role: 'assistant', content: res.content });
      const results: unknown[] = [];
      for (const use of uses) {
        if (toolCalls >= maxToolCalls) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `ツールの呼び出しの上限（${maxToolCalls} 回）に達しました。ツールを使わずに最後の JSON を返してください`,
            is_error: true,
          });
          continue;
        }
        toolCalls++;
        const out = await runTool({ name: use.name, input: use.input });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    if (res.stop_reason === 'refusal') return fail('refusal');
    if (res.stop_reason === 'max_tokens') return fail('max-tokens');
    const joined = res.content.filter(isText).map((b) => b.text).join('').trim();
    try {
      return { ok: true, value: JSON.parse(joined) as unknown, usage, toolCalls };
    } catch {
      return fail('invalid-json');
    }
  }
}
