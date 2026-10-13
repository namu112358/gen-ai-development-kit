// shadow の記録のコメントの書き出しと読み戻し。1行目の目印（head つき）、要約、機械可読の JSON を1つのフェンスに入れる。
// JSON 中の ` と < は \u0060・\u003c に書き換え、指摘の本文が別のフェンス・目印を作れないようにする。import は型だけで、Node と Workers の両方で動く。
import type { Usage } from './cost.ts';
import type { Noul, RiskLevel, RiskQuestionKey, ShadowVerdict } from './verdict.ts';

/** 役ごとの使用量と推定料金 */
export type RoleUsage = { usage: Record<string, Usage>; usd: number | null };
/** Risk を Reviewer のモデルでも問い直した結果（判定には使わない）。飛ばした・失敗したときは理由だけ */
export type RiskCompareRecord =
  | { model: string; level: RiskLevel; answers: Record<RiskQuestionKey, Noul>; usd: number | null }
  | { model: string; skipped: 'budget' | 'not-validated' }
  | { model: string; error: string };

export interface ShadowRecord {
  version: 1;
  pr: number;
  headSha: string;
  verdict: ShadowVerdict;
  models: { review: string; risk: string };
  usage: Record<string, Usage>;
  usd: number | null;
  durationSec: number;
  usageByRole?: { review: RoleUsage; risk: RoleUsage; riskCompare?: RoleUsage };
  riskCompare?: RiskCompareRecord;
}

const SHA = /^[0-9a-f]{40}$/;
const MARK = /<!-- api-review-shadow head=([0-9a-f]{40}) -->/g;
const FENCE = /^```api-review-shadow[ \t]*\n([\s\S]*?)\n```/gm;

/** shadow の記録のコメントの本文。headSha が40桁の小文字16進でなければ投げる */
export function renderShadowComment(record: ShadowRecord): string {
  if (!SHA.test(record.headSha)) throw new Error('headSha は40桁の小文字16進です');
  const json = JSON.stringify(record, null, 2).replace(/`/g, '\\u0060').replace(/</g, '\\u003c');
  const usdText = (usd: number | null): string => (usd === null ? '不明' : `$${usd}`);
  const rc = record.riskCompare;
  const rcLine =
    rc === undefined
      ? []
      : [
          `- Risk（比べる ${rc.model}）：${
            'level' in rc ? `${rc.level}、${usdText(rc.usd)}` : 'skipped' in rc ? `飛ばした（${rc.skipped}）` : `失敗（${rc.error}）`
          }`,
        ];
  const u = record.usageByRole;
  const roleLine =
    u === undefined
      ? []
      : [
          `- 役ごとの推定料金：Reviewer ${usdText(u.review.usd)}・Risk ${usdText(u.risk.usd)}${u.riskCompare === undefined ? '' : `・比べる Risk ${usdText(u.riskCompare.usd)}`}`,
        ];
  return [
    `<!-- api-review-shadow head=${record.headSha} -->`,
    '## API レビュー（shadow）',
    '',
    `- Reviewer：${record.verdict.review.pass ? '合格' : '不合格'}（ブロッキング ${record.verdict.review.blocking.length} 件）`,
    `- Risk：${record.verdict.risk.level}`,
    ...rcLine,
    `- 推定料金：${record.usd === null ? '不明' : `$${record.usd}`}`,
    ...roleLine,
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
