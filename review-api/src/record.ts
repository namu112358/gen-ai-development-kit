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

/** 記録に残す規則の要約（本文は入れない。rules.ts の RepositoryRules から files の中身を除いたもの） */
export interface RulesSummary {
  status: 'ok' | 'none' | 'unreadable' | 'too-large';
  paths: string[];
  chars: number;
  skipped: { path: string; reason: string }[];
}

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
  rules?: RulesSummary;
  /** diff を maxDiffChars で切ったか（古い記録・replay.ts の記録には無い） */
  diffTruncated?: boolean;
  /** DRY_RUN=1 で Claude を呼ばずに固定の JSON を使ったか（古い記録・replay.ts の記録には無い） */
  dryRun?: boolean;
}

/** 投稿しなかった記録の outcome（shadow のコメントを付けずに止めた理由） */
export type StoppedOutcome = 'budget-exceeded' | 'too-large' | 'verdict-invalid' | 'no-api-key';
const STOPPED_OUTCOMES: readonly string[] = ['budget-exceeded', 'too-large', 'verdict-invalid', 'no-api-key'];
/** 投稿しなかった記録。材料（diff・ファイル・Issue・PR 本文）・detail・budgetInvalid は入れない。usd は使った分の推定（budget で止めたときは null）、estimatedUsd は budget の段階の見込み */
export interface StoppedRecord {
  version: 1;
  pr: number;
  headSha: string;
  outcome: StoppedOutcome;
  usd: number | null;
  estimatedUsd?: number;
}

const SHA = /^[0-9a-f]{40}$/;
const MARK = /<!-- api-review-shadow head=([0-9a-f]{40}) -->/g;
const FENCE = /^```api-review-shadow[ \t]*\n([\s\S]*?)\n```/gm;

function rulesLine(rules: RulesSummary | undefined): string[] {
  if (rules === undefined) return [];
  const text =
    rules.status === 'ok'
      ? `ok（${rules.paths.length} ファイル、${rules.chars} 字）`
      : rules.status === 'none'
        ? 'なし'
        : rules.status === 'unreadable'
          ? '読めなかった（使っていない）'
          : '上限を超えた（使っていない）';
  return [`- リポジトリの規則：${text}`];
}

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
    ...rulesLine(record.rules),
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

const STOPPED_REASON: Record<StoppedOutcome, string> = {
  'budget-exceeded': '予算の上限（または上限・月の累計・単価が読めない）のため、レビューを行いませんでした。',
  'too-large': '1 回のレビューの見込みが上限を超えるため、レビューを行いませんでした。',
  'verdict-invalid': 'Claude の出力が判定の形に合わず、レビューを投稿しませんでした。',
  'no-api-key': 'このリポジトリの Claude API のキーが無いため、レビューを行いませんでした。',
};

/** 投稿しなかった記録のコメントの本文。目印・フェンス・エスケープは renderShadowComment と同じ。headSha が40桁の小文字16進でなければ投げる */
export function renderStoppedComment(record: StoppedRecord): string {
  if (!SHA.test(record.headSha)) throw new Error('headSha は40桁の小文字16進です');
  const json = JSON.stringify(record, null, 2).replace(/`/g, '\\u0060').replace(/</g, '\\u003c');
  return [
    `<!-- api-review-shadow head=${record.headSha} -->`,
    '## API レビュー（shadow・投稿なし）',
    '',
    `- 止めた理由：${record.outcome}（${STOPPED_REASON[record.outcome]}）`,
    `- 推定料金：${record.usd === null ? '不明' : `$${record.usd}`}`,
    ...(record.estimatedUsd === undefined ? [] : [`- 見込み：$${record.estimatedUsd}`]),
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

export type ParsedApiReviewComment =
  | { headSha: string; outcome: 'posted'; record: ShadowRecord }
  | { headSha: string; outcome: StoppedOutcome; record: StoppedRecord };

/** コメントから記録を読み戻す。目印・フェンスがちょうど1つで、JSON と version と head が合わなければ null（投げない）。outcome 欄が無く verdict があれば posted、outcome が語彙内で verdict が無ければ止めた記録 */
export function parseApiReviewComment(body: string): ParsedApiReviewComment | null {
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
  const obj = value as Record<string, unknown>;
  if (obj['version'] !== 1 || obj['headSha'] !== headSha) return null;
  const hasVerdict = 'verdict' in obj;
  if (!('outcome' in obj)) {
    if (!hasVerdict) return null;
    // 印の欄は、あれば boolean だけを読む（Issue #1068）
    for (const key of ['diffTruncated', 'dryRun']) if (key in obj && typeof obj[key] !== 'boolean') return null;
    return { headSha, outcome: 'posted', record: value as unknown as ShadowRecord };
  }
  const outcome = obj['outcome'];
  if (hasVerdict || typeof outcome !== 'string' || !STOPPED_OUTCOMES.includes(outcome)) return null;
  return { headSha, outcome: outcome as StoppedOutcome, record: value as unknown as StoppedRecord };
}

/** コメントから posted の記録を読み戻す（投稿しなかった記録には null）。 */
export function parseShadowComment(body: string): { headSha: string; record: ShadowRecord } | null {
  const parsed = parseApiReviewComment(body);
  if (parsed === null || parsed.outcome !== 'posted') return null;
  return { headSha: parsed.headSha, record: parsed.record };
}
