import type { IssueComment } from './github.ts';
import { type GuardrailConfig, guardrailFiles } from './guardrail.ts';

/**
 * API のレビュー（review-api）の記録のコメントの読み戻しと、judge が判定に使う記録の選び方（Issue #1004・#1042）。GitHub・git を呼ばない。
 * 読み戻しの規則は review-api/src/record.ts の parseApiReviewComment と同じ（harness/lib は導入先に配るので review-api は import しない。
 * 同じ規則であることはテストが review-api の render 関数で作った本文で確かめる）。
 * 記録を使わずローカルのレビューに戻す条件（Issue #1069）：前回のローカルの判定にブロッキングがある、変更ファイルか base の設定を読めない、
 * base のガードレールに当たる、秘密扱いのファイルを含む（ここまでは記録を探す前）、記録のコメントが編集された、DRY_RUN・diff の切り捨ての印がある。
 */

/** 投稿しなかった記録の outcome（review-api の StoppedOutcome と同じ語彙） */
export const STOPPED_OUTCOMES = ['budget-exceeded', 'too-large', 'verdict-invalid'] as const;
export type StoppedOutcome = (typeof STOPPED_OUTCOMES)[number];

export type ApiReviewRecord =
  | {
      headSha: string;
      outcome: 'posted';
      pr: number;
      verdict: { review: unknown; risk: Record<string, unknown>; facts: unknown };
      models: { review: string; risk: string };
      /** diff を切ったか・DRY_RUN か（review-api の記録の欄。古い記録には無く null） */
      diffTruncated: boolean | null;
      dryRun: boolean | null;
    }
  | { headSha: string; outcome: StoppedOutcome; pr: number };

export type ApiReviewChoice =
  | { action: 'api'; reviewer: unknown; risk: unknown; recordUrl: string; recordHead: string; models: { review: string; risk: string } }
  | { action: 'local'; reason: string; recordUrl?: string }
  | { action: 'skip'; reason: 'closed' | 'same-head' }
  | { action: 'pending' };

const MARK = /<!-- api-review-shadow head=([0-9a-f]{40}) -->/g;
const FENCE = /^```api-review-shadow[ \t]*\n([\s\S]*?)\n```/gm;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** コメントから記録を読み戻す。目印・フェンスがちょうど1つで、JSON・version・head・pr が合わなければ null（投げない） */
export function parseApiReviewRecord(body: string): ApiReviewRecord | null {
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
  if (!isObject(value) || value['version'] !== 1 || value['headSha'] !== headSha) return null;
  const pr = value['pr'];
  if (typeof pr !== 'number' || !Number.isInteger(pr)) return null;
  const hasVerdict = 'verdict' in value;
  if (!('outcome' in value)) {
    const verdict = value['verdict'];
    const models = value['models'];
    if (!hasVerdict || !isObject(verdict) || !isObject(verdict['risk']) || !isObject(models)) return null;
    if (typeof models['review'] !== 'string' || typeof models['risk'] !== 'string') return null;
    // 印の欄は、あれば boolean だけを読む（review-api の parseApiReviewComment と同じ。Issue #1068）
    const flags: Record<'diffTruncated' | 'dryRun', boolean | null> = { diffTruncated: null, dryRun: null };
    for (const key of ['diffTruncated', 'dryRun'] as const) {
      if (!(key in value)) continue;
      const v = value[key];
      if (typeof v !== 'boolean') return null;
      flags[key] = v;
    }
    return {
      headSha,
      outcome: 'posted',
      pr,
      verdict: { review: verdict['review'], risk: verdict['risk'], facts: verdict['facts'] },
      models: { review: models['review'], risk: models['risk'] },
      ...flags,
    };
  }
  const outcome = value['outcome'];
  if (hasVerdict || typeof outcome !== 'string' || !(STOPPED_OUTCOMES as readonly string[]).includes(outcome)) return null;
  return { headSha, outcome: outcome as StoppedOutcome, pr };
}

/**
 * review-api が秘密の恐れがあるとして diff の中身を渡さないパスか（review-api/src/prompts.ts の isSecretPath と同じ規則の写し。
 * 同じであることはテストが確かめる）。最後の要素が .env・.env.*・.dev.vars・*.pem・*.key・*.p12・*.pfx・id_rsa*・id_ed25519* のどれか
 */
export function isSecretPathLike(path: string): boolean {
  const unquoted = path.replace(/^"/, '').replace(/"$/, '');
  const base = (unquoted.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (base === '') return false;
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base === '.dev.vars' ||
    /\.(pem|key|p12|pfx)$/.test(base) ||
    base.startsWith('id_rsa') ||
    base.startsWith('id_ed25519')
  );
}

/** 節の見出し（`=== ` で始まる行）の次から、次の見出しの前までの行 */
function sectionLines(text: string, heading: string): string[] | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`=== ${heading}`));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('=== '));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * judge-input の「=== PR の状態」の state と「=== 前回の判定」の headSha を読む（review-intake の段階0と同じ材料）。
 * 節が無い・「(集めていません)」・「(なし)」なら null
 */
export function judgeInputFacts(text: string): { state: string | null; previousHead: string | null } {
  const stateLine = sectionLines(text, 'PR の状態')?.find((l) => l.startsWith('state: '));
  const state = stateLine?.match(/^state: (\S+)/)?.[1] ?? null;
  const prevLine = sectionLines(text, '前回の判定')?.find((l) => /^headSha: [0-9a-f]{40}$/.test(l));
  const previousHead = prevLine?.slice('headSha: '.length) ?? null;
  return { state, previousHead };
}

/**
 * judge が判定に使う API の記録を選ぶ。closed・前回の判定と同じ head は skip。前回の判定にブロッキングがあり出どころが api でない
 * （previous-local-blocking）、変更ファイル（リネームは旧パスも）か base のガードレールの設定が読めない（scope-unreadable）、
 * base のガードレールに当たる（guardrail-files）、秘密扱いのファイルを含む（secret-files）なら、記録を探さずに local。
 * レビュー用 App（appLogin・Bot）の記録のうち、判定する head のものを先に、無ければ PR 自身の差分（patch-id）が同じ head のもの
 * （samePatch。head が違う候補にだけ呼ぶ）を使い、同じ段では新しい（id の大きい）コメント。無ければ pending、投稿しなかった記録なら local。
 * 選んだコメントが編集されていれば local（record-edited）、posted でも DRY_RUN（dry-run）・diff の切り捨て（diff-truncated）が
 * false でなければ（欄が無い古い記録も）local、それ以外は api
 */
export function selectApiReview(input: {
  pr: number;
  judgedHead: string;
  appLogin: string;
  comments: IssueComment[];
  facts: {
    state: string | null;
    previousHead: string | null;
    previous?: { blocking: number; reviewSource: 'api' | 'local' | null } | null;
  };
  scope: { files: string[] | null; baseGuardrail: GuardrailConfig | null };
  samePatch: (recordHead: string) => boolean;
}): ApiReviewChoice {
  if (input.facts.state === 'closed') return { action: 'skip', reason: 'closed' };
  if (input.facts.previousHead === input.judgedHead) return { action: 'skip', reason: 'same-head' };
  const previous = input.facts.previous;
  if (previous && previous.blocking > 0 && previous.reviewSource !== 'api') return { action: 'local', reason: 'previous-local-blocking' };
  const { files, baseGuardrail } = input.scope;
  if (files === null || baseGuardrail === null) return { action: 'local', reason: 'scope-unreadable' };
  if (guardrailFiles(baseGuardrail, files).length > 0) return { action: 'local', reason: 'guardrail-files' };
  if (files.some(isSecretPathLike)) return { action: 'local', reason: 'secret-files' };
  const candidates = input.comments
    .filter((c) => c.user?.login === input.appLogin && c.user.type === 'Bot')
    .map((c) => ({ comment: c, record: parseApiReviewRecord(c.body) }))
    .filter((x): x is { comment: IssueComment; record: ApiReviewRecord } => x.record !== null && x.record.pr === input.pr)
    .sort((a, b) => b.comment.id - a.comment.id);
  const sameHead = candidates.find((x) => x.record.headSha === input.judgedHead);
  const chosen = sameHead ?? candidates.find((x) => x.record.headSha !== input.judgedHead && input.samePatch(x.record.headSha));
  if (chosen === undefined) return { action: 'pending' };
  const { comment, record } = chosen;
  if (record.outcome !== 'posted') return { action: 'local', reason: record.outcome, recordUrl: comment.html_url };
  if (comment.updated_at !== comment.created_at) return { action: 'local', reason: 'record-edited', recordUrl: comment.html_url };
  if (record.dryRun !== false) return { action: 'local', reason: 'dry-run', recordUrl: comment.html_url };
  if (record.diffTruncated !== false) return { action: 'local', reason: 'diff-truncated', recordUrl: comment.html_url };
  return {
    action: 'api',
    reviewer: record.verdict.review,
    risk: { ...record.verdict.risk, facts: record.verdict.facts },
    recordUrl: comment.html_url,
    recordHead: record.headSha,
    models: record.models,
  };
}
