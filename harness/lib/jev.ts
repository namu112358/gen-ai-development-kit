import type { HarnessConfig } from './config.ts';
import type { JevRecord } from './merge-route.ts';
import { RISK_QUESTIONS, type Verdict } from './verdict.ts';

/**
 * TypeSafe AI の Jev（https://docs.typesafe.ai/api）で、Risk ポリシーの8問に1回の呼び出しで答えさせる。
 * Actions の決定論的ジョブからだけ呼ぶ。state には事実だけを渡し、Claude の判定（level・answers）は渡さない。
 * Jev は英語が主言語なので、質問と基準は英語で書く。
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

const QUESTION_TEXT: Record<string, string> = {
  q2_revertible: 'If this change is reverted with `git revert`, is every effect of it completely undone (no lingering data, external state, or published artifacts)?',
  q3_publicInterface: 'Does this change modify a public interface: an API, a schema, an event format, or a configuration format that other code or users depend on?',
  q4_tested: 'Is every behavior change in `diff` covered by existing tests or tests added in `diff`? If `diff` changes no runtime behavior at all (for example documentation only), answer yes.',
  q5_persistentData: 'Does this change write, delete, or migrate persistent data (databases, files kept across runs, external storage)?',
  q6_authBillingSecrets: 'Does this change touch authentication, authorization, billing, or secrets?',
  q7_dependencies: 'Does this change add or update dependencies (package manifests or lockfiles)?',
  q8_harnessConfig: 'Does this change touch a guardrail: a file matching `guardrail_paths` (the `guardrailPaths` of `harness.config.json`) and not matching `guardrail_exclude`? `harness.config.json` itself is always a guardrail. In the patterns, `*` matches within one path segment and `**` matches any depth.',
};

export function buildJevRequest(config: HarnessConfig, diff: string, changedFiles: string[], facts: Verdict['facts']) {
  const questions: Record<string, unknown> = {
    q1_risk: {
      type: 'choice',
      instructions: 'Classify the risk of merging `diff` automatically, judged by blast radius if it breaks and whether `git revert` fully restores the previous state.',
      criteria: {
        low: 'If broken, no user data, authentication, billing, or external integration is affected, and revert fully restores it. Docs, typos, isolated UI, small refactors that do not change behavior.',
        medium: 'May change business logic or API behavior, but revert fully restores it.',
        high: 'May have effects that revert cannot undo, or a wide blast radius: migrations, data writes or deletes, authentication, billing, infrastructure.',
        critical: 'Touches a guardrail (`guardrailPaths` in `harness.config.json`), permissions, secrets, or dependencies.',
      },
    },
  };
  for (const q of RISK_QUESTIONS) {
    questions[q.key] = { type: 'noul', instructions: QUESTION_TEXT[q.key] };
  }
  return {
    model: config.jev.model,
    state: {
      diff,
      changed_files: changedFiles,
      references_to_changed_code: facts.references,
      related_tests: facts.tests,
      changed_file_kinds: facts.fileKinds,
      // 質問8の基準（設定であって Claude の判定ではない）。一覧が無ければすべてがガードレール
      guardrail_paths: config.guardrailPaths ?? ['**'],
      guardrail_exclude: config.guardrailExclude ?? [],
    },
    questions,
  };
}

interface JevResponse {
  model: string;
  answers: Record<string, { type: string; noul?: number; choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Jev の答えが自動 Merge を許すか（切り替え後の判定規則。シャドー期間は記録のみ） */
export function jevAllows(config: HarnessConfig, answers: JevResponse['answers']): boolean {
  const { lowProbability, noulSafe } = config.jev.thresholds;
  if ((answers.q1_risk?.probabilities?.low ?? 0) < lowProbability) return false;
  return RISK_QUESTIONS.every((q) => {
    const p = answers[q.key]?.noul;
    if (typeof p !== 'number') return false;
    return q.safe === 'yes' ? p >= noulSafe : p <= 1 - noulSafe;
  });
}

export type JevAnswers = JevResponse['answers'];

/** Jev に1回問う（再試行つき）。Risk 判定と Issue の分類の両方から使う */
export async function askJev(
  apiKey: string,
  request: { model: string; state: unknown; questions: Record<string, unknown> },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: 'ok'; model: string; answers: JevAnswers } | { status: 'error'; detail: string }> {
  const body = JSON.stringify(request);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if ([408, 429, 529].includes(res.status) || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
        continue;
      }
      const text = await res.text();
      if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}: ${redact(text, apiKey).slice(0, 300)}` };
      const json = JSON.parse(text) as JevResponse;
      return { status: 'ok', model: json.model, answers: json.answers };
    } catch (e) {
      if (attempt === 2) return { status: 'error', detail: redact(String(e), apiKey).slice(0, 300) };
    }
  }
  return { status: 'error', detail: 'リトライ上限に達しました' };
}

/** 答えを記録用の形（選択肢ごとの確率、Noul は yes の確率）にする */
export function flattenAnswers(answers: JevAnswers): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [key, a] of Object.entries(answers)) out[key] = a.type === 'noul' ? { yes: a.noul ?? NaN } : { ...(a.probabilities ?? {}) };
  return out;
}

export async function callJev(
  config: HarnessConfig,
  apiKey: string | undefined,
  diff: string,
  changedFiles: string[],
  facts: Verdict['facts'],
  fetchImpl: typeof fetch = fetch,
): Promise<JevRecord> {
  if (config.jev.mode === 'off') return { status: 'skipped', detail: 'jev.mode=off' };
  if (!apiKey) return { status: 'skipped', detail: 'JEV_API_KEY が未設定' };
  if (diff.length > config.jev.maxDiffChars) {
    return { status: 'skipped', detail: `diff が大きすぎます（${diff.length} 文字 > ${config.jev.maxDiffChars}）` };
  }
  const r = await askJev(apiKey, buildJevRequest(config, diff, changedFiles, facts), fetchImpl);
  if (r.status === 'error') return r;
  return { status: 'ok', detail: r.model, allows: jevAllows(config, r.answers), answers: flattenAnswers(r.answers) };
}

/** ログやコメントに秘密が出ないよう伏せ字にする */
export function redact(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}
