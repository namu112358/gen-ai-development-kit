import { RISK_LEVELS, type RiskLevel } from './config.ts';
import type { Parsed } from './plan.ts';
import { Checker } from './validate.ts';

/**
 * 判定コメントの構造化出力（```agent-verdict）。Reviewer と Risk Agent の結果を1つにまとめる。
 * 書式は docs/formats.md、Risk の8問は docs/risk-policy.md を参照。
 */

export const NOUL = ['yes', 'no', 'unsure'] as const;
export type Noul = (typeof NOUL)[number];

/** 質問2〜8。safe は自動 Merge を止めない答え */
export const RISK_QUESTIONS = [
  { key: 'q2_revertible', text: 'revert すれば完全に元に戻るか', safe: 'yes' },
  { key: 'q3_publicInterface', text: '公開インターフェース（API・スキーマ・イベント形式・設定形式）を変えるか', safe: 'no' },
  { key: 'q4_tested', text: '挙動を変える変更は、既存または追加されたテストで検証されているか（挙動を変えない変更だけなら yes）', safe: 'yes' },
  { key: 'q5_persistentData', text: '永続データの書き込み・削除・移行を伴うか', safe: 'no' },
  { key: 'q6_authBillingSecrets', text: '認証・認可・課金・秘密情報に関わるか', safe: 'no' },
  { key: 'q7_dependencies', text: '依存関係（パッケージ・lockfile）を追加・更新するか', safe: 'no' },
  { key: 'q8_harnessConfig', text: 'この仕組み自体の設定（.claude/**、CLAUDE.md、CODEOWNERS、.github/**、harness/**、harness.config.json）に触れるか', safe: 'no' },
] as const satisfies readonly { key: string; text: string; safe: Noul }[];

export type RiskQuestionKey = (typeof RISK_QUESTIONS)[number]['key'];

export const BLOCKING_KINDS = [
  'ac-unmet',
  'out-of-scope',
  'typecheck-test-failure',
  'data-destruction',
  'secret-leak',
  'regression',
] as const;
export type BlockingKind = (typeof BLOCKING_KINDS)[number];

/** 3回目の修正を許す critical なブロッキング指摘 */
export const CRITICAL_BLOCKING: ReadonlySet<BlockingKind> = new Set(['typecheck-test-failure', 'data-destruction', 'secret-leak']);

export interface BlockingFinding {
  kind: BlockingKind;
  file?: string;
  detail: string;
}

export interface HumanNotes {
  /** 懸念点：壊れるとしたらどこか、何が確かめきれていないか */
  concerns: string[];
  /** 見てほしい箇所：ファイル・関数・観点 */
  checkPoints: string[];
}

export interface Verdict {
  version: 1;
  pr: number;
  headSha: string;
  review: {
    pass: boolean;
    blocking: BlockingFinding[];
    nonBlocking: string[];
    /** 人にレビューを依頼するときに伝えること（Risk が low 以外や人の PR では必ず書く） */
    humanNotes?: HumanNotes;
  };
  risk: {
    level: RiskLevel;
    answers: Record<RiskQuestionKey, Noul>;
    /** 記録のみ。判定には使わない */
    probabilities?: Record<string, number>;
    rationale: string;
  };
  /** Jev に渡す事実（Claude の判定は含めない） */
  facts: {
    references: string;
    tests: string;
    fileKinds: string;
  };
  metrics?: Record<string, string | number>;
}

export function parseVerdict(raw: unknown): Parsed<Verdict> {
  const c = new Checker();
  const o = c.object(raw, 'verdict');
  if (!o) return { ok: false, errors: c.errors };
  if (o.version !== 1) c.errors.push('verdict.version: 1 ではありません');

  const review = c.object(o.review, 'verdict.review') ?? {};
  const blocking = c.array(review.blocking, 'verdict.review.blocking').map((item, i): BlockingFinding => {
    const path = `verdict.review.blocking[${i}]`;
    const b = c.object(item, path) ?? {};
    const finding: BlockingFinding = {
      kind: c.oneOf(b.kind, BLOCKING_KINDS, `${path}.kind`),
      detail: c.string(b.detail, `${path}.detail`, { nonEmpty: true }),
    };
    if (b.file !== undefined) finding.file = c.string(b.file, `${path}.file`);
    return finding;
  });
  const pass = c.boolean(review.pass, 'verdict.review.pass');
  if (pass && blocking.length > 0) c.errors.push('verdict.review.pass が true なのにブロッキング指摘があります');
  if (!pass && blocking.length === 0) c.errors.push('verdict.review.pass が false なのにブロッキング指摘がありません');

  const risk = c.object(o.risk, 'verdict.risk') ?? {};
  const answersRaw = c.object(risk.answers, 'verdict.risk.answers') ?? {};
  const answers = {} as Record<RiskQuestionKey, Noul>;
  for (const q of RISK_QUESTIONS) answers[q.key] = c.oneOf(answersRaw[q.key], NOUL, `verdict.risk.answers.${q.key}`);

  const facts = c.object(o.facts, 'verdict.facts') ?? {};
  const headSha = c.string(o.headSha, 'verdict.headSha');
  if (!/^[0-9a-f]{40}$/.test(headSha)) c.errors.push('verdict.headSha: 40桁の SHA ではありません');

  const verdict: Verdict = {
    version: 1,
    pr: c.integer(o.pr, 'verdict.pr'),
    headSha,
    review: { pass, blocking, nonBlocking: c.stringArray(review.nonBlocking ?? [], 'verdict.review.nonBlocking') },
    risk: {
      level: c.oneOf(risk.level, RISK_LEVELS, 'verdict.risk.level'),
      answers,
      rationale: c.string(risk.rationale, 'verdict.risk.rationale', { nonEmpty: true }),
    },
    facts: {
      references: c.string(facts.references, 'verdict.facts.references'),
      tests: c.string(facts.tests, 'verdict.facts.tests'),
      fileKinds: c.string(facts.fileKinds, 'verdict.facts.fileKinds'),
    },
  };
  if (review.humanNotes !== undefined) {
    const h = c.object(review.humanNotes, 'verdict.review.humanNotes') ?? {};
    verdict.review.humanNotes = {
      concerns: c.stringArray(h.concerns ?? [], 'verdict.review.humanNotes.concerns'),
      checkPoints: c.stringArray(h.checkPoints ?? [], 'verdict.review.humanNotes.checkPoints'),
    };
  }
  if (risk.probabilities !== undefined) {
    const probs = c.object(risk.probabilities, 'verdict.risk.probabilities') ?? {};
    verdict.risk.probabilities = Object.fromEntries(
      Object.entries(probs).map(([k, v]) => [k, c.number(v, `verdict.risk.probabilities.${k}`, 0, 1)]),
    );
  }
  if (o.metrics !== undefined) {
    const m = c.object(o.metrics, 'verdict.metrics') ?? {};
    verdict.metrics = Object.fromEntries(
      Object.entries(m).filter((e): e is [string, string | number] => typeof e[1] === 'string' || typeof e[1] === 'number'),
    );
  }
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value: verdict };
}

/** Risk 判定が自動 Merge を許すか（Claude 判定期間のルール） */
export function riskAllowsAutoMerge(risk: Verdict['risk']): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (risk.level !== 'low') reasons.push(`Risk レベルが ${risk.level}`);
  for (const q of RISK_QUESTIONS) {
    const answer = risk.answers[q.key];
    if (answer !== q.safe) reasons.push(`「${q.text}」の答えが ${answer}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function hasCriticalBlocking(verdict: Verdict): boolean {
  return verdict.review.blocking.some((b) => CRITICAL_BLOCKING.has(b.kind));
}

/**
 * 修正ループの上限判定。fixRequests は App がこれまでに出した変更要求レビューの数（今回分は含まない）。
 * 通常2回まで、3回目は critical なブロッキング指摘があるときだけ。
 */
export function fixAllowed(
  fixRequests: number,
  critical: boolean,
  limits: { normalLimit: number; criticalLimit: number },
): boolean {
  if (fixRequests < limits.normalLimit) return true;
  return critical && fixRequests < limits.criticalLimit;
}
