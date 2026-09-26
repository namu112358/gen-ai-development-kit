/**
 * コメントに埋め込む構造化データと目印。
 *
 * - Claude（Routine・人のセッション）が書くコメントは先頭に CLAUDE_MARK を付け、人のコメントと区別する
 * - 構造化データは ```agent-plan / ```agent-verdict のフェンスに JSON で書く
 * - App が書くコメントは APP_MARK(kind) を付け、JSON を ```agent-app に書く（App の名義と組で信頼する）
 */

export const CLAUDE_MARK = '<!-- agent-harness:claude -->';
export const appMark = (kind: string): string => `<!-- agent-harness:app kind=${kind} -->`;

export type BlockKind = 'agent-plan' | 'agent-verdict' | 'agent-claim' | 'agent-app';

export function hasClaudeMark(body: string | null | undefined): boolean {
  return (body ?? '').includes(CLAUDE_MARK);
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
