/**
 * コメントに埋め込む構造化データと目印。
 *
 * - Claude（Routine・人のセッション）が書くコメントは先頭に CLAUDE_MARK を付け、人のコメントと区別する
 * - 構造化データは ```agent-plan / ```agent-verdict / ```agent-decision のフェンスに JSON で書く
 * - App が書くコメントは APP_MARK(kind) を付け、JSON を ```agent-app に書く（App の名義と組で信頼する）
 */

export const CLAUDE_MARK = '<!-- agent-harness:claude -->';
export const appMark = (kind: string): string => `<!-- agent-harness:app kind=${kind} -->`;

export type BlockKind = 'agent-plan' | 'agent-verdict' | 'agent-claim' | 'agent-app' | 'agent-review-panel' | 'agent-decision';

/**
 * 書いたセッションの ID を入れた目印（ID が無ければ CLAUDE_MARK）。
 * ID は呼び出し側（harness/scripts/agent.ts）が環境から渡す。lib の関数は環境を読まない
 */
export function claudeMark(session: string | null = null): string {
  return session ? `<!-- agent-harness:claude session=${session} -->` : CLAUDE_MARK;
}

/** MCP 経由の投稿で `<` `>` が HTML エンティティに変わることがあるため、その形も目印として扱う */
const MARK_RE = /(?:<|&lt;)!-- agent-harness:claude(?: session=([^\s<>&]+))? --(?:>|&gt;)/;
const PLAIN_MARK_RE = /(?:<|&lt;)!-- agent-harness:claude --(?:>|&gt;)/;

export function hasClaudeMark(body: string | null | undefined): boolean {
  return MARK_RE.test(body ?? '');
}

/** 目印に入ったセッション ID（ID の無い目印・目印が無ければ null） */
export function claudeMarkSession(body: string | null | undefined): string | null {
  return (body ?? '').match(MARK_RE)?.[1] ?? null;
}

/** 本文の ID の無い目印を ID 付きに置き換える。ID 付きの目印があればそのまま、目印が無ければ先頭に足す */
export function withClaudeMark(body: string, session: string | null): string {
  if (claudeMarkSession(body) !== null) return body;
  if (PLAIN_MARK_RE.test(body)) return body.replace(PLAIN_MARK_RE, claudeMark(session));
  return `${claudeMark(session)}\n${body}`;
}

/** 表示用の短いセッション ID。URL なら最後の部分から接頭辞（session_・cse_）を除いた先頭8文字、それ以外は先頭8文字 */
export function shortSession(session: string): string {
  const last = session.slice(session.lastIndexOf('/') + 1).replace(/^(?:session_|cse_)/, '');
  return last.slice(0, 8);
}

export function appMarkKind(body: string | null | undefined): string | null {
  return (body ?? '').match(/<!-- agent-harness:app kind=([\w-]+) -->/)?.[1] ?? null;
}

export type ExtractResult =
  | { found: false }
  | { found: true; ok: true; value: unknown }
  | { found: true; ok: false; error: string };

/** 指定したフェンスの JSON を1つだけ取り出す。2つ以上あれば曖昧としてエラー */
export function extractBlock(body: string | null | undefined, kind: BlockKind): ExtractResult {
  const text = (body ?? '').replace(/\r\n/g, '\n');
  // バッククォートのフェンスだけを受け付ける（gate.yml の if: が ```agent- で絞り込むため）
  const fence = new RegExp('^(`{3,})[ \\t]*' + kind + '[ \\t]*\\n([\\s\\S]*?)\\n\\1[ \\t]*$', 'gm');
  const matches = [...text.matchAll(fence)];
  if (matches.length === 0) return { found: false };
  if (matches.length > 1) return { found: true, ok: false, error: `${kind} ブロックが複数あります` };
  try {
    return { found: true, ok: true, value: JSON.parse(matches[0]![2]!) };
  } catch (e) {
    return { found: true, ok: false, error: `${kind} ブロックの JSON が壊れています: ${(e as Error).message}` };
  }
}

export function renderBlock(kind: BlockKind, value: unknown): string {
  return ['```' + kind, JSON.stringify(value, null, 2), '```'].join('\n');
}
