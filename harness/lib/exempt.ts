import { REVIEW_EXEMPT_LABEL, TEST_EXEMPT_LABEL, type HarnessConfig } from './config.ts';
import type { IssueComment } from './github.ts';
import { appRecords } from './state.ts';

/**
 * 人が付ける例外ラベル（review:exempt・test:exempt）は、付けた時点の PR の差分にだけ効く。
 * App が付け外しの記録（kind review-exempt / test-exempt）に、その時点の差分の patch-id を残し、
 * 最新の記録が「付けた」で patch-id が現在の差分と同じときだけ有効とする（判定の引き継ぎと同じ考え方）。
 */

/** 付け外しの記録の kind */
export const EXEMPT_KINDS: Readonly<Record<string, string>> = {
  [REVIEW_EXEMPT_LABEL]: 'review-exempt',
  [TEST_EXEMPT_LABEL]: 'test-exempt',
};

/** 例外が効いていないことを知らせたコメントの kind（同じ head に二重に書かないため記録を付ける） */
export const EXEMPT_STALE_KIND = 'exempt-stale';

export interface ExemptRecord {
  version: 1;
  label: string;
  action: 'labeled' | 'unlabeled';
  /** 付けた・外した人 */
  by: string;
  /** その時点の PR の差分の patch-id */
  patchId: string;
  /** その時点の PR の head */
  headSha: string;
}

export interface ExemptStaleRecord {
  version: 1;
  label: string;
  headSha: string;
  patchId: string;
  reason: 'stale' | 'unrecorded';
}

/**
 * - off：ラベルが付いていない
 * - valid：付けた時点と差分が同じ（例外が効く）
 * - stale：付けた後に差分が変わった（効かない）
 * - unrecorded：付けた記録が無い（この仕組みの前に付けられた等。効かない）
 */
export type ExemptState = 'off' | 'valid' | 'stale' | 'unrecorded';

/** App が書いた、そのラベルの付け外しの記録（古い順） */
export function exemptRecords(config: HarnessConfig, comments: IssueComment[], label: string): ExemptRecord[] {
  const kind = Object.hasOwn(EXEMPT_KINDS, label) ? EXEMPT_KINDS[label] : undefined;
  if (!kind) return [];
  return appRecords<ExemptRecord>(config, comments, kind).map((r) => r.value).filter((v) => v?.version === 1 && v.label === label);
}

/** 付け外しを含む最新の記録が「付けた」で、その patch-id が現在の差分と同じときだけ valid */
export function exemptState(records: ExemptRecord[], labelPresent: boolean, currentPatchId: string): ExemptState {
  if (!labelPresent) return 'off';
  const last = records.at(-1);
  if (!last || last.action !== 'labeled' || typeof last.patchId !== 'string' || last.patchId === '') return 'unrecorded';
  return last.patchId === currentPatchId ? 'valid' : 'stale';
}

/** 同じ head について、そのラベルが効いていないことを既に知らせたか */
export function staleNotified(config: HarnessConfig, comments: IssueComment[], label: string, headSha: string): boolean {
  return appRecords<ExemptStaleRecord>(config, comments, EXEMPT_STALE_KIND).some((r) => r.value?.label === label && r.value.headSha === headSha);
}
