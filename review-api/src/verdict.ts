// Claude の Reviewer・Risk の出力を、harness/lib/verdict.ts の parseVerdict と同じ規則で検査し、agent-verdict と同じ形に組む。
// 語彙は harness/lib から写し、ずれはテストが止める。誤りは全部集めてパス付きで返す。
// 外を読み込む文は書かない（Node と Workers の両方で型検査が通るように）。

export const NOUL = ['yes', 'no', 'unsure'] as const;
export type Noul = (typeof NOUL)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const BLOCKING_KINDS = [
  'ac-unmet',
  'out-of-scope',
  'typecheck-test-failure',
  'data-destruction',
  'secret-leak',
  'regression',
  'bug',
  'claude-md',
  'over-implementation',
  'over-testing',
  'over-engineering',
] as const;
export type BlockingKind = (typeof BLOCKING_KINDS)[number];

/** 質問2〜8。safe は自動 Merge を止めない答え（text は写さない） */
export const RISK_QUESTIONS = [
  { key: 'q2_revertible', safe: 'yes' },
  { key: 'q3_publicInterface', safe: 'no' },
  { key: 'q4_tested', safe: 'yes' },
  { key: 'q5_persistentData', safe: 'no' },
  { key: 'q6_authBillingSecrets', safe: 'no' },
  { key: 'q7_dependencies', safe: 'no' },
  { key: 'q8_harnessConfig', safe: 'no' },
] as const satisfies readonly { key: string; safe: Noul }[];
export type RiskQuestionKey = (typeof RISK_QUESTIONS)[number]['key'];

export interface BlockingFinding {
  kind: BlockingKind;
  file?: string;
  detail: string;
}

export interface HumanNotes {
  concerns: string[];
  checkPoints: string[];
}

export interface ReviewerOutput {
  pass: boolean;
  blocking: BlockingFinding[];
  nonBlocking: string[];
  humanNotes?: HumanNotes;
}

export interface RiskFacts {
  references: string;
  tests: string;
  fileKinds: string;
}

export interface RiskOutput {
  level: RiskLevel;
  answers: Record<RiskQuestionKey, Noul>;
  probabilities?: Record<string, number>;
  rationale: string;
  facts: RiskFacts;
}

export interface ShadowVerdict {
  version: 1;
  pr: number;
  headSha: string;
  review: ReviewerOutput;
  risk: { level: RiskLevel; answers: Record<RiskQuestionKey, Noul>; probabilities?: Record<string, number>; rationale: string };
  facts: RiskFacts;
  metrics: { model: string };
}

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

/** 検査の補助。誤りは errors に積み、値は読めなかったら空の値を返す */
class Check {
  errors: string[] = [];

  fail(path: string, expected: string): void {
    this.errors.push(`${path}: ${expected}`);
  }

  object(v: unknown, path: string): Obj | undefined {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Obj;
    this.fail(path, 'オブジェクトではありません');
    return undefined;
  }

  string(v: unknown, path: string, nonEmpty = false): string {
    if (typeof v === 'string' && (!nonEmpty || v.trim() !== '')) return v;
    this.fail(path, nonEmpty ? '空でない文字列ではありません' : '文字列ではありません');
    return '';
  }

  boolean(v: unknown, path: string): boolean {
    if (typeof v === 'boolean') return v;
    this.fail(path, '真偽値ではありません');
    return false;
  }

  oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    this.fail(path, `${allowed.join(' / ')} のどれかではありません`);
    return allowed[0] as T;
  }

  array(v: unknown, path: string): unknown[] {
    if (Array.isArray(v)) return v;
    this.fail(path, '配列ではありません');
    return [];
  }

  stringArray(v: unknown, path: string): string[] {
    return this.array(v, path).map((item, i) => this.string(item, `${path}[${i}]`));
  }

  number(v: unknown, path: string, min: number, max: number): number {
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v;
    this.fail(path, `${min}〜${max} の数ではありません`);
    return min;
  }
}

export function checkReviewerOutput(raw: unknown): Checked<ReviewerOutput> {
  const c = new Check();
  const o = c.object(raw, 'reviewer');
  if (!o) return { ok: false, errors: c.errors };

  const blocking = c.array(o.blocking, 'reviewer.blocking').map((item, i): BlockingFinding => {
    const path = `reviewer.blocking[${i}]`;
    const b = c.object(item, path) ?? {};
    const finding: BlockingFinding = {
      kind: c.oneOf(b.kind, BLOCKING_KINDS, `${path}.kind`),
      detail: c.string(b.detail, `${path}.detail`, true),
    };
    if (b.file !== undefined) finding.file = c.string(b.file, `${path}.file`);
    return finding;
  });
  const pass = c.boolean(o.pass, 'reviewer.pass');
  if (pass && blocking.length > 0) c.fail('reviewer.pass', 'true なのにブロッキング指摘があります');
  if (!pass && blocking.length === 0) c.fail('reviewer.pass', 'false なのにブロッキング指摘がありません');

  const value: ReviewerOutput = { pass, blocking, nonBlocking: c.stringArray(o.nonBlocking ?? [], 'reviewer.nonBlocking') };
  if (o.humanNotes !== undefined) {
    const h = c.object(o.humanNotes, 'reviewer.humanNotes') ?? {};
    value.humanNotes = {
      concerns: c.stringArray(h.concerns ?? [], 'reviewer.humanNotes.concerns'),
      checkPoints: c.stringArray(h.checkPoints ?? [], 'reviewer.humanNotes.checkPoints'),
    };
  }
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value };
}

export function checkRiskOutput(raw: unknown): Checked<RiskOutput> {
  const c = new Check();
  const o = c.object(raw, 'risk');
  if (!o) return { ok: false, errors: c.errors };

  const level = c.oneOf(o.level, RISK_LEVELS, 'risk.level');
  const answersRaw = c.object(o.answers, 'risk.answers') ?? {};
  const answers = {} as Record<RiskQuestionKey, Noul>;
  for (const q of RISK_QUESTIONS) answers[q.key] = c.oneOf(answersRaw[q.key], NOUL, `risk.answers.${q.key}`);
  const rationale = c.string(o.rationale, 'risk.rationale', true);
  const factsRaw = c.object(o.facts, 'risk.facts') ?? {};
  const facts: RiskFacts = {
    references: c.string(factsRaw.references, 'risk.facts.references'),
    tests: c.string(factsRaw.tests, 'risk.facts.tests'),
    fileKinds: c.string(factsRaw.fileKinds, 'risk.facts.fileKinds'),
  };

  const value: RiskOutput = { level, answers, rationale, facts };
  if (o.probabilities !== undefined) {
    const probs = c.object(o.probabilities, 'risk.probabilities') ?? {};
    value.probabilities = Object.fromEntries(
      Object.entries(probs).map(([k, v]) => [k, c.number(v, `risk.probabilities.${k}`, 0, 1)]),
    );
  }
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value };
}

/** 検査済みの出力を agent-verdict と同じ形に組む（ここでは検査しない） */
export function composeShadowVerdict(input: {
  pr: number;
  headSha: string;
  reviewer: ReviewerOutput;
  risk: RiskOutput;
  model: string;
}): ShadowVerdict {
  const { reviewer, risk } = input;
  const review: ReviewerOutput = { pass: reviewer.pass, blocking: reviewer.blocking, nonBlocking: reviewer.nonBlocking };
  if (reviewer.humanNotes !== undefined) review.humanNotes = reviewer.humanNotes;
  const riskPart: ShadowVerdict['risk'] = { level: risk.level, answers: risk.answers, rationale: risk.rationale };
  if (risk.probabilities !== undefined) riskPart.probabilities = risk.probabilities;
  return {
    version: 1,
    pr: input.pr,
    headSha: input.headSha,
    review,
    risk: riskPart,
    facts: risk.facts,
    metrics: { model: input.model },
  };
}
