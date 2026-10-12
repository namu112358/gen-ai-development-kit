// shadow の記録のコメントの書き出しと読み戻し。1行目の目印（head つき）、要約、機械可読の JSON を1つのフェンスに入れる。
// JSON 中の ` と < は \u0060・\u003c に書き換え、指摘の本文が別のフェンス・目印を作れないようにする。import は型だけで、Node と Workers の両方で動く。
import type { Usage } from './cost.ts';
import type { ShadowVerdict } from './verdict.ts';

export interface ShadowRecord {
  version: 1;
  pr: number;
  headSha: string;
  verdict: ShadowVerdict;
  models: { review: string; risk: string };
  usage: Record<string, Usage>;
  usd: number | null;
  durationSec: number;
}

const SHA = /^[0-9a-f]{40}$/;
const MARK = /<!-- api-review-shadow head=([0-9a-f]{40}) -->/g;
const FENCE = /^```api-review-shadow[ \t]*\n([\s\S]*?)\n```/gm;

/** shadow の記録のコメントの本文。headSha が40桁の小文字16進でなければ投げる */
export function renderShadowComment(record: ShadowRecord): string {
  if (!SHA.test(record.headSha)) throw new Error('headSha は40桁の小文字16進です');
  const json = JSON.stringify(record, null, 2).replace(/`/g, '\\u0060').replace(/</g, '\\u003c');
  return [
    `<!-- api-review-shadow head=${record.headSha} -->`,
    '## API レビュー（shadow）',
    '',
    `- Reviewer：${record.verdict.review.pass ? '合格' : '不合格'}（ブロッキング ${record.verdict.review.blocking.length} 件）`,
    `- Risk：${record.verdict.risk.level}`,
    `- 推定料金：${record.usd === null ? '不明' : `$${record.usd}`}`,
    `- 所要：${record.durationSec} 秒`,
    '',
    '判定には使っていません（記録だけ）。',
    '',
    '<details><summary>記録（機械可読）</summary>',
    '',
    '```api-review-shadow',
    json,
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

/** コメントから記録を読み戻す。目印・フェンスがちょうど1つで、JSON と version と head が合わなければ null（投げない） */
export function parseShadowComment(body: string): { headSha: string; record: ShadowRecord } | null {
  const marks = [...body.matchAll(MARK)];
  const fences = [...body.matchAll(FENCE)];
  if (marks.length !== 1 || fences.length !== 1) return null;
  const headSha = marks[0]![1]!;
  let value: unknown;
  try {
    value = JSON.parse(fences[0]![1]!);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as ShadowRecord;
  if (record.version !== 1 || record.headSha !== headSha) return null;
  return { headSha, record };
}
