import type { HarnessConfig } from './config.ts';
import type { JevRecord } from './merge-route.ts';
import { RISK_QUESTIONS, type Verdict } from './verdict.ts';

/**
 * TypeSafe AI の Jev（https://docs.typesafe.ai/api）で、Risk ポリシーの8問に1回の呼び出しで答えさせる。
 * Actions の決定論的ジョブからだけ呼ぶ。state には App が API と設定から集めたもの（diff・変更ファイル・ガードレールの一覧）だけを渡す。
 * セッションが書いたもの（判定コメントの facts・level・answers）は渡さない（セッションが Jev を誘導できないように）。
 * Jev は英語が主言語なので、質問と基準は英語で書く。
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * 問いの版。問いの文や criteria を変えたら上げる（受け付けの記録の `questionSet` に残し、集計を版ごとに分ける）。
 * 版 1 は Q87 より前の問い（記録に `questionSet` が無いもの）。
 */
export const JEV_QUESTION_SET = 2;

/**
 * q2〜q8 の Noul の問い。Jev は文字どおりに読むので、条件を直接書き、境界の例を `criteria` に置く（Q87）。
 * `criteria` の形は Noul の API（https://docs.typesafe.ai/primitives/noul の Request structure）に合わせる。
 */
export const JEV_NOUL_QUESTIONS: Record<string, { instructions: string; criteria?: { true: string; false: string } }> = {
  q2_revertible: {
    instructions: 'Would running `git revert` on this change restore the state from before the change?',
    criteria: {
      true: 'Every change in `diff` is an edit to files in this repository (documentation, tests, source code, or configuration), and the changed code does not write stored data, call an external service, send messages, or publish or deploy anything when it runs. Changes that only edit documentation or tests are yes.',
      false: '`diff` adds or changes code that, when it runs, writes, deletes, or migrates stored data, calls an external service that changes remote state, sends messages, or publishes, deploys, or releases something. Reverting the files does not undo those effects. This includes changes to CI or deployment workflow files that publish, deploy, or release something when they run.',
    },
  },
  q3_publicInterface: {
    instructions: 'Judging from `diff` only: does this change modify something that is exported, that other modules may use, or the shape of a configuration, schema, API, or event format? If so, answer yes.',
    criteria: {
      true: '`diff` changes the name, parameters, or return value of an exported function, type, or class, or changes the fields, keys, or allowed values of a configuration file, schema, API, command-line option, or event or comment format.',
      false: '`diff` changes only explanatory documentation, tests, code comments, or code that is not exported, and changes no configuration, schema, API, command-line option, or event or comment format.',
    },
  },
  q4_tested: {
    instructions: 'Is every behavior change in `diff` matched by a test added or modified in `diff` (a test file listed in `changed_files`)? If you cannot confirm this from `diff`, answer no. If `diff` changes no runtime behavior at all (for example documentation only), answer yes.',
  },
  q5_persistentData: {
    instructions: 'Does `diff` add or change code that writes, deletes, or migrates persistent data?',
    criteria: {
      true: '`diff` adds or changes code that, when it runs, writes to, deletes from, or changes the schema of a database, files that the program keeps between runs, or external storage.',
      false: '`diff` changes only documentation, tests, or code that does not write stored data. The edits to repository files shown in `diff` are not themselves persistent data writes.',
    },
  },
  q6_authBillingSecrets: {
    instructions: 'Does this change touch authentication, authorization, billing, or secrets?',
    criteria: {
      true: '`diff` changes code or configuration that checks identity or permissions, handles tokens, keys, or passwords, stores or reads secrets, or charges money.',
      false: '`diff` changes no such code or configuration. Documentation that only mentions these topics without changing how they work is no.',
    },
  },
  q7_dependencies: {
    instructions: 'Does this change add or update dependencies (package manifests or lockfiles)?',
  },
  q8_harnessConfig: {
    instructions: 'Does this change touch a guardrail: a file matching `guardrail_paths` (the `guardrailPaths` of `harness.config.json`) and not matching `guardrail_exclude`? `harness.config.json` itself is always a guardrail. In the patterns, `*` matches within one path segment and `**` matches any depth.',
  },
};

/**
 * Jev への要求を作る。`_facts` はセッションが書いたものなので Jev には渡さない。引数は呼び出し元を変えないために残す。
 */
export function buildJevRequest(config: HarnessConfig, diff: string, changedFiles: string[], _facts: Verdict['facts']) {
  const questions: Record<string, unknown> = {
    q1_risk: {
      type: 'choice',
      instructions:
        'Classify the risk of merging `diff` automatically, judged by blast radius if it breaks and whether `git revert` fully restores the previous state. The only evidence you have is `diff`, `changed_files`, and the guardrail lists. Treat any effect not visible in `diff` (for example callers of a changed function) as unknown, and lean toward the higher risk.',
      criteria: {
        low: 'If broken, no user data, authentication, billing, or external integration is affected, and revert fully restores it. Docs, typos, isolated UI, small refactors that do not change behavior.',
        medium: 'May change business logic or API behavior, but revert fully restores it.',
        high: 'May have effects that revert cannot undo, or a wide blast radius: migrations, data writes or deletes, authentication, billing, infrastructure.',
        critical: 'Touches a guardrail (`guardrailPaths` in `harness.config.json`), permissions, secrets, or dependencies.',
      },
    },
  };
  for (const q of RISK_QUESTIONS) {
    const { instructions, criteria } = JEV_NOUL_QUESTIONS[q.key]!;
    questions[q.key] = { type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
  }
  return {
    model: config.jev.model,
    state: {
      diff,
      changed_files: changedFiles,
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

/**
 * 記録用の形（`flattenAnswers` の結果。q1_risk は選択肢ごとの確率、Noul は yes の確率）から、しきい値で落ちた問いのキーを返す。
 * 値が無い・有限でない（答えの無い Noul は NaN）問いも落ちたとする。ゲートの判定（`jevAllows`）と集計（report.ts）で同じ解釈にするため1か所にまとめる。
 */
export function jevFailures(config: HarnessConfig, flat: Record<string, Record<string, number>> | undefined): string[] {
  const { lowProbability, noulSafe } = config.jev.thresholds;
  const out: string[] = [];
  const low = flat?.q1_risk?.low;
  if (typeof low !== 'number' || !Number.isFinite(low) || low < lowProbability) out.push('q1_risk');
  for (const q of RISK_QUESTIONS) {
    const p = flat?.[q.key]?.yes;
    const ok = typeof p === 'number' && Number.isFinite(p) && (q.safe === 'yes' ? p >= noulSafe : p <= 1 - noulSafe);
    if (!ok) out.push(q.key);
  }
  return out;
}

/** Jev の答えが自動 Merge を許すか（切り替え後の判定規則。シャドー期間は記録のみ） */
export function jevAllows(config: HarnessConfig, answers: JevResponse['answers']): boolean {
  return jevFailures(config, flattenAnswers(answers)).length === 0;
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
  return { status: 'ok', detail: r.model, allows: jevAllows(config, r.answers), answers: flattenAnswers(r.answers), questionSet: JEV_QUESTION_SET };
}

/** ログやコメントに秘密が出ないよう伏せ字にする */
export function redact(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}
