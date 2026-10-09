/**
 * 実装のモデル（Opus / Sonnet）を Jev に問い、計画ゲートの記録と show-plan・集計で使う形にする（Issue #139）。GitHub は呼ばない。
 * 材料は App が集めたもの（Issue のタイトルと本文、計画の files とその件数・種類、ガードレールに触れるか）だけで、
 * 計画の本文・批評・ゲートの理由は渡さない（計画を書いたセッションが Jev を誘導できないように）。問いと criteria は英語。
 * jev.modelRouting（無ければ shadow）：off は問わない。shadow は記録だけ。enforce はゲートを通った計画だけ勧めのモデルで実装する（use）。
 * Jev の失敗・鍵なし・材料が大きすぎるときは記録に残すだけで、ゲートの結果は変えない。呼び出しは harness/gates/on-comment.ts の onPlan。
 */
import { implementModelConfig, type HarnessConfig } from './config.ts';
import { askJev, type JevAnswers } from './jev.ts';
import type { PlanGateRecord } from './state.ts';
import { DEFAULT_TEST_PATTERNS, isTestFile } from './test-tamper.ts';

export type ModelRoutingMode = 'off' | 'shadow' | 'enforce';

/** 問いの版。問い・criteria を変えたら上げる（古い版の記録は使い回さない） */
export const MODEL_ROUTING_QUESTION_SET = 1;

export interface ModelRoutingInputs {
  fileCount: number;
  /** 拡張子ごとの件数（拡張子が無ければ (none)、パターンなら (pattern)） */
  fileKinds: Record<string, number>;
  testFileCount: number;
  touchesGuardrail: boolean;
}

/** 計画ゲートの記録（plan-gate）の modelRouting */
export interface ModelRoutingRecord {
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
  mode: 'shadow' | 'enforce';
  recommended?: 'opus' | 'sonnet';
  probabilities?: { opus: number; sonnet: number };
  inputs: ModelRoutingInputs;
  questionSet: number;
}

type Model = 'opus' | 'sonnet';

export function modelRoutingMode(config: HarnessConfig): ModelRoutingMode {
  const mode = config.jev.modelRouting;
  return mode === 'off' || mode === 'enforce' ? mode : 'shadow';
}

const kindOf = (path: string): string => {
  if (/[*?]/.test(path)) return '(pattern)';
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '(none)';
};

export function modelRoutingInputs(config: HarnessConfig, files: string[], guardrailHits: string[]): ModelRoutingInputs {
  const patterns = config.testPatterns ?? DEFAULT_TEST_PATTERNS;
  const fileKinds: Record<string, number> = {};
  for (const f of files) {
    const k = kindOf(f);
    fileKinds[k] = (fileKinds[k] ?? 0) + 1;
  }
  return { fileCount: files.length, fileKinds, testFileCount: files.filter((f) => isTestFile(patterns, f)).length, touchesGuardrail: guardrailHits.length > 0 };
}

const CRITERIA = {
  sonnet:
    'The work follows a pattern that already exists in the repository and is fully specified: for example documentation edits, adding a field, a label, or a test case, or repeating a change already made elsewhere. Few files are involved and the requirements say exactly what to change.',
  opus: 'The work needs deep reasoning: designing new logic or data flow, changing code that enforces safety rules (touches_guardrail is true), resolving requirements that leave choices open, coordinating changes across many files, or reasoning about concurrency, persistent state, or failure handling.',
};

export function buildModelRoutingRequest(config: HarnessConfig, issue: { title: string; body: string }, files: string[], inputs: ModelRoutingInputs) {
  return {
    model: config.jev.model,
    state: {
      issue_title: issue.title,
      issue_body: issue.body,
      planned_files: files,
      file_count: inputs.fileCount,
      file_kinds: inputs.fileKinds,
      test_file_count: inputs.testFileCount,
      touches_guardrail: inputs.touchesGuardrail,
    },
    questions: {
      implementation_model: {
        type: 'choice',
        instructions: 'Which model should implement the change described by issue_title and issue_body, limited to planned_files? Judge only from the state. Choose sonnet only when the work is routine.',
        criteria: CRITERIA,
      },
    },
  };
}

/** 答えから勧めを読む。確率の高いほう（同じなら opus）。確率が読めなければ null */
export function recommendModel(answers: JevAnswers): { recommended: Model; probabilities: { opus: number; sonnet: number } } | null {
  const p = answers.implementation_model?.probabilities;
  const opus = p?.opus;
  const sonnet = p?.sonnet;
  if (typeof opus !== 'number' || typeof sonnet !== 'number' || !Number.isFinite(opus) || !Number.isFinite(sonnet)) return null;
  return { recommended: opus >= sonnet ? 'opus' : 'sonnet', probabilities: { opus, sonnet } };
}

/** 実装のモデルを Jev に問う。off は null。失敗・throw は記録（status error）にして投げない */
export async function routeModel(
  config: HarnessConfig,
  apiKey: string | undefined,
  issue: { title: string; body: string },
  files: string[],
  guardrailHits: string[],
  ask: typeof askJev = askJev,
): Promise<ModelRoutingRecord | null> {
  const mode = modelRoutingMode(config);
  if (mode === 'off') return null;
  const inputs = modelRoutingInputs(config, files, guardrailHits);
  const base = { mode, inputs, questionSet: MODEL_ROUTING_QUESTION_SET };
  if (!apiKey) return { status: 'skipped', detail: 'JEV_API_KEY が未設定', ...base };
  const request = buildModelRoutingRequest(config, issue, files, inputs);
  const chars = JSON.stringify(request.state).length;
  if (chars > config.jev.maxDiffChars) return { status: 'skipped', detail: `材料が大きすぎます（${chars} 文字 > ${config.jev.maxDiffChars}）`, ...base };
  try {
    const res = await ask(apiKey, request);
    if (res.status === 'error') return { status: 'error', detail: res.detail, ...base };
    const rec = recommendModel(res.answers);
    if (!rec) return { status: 'error', detail: '答えに確率がありません', ...base };
    return { status: 'ok', recommended: rec.recommended, probabilities: rec.probabilities, ...base };
  } catch (e) {
    return { status: 'error', detail: e instanceof Error ? e.message : String(e), ...base };
  }
}

/** 前の記録を使い回せるか：同じ計画コメント・同じ本文の sha256 の、ok で今の問いの版の記録（error・skipped は使い回さない） */
export function reusableModelRouting(previous: (PlanGateRecord & { planBodySha256?: string }) | undefined, planCommentId: number, bodySha256: string): ModelRoutingRecord | null {
  const routing = previous?.modelRouting;
  if (!previous || previous.planCommentId !== planCommentId || previous.planBodySha256 !== bodySha256) return null;
  return routing?.status === 'ok' && routing.questionSet === MODEL_ROUTING_QUESTION_SET ? routing : null;
}

/** show-plan が出す実装のモデル。use は enforce で ok の勧めがあるときだけ勧め、それ以外は fleet.implementModel */
export function implementationRouting(
  config: HarnessConfig,
  record: ModelRoutingRecord | undefined,
): { mode: ModelRoutingMode; recommended: Model | null; probability: number | null; use: Model } {
  const mode = modelRoutingMode(config);
  const ok = record?.status === 'ok' && record.recommended ? record : null;
  const recommended = ok?.recommended ?? null;
  const probability = recommended && ok?.probabilities ? ok.probabilities[recommended] : null;
  const use = mode === 'enforce' && recommended ? recommended : implementModelConfig(config).implementModel;
  return { mode, recommended, probability, use };
}
