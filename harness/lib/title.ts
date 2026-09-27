/**
 * Issue・PR のタイトルの形式（Conventional Commits）。squash Merge ではコミットのタイトルが PR のタイトルになる。
 *   type(scope)!: 説明
 */

export const TITLE_TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'ci', 'build', 'perf', 'style', 'revert'] as const;
export type TitleType = (typeof TITLE_TYPES)[number];

export type TitleResult =
  | { ok: true; type: TitleType; scope: string | null; breaking: boolean; subject: string }
  | { ok: false; error: string };

const PATTERN = /^([a-z]+)(?:\(([a-z0-9][a-z0-9._/-]*)\))?(!)?: (\S.*)$/;

export function parseTitle(title: string): TitleResult {
  const m = title.trim().match(PATTERN);
  if (!m) return { ok: false, error: `タイトルが \`type(scope): 説明\` の形式ではありません（type は ${TITLE_TYPES.join(' / ')}）` };
  const type = m[1] as TitleType;
  if (!TITLE_TYPES.includes(type)) return { ok: false, error: `type「${m[1]}」は使えません（${TITLE_TYPES.join(' / ')}）` };
  return { ok: true, type, scope: m[2] ?? null, breaking: Boolean(m[3]), subject: m[4]! };
}
