// 過去の PR の head を、PR の状態（closed・merged）・今の head・KV・月の累計・投稿を見ずに、Worker と同じ材料の集め方・問い・検査で問い直す replayReview。
// 材料集め（前回の shadow 記録は読まない）→ 見込み（Reviewer と Risk。比べる Risk は問わない）→ Reviewer → Risk → 検査 だけを行い、結果を値で返す（書くのは呼び出し元）。
// deps は GitHub の読み取り・Claude のクライアント・時計・ログ・秘密だけで、書き込みと KV は受け取らない。ログと返す値は redact を通す。例外は投げずに error の結果にする。
// import は review-api/src の中だけで（harness/lib・@anthropic-ai/sdk・cloudflare:workers・node: は import しない）、Node と Workers の両方で動く。
import { askWithTools, type MessagesClient } from './claude.ts';
import { collectMaterial } from './collect.ts';
import type { ReviewConfig } from './config.ts';
import type { Usage } from './cost.ts';
import { buildAskRequests, createToolRunner, estimateLoopUsd, sumUsage, usageUsd, validateAsks, type AskStep, type GitHubReader } from './pipeline.ts';
import type { RoleUsage, ShadowRecord } from './record.ts';
import { redact } from './redact.ts';
import { composeShadowVerdict } from './verdict.ts';

export interface ReplayDeps {
  github: { reader(): Promise<GitHubReader> };
  claude: MessagesClient;
  now(): number;
  log(line: string): void;
  /** ログと返す値から伏せる文字列（API キー・token など） */
  secrets?: string[];
}

export interface ReplayParams {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  gateAppLogin: string;
  config: ReviewConfig;
  remainingUsd: number;
}

export type ReplayResult = (
  | { outcome: 'reviewed'; record: ShadowRecord; estimatedUsd: number }
  | { outcome: 'over-budget'; estimatedUsd: number | null }
  | {
      outcome: 'invalid';
      detail: string;
      models: { review: string; risk: string };
      usage: Record<string, Usage>;
      usd: number | null;
      usageByRole: { review: RoleUsage; risk: RoleUsage };
      durationSec: number;
      estimatedUsd: number;
    }
  | { outcome: 'error'; stage: 'collect' | 'review' | 'risk'; detail: string; usage: Record<string, Usage>; usd: number | null; estimatedUsd: number | null }
) & { pr: number; headSha: string };

// 文字列・配列・オブジェクトをたどって、文字列をすべて redact する（JSON の文字列化を経由しない）
function redactDeep<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)])) as T;
  }
  return value;
}

export async function replayReview(deps: ReplayDeps, params: ReplayParams): Promise<ReplayResult> {
  const { owner, repo, pr, headSha, config } = params;
  const secrets = deps.secrets ?? [];
  const log = (line: string): void => deps.log(redact(line, secrets));
  const done = (r: ReplayResult): ReplayResult => redactDeep(r, secrets);
  const startedAt = deps.now();
  const roleUsage = (u: Record<string, Usage>): RoleUsage => ({ usage: u, usd: usageUsd(u, config.pricing) });
  const fail = (stage: 'collect' | 'review' | 'risk', e: unknown, usage: Record<string, Usage>, estimatedUsd: number | null): ReplayResult => {
    log(`replay error ${stage}`);
    const detail = e instanceof Error ? e.message : String(e);
    return done({ outcome: 'error', stage, detail, usage, usd: usageUsd(usage, config.pricing), estimatedUsd, pr, headSha });
  };

  // 1. collect（PR の state と今の head は見ない。diff は base...headSha なので古い head でもその PR の差分になる）
  let gh: GitHubReader;
  let material: Awaited<ReturnType<typeof collectMaterial>>;
  try {
    gh = await deps.github.reader();
    material = await collectMaterial(gh, config, { owner, repo, pr, headSha, appLogin: params.gateAppLogin, previous: false });
  } catch (e) {
    return fail('collect', e, {}, null);
  }
  log('replay collect ok');

  // 2. budget（Reviewer と Risk の見込みの和。ちょうど同じ額は通す）
  const asks = buildAskRequests(material, config);
  const limits = { maxToolCalls: config.claude.maxToolCalls, maxFileChars: config.claude.maxFileChars };
  const a = estimateLoopUsd(asks.review, limits, config.pricing);
  const b = estimateLoopUsd(asks.risk, limits, config.pricing);
  const estimatedUsd = a === null || b === null ? null : a + b;
  const remaining = params.remainingUsd;
  if (estimatedUsd === null || !(Number.isFinite(remaining) && remaining >= 0) || estimatedUsd > remaining) {
    log(`replay budget over estimated=${estimatedUsd}`);
    return done({ outcome: 'over-budget', estimatedUsd, pr, headSha });
  }
  log(`replay budget ok estimated=${estimatedUsd}`);

  const runner = createToolRunner(gh, headSha, config.claude.maxFileChars);

  // 3. review
  let review: AskStep;
  try {
    review = { skipped: false, result: await askWithTools(deps.claude, asks.review, runner, config.claude.maxToolCalls) };
  } catch (e) {
    return fail('review', e, {}, estimatedUsd);
  }
  log(`replay review ${review.skipped ? 'skipped' : review.result.ok ? 'ok' : review.result.reason}`);

  // 4. risk（review が失敗なら呼ばない）
  let risk: AskStep;
  if (!review.skipped && !review.result.ok) risk = { skipped: true };
  else {
    try {
      risk = { skipped: false, result: await askWithTools(deps.claude, asks.risk, runner, config.claude.maxToolCalls) };
    } catch (e) {
      return fail('risk', e, review.skipped ? {} : review.result.usage, estimatedUsd);
    }
  }
  log(`replay risk ${risk.skipped ? 'skipped' : risk.result.ok ? 'ok' : risk.result.reason}`);

  // 5. validate
  const validated = validateAsks(review, risk);
  log(`replay validate ${validated.ok ? 'ok' : 'invalid'}`);
  const roleOf = (s: AskStep): Record<string, Usage> => (s.skipped ? {} : s.result.usage);
  const usage = sumUsage(roleOf(review), roleOf(risk));
  const usd = usageUsd(usage, config.pricing);
  const usageByRole = { review: roleUsage(roleOf(review)), risk: roleUsage(roleOf(risk)) };
  const models = { review: asks.models.review, risk: asks.models.risk };
  const durationSec = Math.round((deps.now() - startedAt) / 1000);
  if (!validated.ok) {
    return done({ outcome: 'invalid', detail: validated.detail, models, usage, usd, usageByRole, durationSec, estimatedUsd, pr, headSha });
  }
  const record: ShadowRecord = {
    version: 1,
    pr,
    headSha,
    verdict: composeShadowVerdict({ pr, headSha, reviewer: validated.reviewer, risk: validated.riskOut, model: models.review }),
    models,
    usage,
    usd,
    durationSec,
    usageByRole,
  };
  return done({ outcome: 'reviewed', record, estimatedUsd, pr, headSha });
}
