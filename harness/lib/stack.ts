/**
 * PR の base の見分け（既定ブランチ宛て・Stacked PR の層・スタックでないのに base が既定ブランチ以外）。
 * API で取り直した PR の `stack`（スタックの層にだけ入る）を型付きで読む。GitHub を呼ばない純粋な関数。
 */

/** REST の PR に入る stack（層でなければキーが無い） */
export interface PullRequestStack {
  base: { ref: string; sha: string };
  id: number;
  number: number;
  position: number;
  size: number;
}

/** default：既定ブランチ宛て、stacked：スタックの層（一番下が既定ブランチ宛て）、orphan-base：それ以外 */
export type BaseKind = 'default' | 'stacked' | 'orphan-base';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * PR の stack を読む。キーが無い・null ならスタックでない（null）。
 * 形が崩れていれば 'malformed' を返し、classifyBase が orphan-base にする（安全側）。
 */
export function stackOf(pr: unknown): PullRequestStack | null | 'malformed' {
  if (!isRecord(pr)) return null;
  const s = pr.stack;
  if (s === undefined || s === null) return null;
  if (!isRecord(s) || !isRecord(s.base)) return 'malformed';
  if (typeof s.base.ref !== 'string' || typeof s.base.sha !== 'string') return 'malformed';
  if (!isNumber(s.id) || !isNumber(s.number) || !isNumber(s.position) || !isNumber(s.size)) return 'malformed';
  return { base: { ref: s.base.ref, sha: s.base.sha }, id: s.id, number: s.number, position: s.position, size: s.size };
}

/** PR の base を見分ける。スタックでなく既定ブランチ宛てなら default、一番下が既定ブランチ宛てのスタックなら stacked、それ以外は orphan-base */
export function classifyBase(pr: { base: { ref: string }; stack?: unknown }, defaultBranch: string): BaseKind {
  const stack = stackOf(pr);
  if (stack === null) return pr.base.ref === defaultBranch ? 'default' : 'orphan-base';
  if (stack === 'malformed') return 'orphan-base';
  return stack.base.ref === defaultBranch ? 'stacked' : 'orphan-base';
}
