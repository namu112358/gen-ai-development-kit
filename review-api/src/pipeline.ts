// レビューの段階（最初に settle で trigger.settleSeconds 秒だけ待つ）fetch-pr → collect → budget → review → risk → validate → risk-compare → record → post（止めたときは record の後に post-stopped）を順に呼ぶ runReview と、Claude に渡すツールの実行 createToolRunner。
// GitHub・Claude・KV・時計・ログは deps から受け取り、token は deps の作り方（reader・writer）の中に閉じる（ここでは見ない）。
// 段階は runStep に包んで呼ぶ（Workflow が step.do を渡す）。KV の書き込みと投稿は、その段階の中で行う。
// risk-compare は Reviewer と Risk のモデルが違うとき、Risk を Reviewer のモデルでも問う（記録だけで判定には使わない。失敗しても verdict と outcome は変えない）。
// 問いの組み立て buildAskRequests・出力の検査 validateAsks・使用量の和 sumUsage・USD の計算 usageUsd は replay.ts も使う。
// import は review-api/src の中だけで、Node と Workers の両方で動く。
import { askWithTools, type AskResult, type MessagesClient, type MessagesParams, type ToolRunner } from './claude.ts';
import { collectMaterial, type Material } from './collect.ts';
import type { ModelPricing, ReviewConfig } from './config.ts';
import { checkBudget, estimateUsd, monthKey, type Usage } from './cost.ts';
import type { GitHubClient } from './github.ts';
import {
  REVIEW_TOOLS,
  REVIEWER_OUTPUT_SCHEMA,
  RISK_OUTPUT_SCHEMA,
  buildReviewerMessages,
  buildRiskMessages,
  systemFor,
  isSecretPath,
} from './prompts.ts';
import { parseApiReviewComment, renderShadowComment, renderStoppedComment, type RiskCompareRecord, type RoleUsage, type RulesSummary, type ShadowRecord, type StoppedOutcome } from './record.ts';
import type { RepositoryRules } from './rules.ts';
import { redact } from './redact.ts';
import { wrapUntrusted } from './untrusted.ts';
import { checkReviewerOutput, checkRiskOutput, composeShadowVerdict, type ReviewerOutput, type RiskOutput } from './verdict.ts';

export type StepName = 'fetch-pr' | 'collect' | 'budget' | 'review' | 'risk' | 'validate' | 'risk-compare' | 'record' | 'post' | 'post-stopped';
export type RunStep = <T>(name: StepName, fn: () => Promise<T>) => Promise<T>;
export type ReviewOutcome = 'superseded' | 'closed' | 'duplicate' | 'budget-exceeded' | 'too-large' | 'verdict-invalid' | 'posted';

export type GitHubReader = Pick<GitHubClient, 'getPr' | 'getIssue' | 'listComments' | 'compareDiff' | 'getFileContent' | 'getTree'>;
export type GitHubWriter = Pick<GitHubClient, 'createComment'>;

export interface ReviewKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface ReviewDeps {
  github: { reader(): Promise<GitHubReader>; writer(): Promise<GitHubWriter> };
  claude: MessagesClient;
  kv: ReviewKv;
  now(): number;
  log(line: string): void;
  /** push が続くあいだ待つ（Workflow は step.sleep）。無ければ待たない */
  sleep?(ms: number): Promise<void>;
  /** ログと投稿の本文から伏せる文字列（API キー・Webhook の秘密など） */
  secrets?: string[];
  /** Claude の代わりに固定の JSON を使っているか（Workflow の DRY_RUN=1）。記録の dryRun に入れる */
  dryRun?: boolean;
}

export interface ReviewParams {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  gateAppLogin: string;
  reviewAppLogin: string;
  config: ReviewConfig;
}

export interface ReviewResult {
  outcome: ReviewOutcome;
  pr: number;
  headSha: string;
  usd: number | null;
}

const MAX_LISTED = 1000;

export function reviewKey(owner: string, repo: string, pr: number, sha: string): string {
  return `review:${owner}/${repo}:${pr}:${sha}`;
}

export function costKey(date: Date): string {
  return `cost:${monthKey(date)}`;
}

/** tool_result 1 件の見込みのトークン数の上限（ファイルの中身は maxFileChars より小さいことが多い。4000 トークン ≒ 8000 文字） */
const TOOL_RESULT_TOKENS = 4000;
/** 1 回の問いの出力の見込み（thinking を含む。maxTokens は上限なので見積もりには使わない） */
const OUTPUT_TOKENS_PER_CALL = 2000;

/**
 * ツールのループを考慮した 1 問いの推定料金（Issue #960）。材料のトークン m は system・tools・messages の文字数の半分（切り上げ）。
 * breakpoint を付けた材料と各回の tool_result は cacheWrite5m、前の回までの分は cacheRead で数える（input は 0。同じトークンを二重に数えない）。
 * 1 回目：cacheWrite5m m・output 2000。k 回目（k = 1..maxToolCalls）：cacheRead m + (k−1)·t・cacheWrite5m t・output 2000（t = min(ceil(maxFileChars/2), 4000)）。
 * Risk が Reviewer のキャッシュを読む分は見込まない（安全側）。モデルが読めない・単価が無ければ null
 */
export function estimateLoopUsd(
  params: MessagesParams,
  limits: { maxToolCalls: number; maxFileChars: number },
  pricing: Record<string, ModelPricing>,
): number | null {
  const model = params['model'];
  if (typeof model !== 'string') return null;
  const chars = JSON.stringify({ system: params['system'], tools: params['tools'], messages: params.messages }).length;
  const m = Math.ceil(chars / 2);
  const t = Math.min(Math.ceil(limits.maxFileChars / 2), TOOL_RESULT_TOKENS);
  const usage: Usage = { input: 0, output: OUTPUT_TOKENS_PER_CALL, cacheWrite5m: m, cacheWrite1h: 0, cacheRead: 0 };
  for (let k = 1; k <= limits.maxToolCalls; k++) {
    usage.cacheRead += m + (k - 1) * t;
    usage.cacheWrite5m += t;
    usage.output += OUTPUT_TOKENS_PER_CALL;
  }
  return estimateUsd(usage, model, pricing);
}

type ToolResult = { content: string; isError?: boolean };

function safePath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

// 変更ファイルが全部 docsOnly.extensions に当たる PR だけ文書用のモデルにする。切り詰め・読めないパス・空の diff はコード扱い。
export function chooseModels(
  material: Pick<Material, 'diff' | 'diffTruncated'>,
  claude: ReviewConfig['claude'],
): { review: string; risk: string; docsOnly: boolean } {
  const code = { review: claude.reviewModel, risk: claude.riskModel, docsOnly: false };
  const docs = claude.docsOnly;
  if (docs === undefined || material.diffTruncated) return code;
  const paths: string[] = [];
  for (const line of material.diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line.replace(/\r$/, ''));
    if (m === null) return code;
    paths.push(m[1]!, m[2]!);
  }
  if (paths.length === 0) return code;
  const exts = docs.extensions.map((e) => e.toLowerCase());
  if (!paths.every((p) => exts.some((e) => p.toLowerCase().endsWith(e)))) return code;
  return { review: docs.model, risk: docs.model, docsOnly: true };
}

/** read_file・list_files の実行。秘密の恐れがあるパスと外に出るパスは GitHub に問わない */
export function createToolRunner(gh: GitHubReader, headSha: string, maxFileChars: number): ToolRunner {
  let tree: Awaited<ReturnType<GitHubReader['getTree']>> | null = null;
  const err = (content: string): ToolResult => ({ content, isError: true });
  return async ({ name, input }) => {
    const obj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    if (name === 'read_file') {
      const path = obj['path'];
      if (!safePath(path)) return err('path はリポジトリのルートからの相対パスで指定してください');
      if (isSecretPath(path)) return err('秘密の恐れがあるため読めません');
      const content = await gh.getFileContent(path, headSha);
      if (content === null) return err('ファイルがありません');
      const cut = content.length > maxFileChars;
      const body = wrapUntrusted('file', content.slice(0, maxFileChars));
      return { content: cut ? `${body}\n（${maxFileChars} 文字で切りました）` : body };
    }
    if (name === 'list_files') {
      const prefix = obj['prefix'];
      if (typeof prefix !== 'string') return err('prefix は文字列で指定してください');
      tree ??= await gh.getTree(headSha);
      const paths = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && !isSecretPath(e.path)).map((e) => e.path);
      const shown = paths.slice(0, MAX_LISTED);
      const notes: string[] = [];
      if (paths.length > MAX_LISTED) notes.push(`${MAX_LISTED} 件を超える分は省きました`);
      if (tree.truncated) notes.push('ツリーが大きく、一部だけです');
      return { content: [...shown, ...notes.map((n) => `（${n}）`)].join('\n') };
    }
    return err(`知らないツール: ${name}`);
  };
}

function hasOwnRecord(comments: { body: string; user: { login: string } | null }[], login: string, headSha: string): boolean {
  return comments.some((c) => c.user?.login === login && parseApiReviewComment(c.body)?.headSha === headSha);
}

export function sumUsage(...parts: Record<string, Usage>[]): Record<string, Usage> {
  const out: Record<string, Usage> = {};
  for (const part of parts) {
    for (const [model, u] of Object.entries(part)) {
      const cur = (out[model] ??= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
      cur.input += u.input;
      cur.output += u.output;
      cur.cacheWrite5m += u.cacheWrite5m;
      cur.cacheWrite1h += u.cacheWrite1h;
      cur.cacheRead += u.cacheRead;
    }
  }
  return out;
}

export type AskStep = { skipped: true } | { skipped: false; result: AskResult };

/** モデルごとの使用量の推定 USD（小数6桁で丸める）。空なら 0、単価の無いモデルが1つでもあれば null */
export function usageUsd(usage: Record<string, Usage>, pricing: Record<string, ModelPricing>): number | null {
  let usd = 0;
  for (const [model, v] of Object.entries(usage)) {
    const e = estimateUsd(v, model, pricing);
    if (e === null) return null;
    usd += e;
  }
  return Math.round(usd * 1e6) / 1e6;
}

export interface AskRequests {
  models: { review: string; risk: string; docsOnly: boolean };
  review: MessagesParams;
  risk: MessagesParams;
  /** 比べる問い：Risk と同じ材料・出力の形・ツールで、モデルだけ Reviewer のもの。riskCompare が false か、Reviewer と Risk のモデルが同じなら null */
  riskCompare: MessagesParams | null;
}

/** 記録に残す規則の要約（本文は入れない） */
export function rulesSummary(rules: RepositoryRules): RulesSummary {
  return { status: rules.status, paths: rules.files.map((f) => f.path), chars: rules.chars, skipped: rules.skipped };
}

/** Reviewer・Risk（と比べる Risk）の問いを組む。system は規則があれば2ブロック（systemFor） */
export function buildAskRequests(material: Material, config: Pick<ReviewConfig, 'claude'>): AskRequests {
  const claude = config.claude;
  const models = chooseModels(material, claude);
  const request = (model: string, messages: MessagesParams['messages'], schema: unknown): MessagesParams => ({
    model,
    max_tokens: claude.maxTokens,
    system: systemFor(material.rules),
    tools: REVIEW_TOOLS,
    messages,
    output_config: { effort: claude.effort, format: { type: 'json_schema', schema } },
  });
  const compareEnabled = claude.riskCompare !== false && models.review !== models.risk;
  return {
    models,
    review: request(models.review, buildReviewerMessages(material), REVIEWER_OUTPUT_SCHEMA),
    risk: request(models.risk, buildRiskMessages(material), RISK_OUTPUT_SCHEMA),
    riskCompare: compareEnabled ? request(models.review, buildRiskMessages(material), RISK_OUTPUT_SCHEMA) : null,
  };
}

/** Reviewer と Risk の結果を検査する（失敗・飛ばした・形が合わないときは detail を返す） */
export function validateAsks(review: AskStep, risk: AskStep): { ok: true; reviewer: ReviewerOutput; riskOut: RiskOutput } | { ok: false; detail: string } {
  if (review.skipped || !review.result.ok) return { ok: false, detail: review.skipped ? 'review-skipped' : `review:${(review.result as { reason: string }).reason}` };
  if (risk.skipped || !risk.result.ok) return { ok: false, detail: risk.skipped ? 'risk-skipped' : `risk:${(risk.result as { reason: string }).reason}` };
  const r = checkReviewerOutput(review.result.value);
  if (!r.ok) return { ok: false, detail: `review:invalid(${r.errors.length})` };
  const k = checkRiskOutput(risk.result.value);
  if (!k.ok) return { ok: false, detail: `risk:invalid(${k.errors.length})` };
  return { ok: true, reviewer: r.value, riskOut: k.value };
}

export async function runReview(deps: ReviewDeps, params: ReviewParams, runStep?: RunStep): Promise<ReviewResult> {
  const step: RunStep = runStep ?? ((_name, fn) => fn());
  const { owner, repo, pr, headSha, config } = params;
  const secrets = deps.secrets ?? [];
  const log = (line: string): void => deps.log(redact(line, secrets));
  const key = reviewKey(owner, repo, pr, headSha);
  const result = (outcome: ReviewOutcome, usd: number | null = null): ReviewResult => ({ outcome, pr, headSha, usd });

  // duplicate は既にある記録を消さない
  const writeRecord = async (outcome: ReviewOutcome, extra: Record<string, unknown>): Promise<void> => {
    if (outcome === 'duplicate' && (await deps.kv.get(key)) !== null) return;
    await deps.kv.put(key, JSON.stringify({ version: 1, outcome, pr, headSha, at: new Date(deps.now()).toISOString(), ...extra }));
  };
  const stopStep = async (name: StepName, outcome: ReviewOutcome): Promise<ReviewResult> => {
    log(`${name} ${outcome}`);
    return result(outcome);
  };

  // 止めた記録（post-stopped）：head が同じ・open・同じ head の自分の記録が無いときだけ1件投稿する。失敗しても outcome・KV・戻り値は変えない
  const postStopped = async (outcome: StoppedOutcome, fields: { usd: number | null; estimatedUsd?: number }): Promise<void> => {
    try {
      const done = await step('post-stopped', async (): Promise<boolean> => {
        const gh = await deps.github.reader();
        const found = await gh.getPr(pr);
        if (found.head.sha !== headSha || found.state !== 'open') return false;
        if (hasOwnRecord(await gh.listComments(pr), params.reviewAppLogin, headSha)) return false;
        const body = redact(
          renderStoppedComment({
            version: 1,
            pr,
            headSha,
            outcome,
            usd: fields.usd,
            ...(fields.estimatedUsd === undefined ? {} : { estimatedUsd: fields.estimatedUsd }),
          }),
          secrets,
        );
        await (await deps.github.writer()).createComment(pr, body);
        return true;
      });
      log(done ? `post-stopped ${outcome}` : 'post-stopped skipped');
    } catch {
      log('post-stopped error');
    }
  };

  // 0. settle（待っている間に head が変われば、次の fetch-pr で superseded になる）
  if (config.trigger.settleSeconds > 0 && deps.sleep !== undefined) {
    await deps.sleep(config.trigger.settleSeconds * 1000);
    log(`settle ${config.trigger.settleSeconds}s`);
  }

  // 1. fetch-pr
  const fetched = await step('fetch-pr', async (): Promise<{ startedAt: number; stop: ReviewOutcome | null }> => {
    const startedAt = deps.now();
    const gh = await deps.github.reader();
    const found = await gh.getPr(pr);
    let stop: ReviewOutcome | null = null;
    if (found.head.sha !== headSha) stop = 'superseded';
    else if (found.state !== 'open') stop = 'closed';
    else if ((await deps.kv.get(key)) !== null) stop = 'duplicate';
    else if (hasOwnRecord(await gh.listComments(pr), params.reviewAppLogin, headSha)) stop = 'duplicate';
    if (stop !== null) await writeRecord(stop, {});
    return { startedAt, stop };
  });
  if (fetched.stop !== null) return stopStep('fetch-pr', fetched.stop);
  log('fetch-pr ok');

  // 2. collect
  const material = await step('collect', async (): Promise<Material> => {
    const gh = await deps.github.reader();
    return collectMaterial(gh, config, { owner, repo, pr, headSha, appLogin: params.gateAppLogin, reviewLogin: params.reviewAppLogin });
  });
  log(`collect ok rules=${material.rules.status}`);
  const rules = rulesSummary(material.rules);
  const asks = buildAskRequests(material, config);
  const models = asks.models;
  log(`models review=${models.review} risk=${models.risk}`);

  const month = costKey(new Date(deps.now()));
  const usdOf = (u: Record<string, Usage>): number | null => usageUsd(u, config.pricing);
  const roleUsage = (u: Record<string, Usage>): RoleUsage => ({ usage: u, usd: usdOf(u) });

  // 3. budget
  const budget = await step('budget', async (): Promise<{ stop: ReviewOutcome | null; compare: 'run' | 'budget' | null; estimatedUsd?: number }> => {
    log(`budget limits monthlyUsd=${config.budget.monthlyUsd} perReviewUsd=${config.budget.perReviewUsd}`);
    // 上限が有限の正の数でない（ダッシュボードの変数が読めなかった）と checkBudget の比べが偽になって通るので、先に止める
    const badLimits = (['monthlyUsd', 'perReviewUsd'] as const).filter((k) => !(Number.isFinite(config.budget[k]) && config.budget[k] > 0));
    if (badLimits.length > 0) {
      log(`budget invalid ${badLimits.join(',')}`);
      await writeRecord('budget-exceeded', { budgetInvalid: true, rules });
      return { stop: 'budget-exceeded', compare: null };
    }
    const raw = await deps.kv.get(month);
    const monthUsd = raw === null ? 0 : raw.trim() === '' ? NaN : Number(raw);
    const limits = { maxToolCalls: config.claude.maxToolCalls, maxFileChars: config.claude.maxFileChars };
    const a = estimateLoopUsd(asks.review, limits, config.pricing);
    const b = estimateLoopUsd(asks.risk, limits, config.pricing);
    let outcome: ReviewOutcome | null = null;
    if (!Number.isFinite(monthUsd) || monthUsd < 0 || a === null || b === null) outcome = 'budget-exceeded';
    else {
      const checked = checkBudget({ monthUsd, estimatedUsd: a + b, budget: config.budget });
      if (!checked.ok) outcome = checked.reason;
    }
    if (outcome !== null) {
      await writeRecord(outcome, { rules });
      return { stop: outcome, compare: null, ...(a === null || b === null ? {} : { estimatedUsd: a + b }) };
    }
    if (asks.riskCompare === null) return { stop: null, compare: null };
    // 比べる分を足しても上限に収まるときだけ比べる（収まらなければ比べる問いだけ飛ばす）
    const c = estimateLoopUsd(asks.riskCompare, limits, config.pricing);
    const withCompare = c === null ? null : checkBudget({ monthUsd, estimatedUsd: a! + b! + c, budget: config.budget });
    return { stop: null, compare: withCompare !== null && withCompare.ok ? 'run' : 'budget' };
  });
  if (budget.stop !== null) {
    const stopped = await stopStep('budget', budget.stop);
    if (budget.stop === 'budget-exceeded' || budget.stop === 'too-large') {
      await postStopped(budget.stop, { usd: null, ...(budget.estimatedUsd === undefined ? {} : { estimatedUsd: budget.estimatedUsd }) });
    }
    return stopped;
  }
  log(`budget ok${budget.compare === null ? '' : ` compare=${budget.compare}`}`);

  const toolRunner = async (): Promise<ToolRunner> => createToolRunner(await deps.github.reader(), headSha, config.claude.maxFileChars);

  // 4. review
  const review = await step('review', async (): Promise<AskStep> => {
    const r = await askWithTools(deps.claude, asks.review, await toolRunner(), config.claude.maxToolCalls);
    return { skipped: false, result: r };
  });
  log(`review ${review.skipped ? 'skipped' : review.result.ok ? 'ok' : review.result.reason}`);

  // 5. risk（review が失敗なら呼ばない）
  const risk = await step('risk', async (): Promise<AskStep> => {
    if (!review.skipped && !review.result.ok) return { skipped: true };
    const r = await askWithTools(deps.claude, asks.risk, await toolRunner(), config.claude.maxToolCalls);
    return { skipped: false, result: r };
  });
  log(`risk ${risk.skipped ? 'skipped' : risk.result.ok ? 'ok' : risk.result.reason}`);

  // 6. validate
  const validated = await step(
    'validate',
    async (): Promise<{ ok: true; reviewer: ReviewerOutput; riskOut: RiskOutput } | { ok: false; detail: string }> => validateAsks(review, risk),
  );
  log(`validate ${validated.ok ? 'ok' : 'invalid'}`);

  // 6b. risk-compare（compare が null なら呼ばない。結果は budget の戻り値だけで決める）
  // step.do が再試行を使い切って投げても、ここで受け止めれば run は続けられるので、判定と outcome は変わらない
  let compared: { record: RiskCompareRecord; usage: Record<string, Usage> } | null = null;
  if (budget.compare !== null) {
    const model = models.review;
    try {
      compared = await step('risk-compare', async () => {
        if (budget.compare === 'budget') return { record: { model, skipped: 'budget' }, usage: {} };
        if (!validated.ok) return { record: { model, skipped: 'not-validated' }, usage: {} };
        const r = await askWithTools(deps.claude, asks.riskCompare!, await toolRunner(), config.claude.maxToolCalls);
        if (!r.ok) return { record: { model, error: r.reason }, usage: r.usage };
        const k = checkRiskOutput(r.value);
        if (!k.ok) return { record: { model, error: `invalid(${k.errors.length})` }, usage: r.usage };
        return { record: { model, level: k.value.level, answers: k.value.answers, usd: usdOf(r.usage) }, usage: r.usage };
      });
    } catch {
      log('risk-compare api-error');
      compared = { record: { model, error: 'api-error' }, usage: {} };
    }
    const rc = compared.record;
    log(`risk-compare ${'skipped' in rc ? `skipped ${rc.skipped}` : 'error' in rc ? rc.error : 'ok'}`);
  }

  // 7. record
  const roleOf = (s: AskStep): Record<string, Usage> => (s.skipped ? {} : s.result.usage);
  const usage = sumUsage(roleOf(review), roleOf(risk), compared?.usage ?? {});
  const compareFields = {
    usageByRole: {
      review: roleUsage(roleOf(review)),
      risk: roleUsage(roleOf(risk)),
      ...(compared !== null ? { riskCompare: roleUsage(compared.usage) } : {}),
    },
    ...(compared !== null ? { riskCompare: compared.record } : {}),
  };
  const recorded = await step('record', async (): Promise<{ usd: number | null; body: string | null; durationSec: number }> => {
    const usd = usdOf(usage);
    let add = 0;
    for (const [model, u] of Object.entries(usage)) add += estimateUsd(u, model, config.pricing) ?? 0;
    if (Object.keys(usage).length > 0) {
      const raw = await deps.kv.get(month);
      const cur = raw === null || raw.trim() === '' || !Number.isFinite(Number(raw)) ? 0 : Number(raw);
      await deps.kv.put(month, String(Math.round((cur + add) * 1e6) / 1e6));
    }
    const durationSec = Math.round((deps.now() - fetched.startedAt) / 1000);
    if (!validated.ok) {
      await writeRecord('verdict-invalid', { durationSec, models: { review: models.review, risk: models.risk }, usage, usd, detail: validated.detail, ...compareFields, rules });
      return { usd, body: null, durationSec };
    }
    const record: ShadowRecord = {
      version: 1,
      pr,
      headSha,
      verdict: composeShadowVerdict({ pr, headSha, reviewer: validated.reviewer, risk: validated.riskOut, model: models.review }),
      models: { review: models.review, risk: models.risk },
      usage,
      usd,
      durationSec,
      ...compareFields,
      rules,
      diffTruncated: material.diffTruncated,
      dryRun: deps.dryRun === true,
    };
    return { usd, body: redact(renderShadowComment(record), secrets), durationSec };
  });
  log(`record ${validated.ok ? 'ok' : 'verdict-invalid'} usd=${recorded.usd}`);
  if (!validated.ok || recorded.body === null) {
    await postStopped('verdict-invalid', { usd: recorded.usd });
    return result('verdict-invalid', recorded.usd);
  }

  // 8. post
  const body = recorded.body;
  const posted = await step('post', async (): Promise<ReviewOutcome> => {
    const gh = await deps.github.reader();
    const found = await gh.getPr(pr);
    let outcome: ReviewOutcome | null = null;
    if (found.head.sha !== headSha) outcome = 'superseded';
    else if (found.state !== 'open') outcome = 'closed';
    else if (hasOwnRecord(await gh.listComments(pr), params.reviewAppLogin, headSha)) outcome = 'duplicate';
    const extra = { durationSec: recorded.durationSec, models: { review: models.review, risk: models.risk }, usage, usd: recorded.usd, ...compareFields, rules };
    if (outcome !== null) {
      await writeRecord(outcome, extra);
      return outcome;
    }
    await (await deps.github.writer()).createComment(pr, body);
    await writeRecord('posted', {
      ...extra,
      summary: { pass: validated.reviewer.pass, blocking: validated.reviewer.blocking.length, riskLevel: validated.riskOut.level },
    });
    return 'posted';
  });
  log(`post ${posted} usd=${recorded.usd}`);
  return result(posted, recorded.usd);
}
