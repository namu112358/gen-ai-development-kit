// レビューの段階（最初に settle で trigger.settleSeconds 秒だけ待つ。待つのは action が trigger.settleActions にあるか、action の無い古い params のときだけ）fetch-pr → same-patch（前回レビューした head と PR 自身の差分が同じなら、Claude を呼ばずに終える。Issue #1089）→ collect → budget → review と risk（Risk は Reviewer の最初の応答の後に始め、並べて待つ）→ validate → risk-compare → record → post（止めたときは record の後に post-stopped）を順に呼ぶ runReview と、Claude に渡すツールの実行 createToolRunner。
// リポジトリの表（repos.ts）の行から Claude のクライアント・設定・伏せる秘密を組む prepareRepoReview（Workflow が使う）。行に Claude のキーが無ければ deps.claude は null で、fetch-pr の後に no-api-key で止める。
// 月の累計は cost:<owner>/<repo>:<YYYY-MM>（小文字）でリポジトリごとに数え、上限は行の上書き済みの config.budget で見る。KV の記録・ログ・コメントは deps.secrets で伏せる。
// GitHub・Claude・KV・時計・ログは deps から受け取り、token は deps の作り方（reader・writer）の中に閉じる（ここでは見ない）。
// 段階は runStep に包んで呼ぶ（Workflow が step.do を渡す）。KV の書き込みと投稿は、その段階の中で行う。
// risk-compare は Reviewer と Risk のモデルが違うとき、Risk を Reviewer のモデルでも問う（記録だけで判定には使わない。失敗しても verdict と outcome は変えない）。
// 問いの組み立て buildAskRequests・出力の検査 validateAsks・使用量の和 sumUsage・USD の計算 usageUsd は replay.ts も使う。
// import は review-api/src の中だけで、Node と Workers の両方で動く。
import { askWithTools, type AskResult, type MessagesClient, type MessagesParams, type ToolRunner } from './claude.ts';
import { collectMaterial, type Material } from './collect.ts';
import { applyRepoOverrides, DEFAULT_SETTLE_ACTIONS, type BudgetEnv, type ModelPricing, type ReviewConfig } from './config.ts';
import { checkBudget, estimateUsd, monthKey, type Usage } from './cost.ts';
import type { GitHubClient, IssueComment } from './github.ts';
import {
  REVIEW_TOOLS,
  OUTPUT_SCHEMA,
  buildReviewerMessages,
  buildRiskMessages,
  systemFor,
  isSecretPath,
} from './prompts.ts';
import { parseApiReviewComment, renderShadowComment, renderStoppedComment, type RiskCompareRecord, type RoleUsage, type RulesSummary, type ShadowRecord, type StoppedOutcome } from './record.ts';
import type { RepositoryRules } from './rules.ts';
import { redact } from './redact.ts';
import { collectSecrets, parseRepoTable, resolveRepoRuntime, type RepoEnv, type RepoRuntime } from './repos.ts';
import { wrapUntrusted } from './untrusted.ts';
import { checkReviewerOutput, checkRiskOutput, composeShadowVerdict, type ReviewerOutput, type RiskOutput } from './verdict.ts';

export type StepName = 'fetch-pr' | 'same-patch' | 'collect' | 'budget' | 'review' | 'risk' | 'validate' | 'risk-compare' | 'record' | 'record-cost' | 'post' | 'post-stopped';
export type RunStep = <T>(name: StepName, fn: () => Promise<T>) => Promise<T>;
export type ReviewOutcome = 'superseded' | 'closed' | 'duplicate' | 'same-patch' | 'no-api-key' | 'budget-exceeded' | 'too-large' | 'verdict-invalid' | 'posted';

export type GitHubReader = Pick<GitHubClient, 'getPr' | 'getIssue' | 'listComments' | 'compareDiff' | 'getFileContent' | 'getTree'>;
export type GitHubWriter = Pick<GitHubClient, 'createComment'>;

export interface ReviewKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface ReviewDeps {
  github: { reader(): Promise<GitHubReader>; writer(): Promise<GitHubWriter> };
  /** null はリポジトリの行に Claude のキーが無い（Claude を呼ばずに no-api-key で止める） */
  claude: MessagesClient | null;
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
  /** Webhook の action。古い形の Workflow の params には無い（そのときは待つ） */
  action?: string;
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

/** settle で待つか。action が無い（古い形の params）なら待つ */
export function shouldSettle(trigger: Pick<ReviewConfig['trigger'], 'settleActions'>, action: string | undefined): boolean {
  if (action === undefined) return true;
  return (trigger.settleActions ?? DEFAULT_SETTLE_ACTIONS).includes(action);
}

export function reviewKey(owner: string, repo: string, pr: number, sha: string): string {
  return `review:${owner}/${repo}:${pr}:${sha}`;
}

/** 月の累計の鍵。リポジトリごとに分ける（owner/repo は小文字） */
export function costKey(owner: string, repo: string, date: Date): string {
  return `cost:${owner.toLowerCase()}/${repo.toLowerCase()}:${monthKey(date)}`;
}

export type RepoReviewSetup =
  | { ok: false; reason: 'repo-table-invalid' | 'not-in-table' | 'repo-row-incomplete'; errors: string[] }
  | { ok: true; runtime: RepoRuntime; claude: MessagesClient | null; config: ReviewConfig; invalid: string[]; secrets: string[] };

/**
 * リポジトリの表の行だけから、レビューの Claude のクライアント・設定・伏せる秘密を組む（ほかの行の値は使わない）。
 * 表が壊れている・表に無い・行の login・installationId・clientId が空なら ok: false（errors は項目の名前とパスだけで、値は入れない）。
 * DRY_RUN=1 ならキーを見ずに dryRun のクライアント、行のキーが空なら claude は null。secrets は表のすべての行の秘密
 */
export function prepareRepoReview(
  env: RepoEnv & BudgetEnv & { DRY_RUN?: string },
  baseConfig: ReviewConfig,
  fullName: string,
  clients: { dryRun(): MessagesClient; anthropic(apiKey: string): MessagesClient },
): RepoReviewSetup {
  const parsed = parseRepoTable(env);
  if (parsed.errors.length > 0) return { ok: false, reason: 'repo-table-invalid', errors: parsed.errors };
  const runtime = resolveRepoRuntime(env, parsed.table, fullName);
  if (runtime === null) return { ok: false, reason: 'not-in-table', errors: [] };
  const required = { gateAppLogin: runtime.gateAppLogin, reviewAppLogin: runtime.reviewAppLogin, installationId: runtime.installationId, clientId: runtime.clientId };
  const missing = Object.entries(required).filter(([, v]) => v.trim() === '').map(([k]) => k);
  if (missing.length > 0) return { ok: false, reason: 'repo-row-incomplete', errors: missing };
  const apiKey = runtime.anthropicKey.trim();
  const claude = env.DRY_RUN === '1' ? clients.dryRun() : apiKey === '' ? null : clients.anthropic(apiKey);
  const { config, invalid } = applyRepoOverrides(baseConfig, runtime.overrides, env);
  return { ok: true, runtime, claude, config, invalid, secrets: collectSecrets(env, parsed.table) };
}

/** tool_result 1 件の見込みのトークン数の上限（ファイルの中身は maxFileChars より小さいことが多い。4000 トークン ≒ 8000 文字） */
const TOOL_RESULT_TOKENS = 4000;
/** 1 回の問いの出力の見込み（thinking を含む。maxTokens は上限なので見積もりには使わない） */
const OUTPUT_TOKENS_PER_CALL = 2000;

/**
 * ツールのループを考慮した 1 問いの推定料金（Issue #960）。材料のトークン m は system・tools・messages の文字数の半分（切り上げ）。
 * breakpoint を付けた材料と各回の tool_result は cacheWrite5m、前の回までの分は cacheRead で数える（input は 0。同じトークンを二重に数えない）。
 * 1 回目：cacheWrite5m m・output 2000。k 回目（k = 1..maxToolCalls）：cacheRead m + (k−1)·t・cacheWrite5m t・output 2000（t = min(ceil(maxFileChars/2), 4000)）。
 * cachedTokens は、1 回目の問いで材料 m のうち既にキャッシュにある分（cacheRead で数え、残り m − cachedTokens を cacheWrite5m で数える）。
 * Risk は Reviewer の最初の応答の後に始めるので、Reviewer と共有する接頭辞（sharedPrefixTokens）を渡す（Issue #1061）。モデルが読めない・単価が無ければ null
 */
export function estimateLoopUsd(
  params: MessagesParams,
  limits: { maxToolCalls: number; maxFileChars: number },
  pricing: Record<string, ModelPricing>,
  cachedTokens = 0,
): number | null {
  const model = params['model'];
  if (typeof model !== 'string') return null;
  const chars = JSON.stringify({ system: params['system'], tools: params['tools'], messages: params.messages }).length;
  const m = Math.ceil(chars / 2);
  const t = Math.min(Math.ceil(limits.maxFileChars / 2), TOOL_RESULT_TOKENS);
  const cached = Math.min(Math.max(cachedTokens, 0), m);
  const usage: Usage = { input: 0, output: OUTPUT_TOKENS_PER_CALL, cacheWrite5m: m - cached, cacheWrite1h: 0, cacheRead: cached };
  for (let k = 1; k <= limits.maxToolCalls; k++) {
    usage.cacheRead += m + (k - 1) * t;
    usage.cacheWrite5m += t;
    usage.output += OUTPUT_TOKENS_PER_CALL;
  }
  return estimateUsd(usage, model, pricing);
}

/**
 * 2 つの問いが共有するキャッシュの接頭辞のトークン数（文字数の半分の切り上げ）。モデル・system・tools・output_config が同じときだけ数え、
 * system・tools と、最初の user メッセージの content がどちらもブロックの配列なら先頭から同じブロックの並び（文字列なら system・tools の分だけ）。
 * output_config（出力の形）も同じときだけ数える（format が違うと system prompt が形ごとに足されてキャッシュが別になる。両役は同じ OUTPUT_SCHEMA。Issue #1086）。違えば 0
 */
export function sharedPrefixTokens(a: MessagesParams, b: MessagesParams): number {
  if (a['model'] !== b['model']) return 0;
  if (JSON.stringify(a['system']) !== JSON.stringify(b['system']) || JSON.stringify(a['tools']) !== JSON.stringify(b['tools'])) return 0;
  if (JSON.stringify(a['output_config']) !== JSON.stringify(b['output_config'])) return 0;
  const ca = a.messages[0]?.content;
  const cb = b.messages[0]?.content;
  const shared: unknown[] = [];
  if (Array.isArray(ca) && Array.isArray(cb)) {
    for (let i = 0; i < Math.min(ca.length, cb.length) && JSON.stringify(ca[i]) === JSON.stringify(cb[i]); i++) shared.push(ca[i]);
  }
  const chars = JSON.stringify({ system: a['system'], tools: a['tools'], messages: shared.length > 0 ? [{ role: 'user', content: shared }] : [] }).length;
  return Math.ceil(chars / 2);
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

/**
 * PR 自身の差分を比べるための diff の正規化（Issue #1089）。`index ` の行を除き、`@@` で始まる行を行番号の無い `@@` にする
 * （`git patch-id --verbatim` と同じく行番号と blob の sha を無視し、空白を含む変更内容と文脈の行は区別する）。空・空白だけなら ''
 */
export function normalizePrDiff(diff: string): string {
  if (diff.trim() === '') return '';
  return diff
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@') ? '@@' : line))
    .join('\n');
}

/** 飛ばす判断に使える前回の記録（レビューした head・記録のコメントの URL・使ったモデル） */
export type ReusableRecord = { headSha: string; url: string | null; models: { review: string; risk: string } };

/**
 * 同じ PR の前回レビューした（posted の）記録のうち、今の head の代わりに使えるものを選ぶ（Issue #1089）。
 * レビュー用 App の名義で、parseApiReviewComment が posted と読め、headSha が今の head と違い、dryRun と diffTruncated が false
 * （欄の無い古い記録は不可）、コメントが編集されていない（created_at と updated_at が同じ。欄が無ければ編集なしとみなす）もののうち、id が最大のもの。
 * 投稿しなかった記録・ほかの名義の記録は選ばない。無ければ null（モデルが今の設定と合うかは呼び出し側が diff を取ってから比べる）
 */
export function findReusableRecord(comments: IssueComment[], reviewAppLogin: string, headSha: string): ReusableRecord | null {
  let best: { id: number; value: ReusableRecord } | null = null;
  for (const c of comments) {
    if (c.user?.login !== reviewAppLogin) continue;
    if (c.created_at !== undefined && c.updated_at !== undefined && c.created_at !== c.updated_at) continue;
    const parsed = parseApiReviewComment(c.body);
    if (parsed === null || parsed.outcome !== 'posted') continue;
    const r = parsed.record;
    if (r.headSha === headSha || r.dryRun !== false || r.diffTruncated !== false) continue;
    const models = r.models as { review?: unknown; risk?: unknown } | undefined;
    if (typeof models?.review !== 'string' || typeof models?.risk !== 'string') continue;
    if (best === null || c.id > best.id) {
      best = { id: c.id, value: { headSha: r.headSha, url: c.html_url ?? null, models: { review: models.review, risk: models.risk } } };
    }
  }
  return best?.value ?? null;
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
  const request = (model: string, messages: MessagesParams['messages']): MessagesParams => ({
    model,
    max_tokens: claude.maxTokens,
    system: systemFor(material.rules),
    tools: REVIEW_TOOLS,
    messages,
    output_config: { effort: claude.effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  });
  const compareEnabled = claude.riskCompare !== false && models.review !== models.risk;
  return {
    models,
    review: request(models.review, buildReviewerMessages(material)),
    risk: request(models.risk, buildRiskMessages(material)),
    riskCompare: compareEnabled ? request(models.review, buildRiskMessages(material)) : null,
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
    await deps.kv.put(key, redact(JSON.stringify({ version: 1, outcome, pr, headSha, at: new Date(deps.now()).toISOString(), ...extra }), secrets));
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
  // 待たない action（opened など）でも、fetch-pr の取り直しで head が違えば superseded になる
  if (config.trigger.settleSeconds > 0 && deps.sleep !== undefined) {
    if (shouldSettle(config.trigger, params.action)) {
      await deps.sleep(config.trigger.settleSeconds * 1000);
      log(`settle ${config.trigger.settleSeconds}s`);
    } else {
      log(`settle skipped ${params.action}`);
    }
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
    else if (deps.claude === null) stop = 'no-api-key';
    if (stop !== null) await writeRecord(stop, {});
    return { startedAt, stop };
  });
  if (fetched.stop !== null) {
    const stopped = await stopStep('fetch-pr', fetched.stop);
    if (fetched.stop === 'no-api-key') await postStopped('no-api-key', { usd: null });
    return stopped;
  }
  const claude = deps.claude;
  if (claude === null) return stopStep('fetch-pr', 'no-api-key');
  log('fetch-pr ok');

  // 1b. same-patch（Issue #1089）：前回レビューした head と PR 自身の差分（base...head の3点比較の diff）が同じで、記録のモデルが今の設定と同じなら、
  // Claude を呼ばずに KV に記録して終える（GitHub にはコメントを付けない。judge は同じ patch-id の前回の記録を使う）。
  // diff が取れない・空・違う、記録が使えない、段階の中で投げた、のどれでもレビューする側（skip: null）に倒す。段階の結果は小さい JSON だけにする
  const samePatch = await step('same-patch', async (): Promise<{ skip: string | null }> => {
    try {
      const gh = await deps.github.reader();
      const found = await gh.getPr(pr);
      const previous = findReusableRecord(await gh.listComments(pr), params.reviewAppLogin, headSha);
      if (previous === null) return { skip: null };
      const [before, current] = await Promise.all([gh.compareDiff(found.base.ref, previous.headSha), gh.compareDiff(found.base.ref, headSha)]);
      const a = normalizePrDiff(before);
      if (a === '' || a !== normalizePrDiff(current)) return { skip: null };
      const models = chooseModels({ diff: current, diffTruncated: false }, config.claude);
      if (models.review !== previous.models.review || models.risk !== previous.models.risk) return { skip: null };
      await writeRecord('same-patch', { reusableHead: previous.headSha, recordUrl: previous.url });
      return { skip: previous.headSha };
    } catch {
      return { skip: null };
    }
  });
  if (samePatch.skip !== null) {
    log(`same-patch skip ${samePatch.skip}`);
    return result('same-patch');
  }

  // 2. collect
  const material = await step('collect', async (): Promise<Material> => {
    const gh = await deps.github.reader();
    return collectMaterial(gh, config, {
      owner,
      repo,
      pr,
      headSha,
      appLogin: params.gateAppLogin,
      reviewLogin: params.reviewAppLogin,
      ...(config.trigger.issueLink === undefined ? {} : { issueLink: config.trigger.issueLink }),
    });
  });
  log(`collect ok rules=${material.rules.status}`);
  const rules = rulesSummary(material.rules);
  const asks = buildAskRequests(material, config);
  const models = asks.models;
  log(`models review=${models.review} risk=${models.risk}`);

  const month = costKey(owner, repo, new Date(deps.now()));
  const usdOf = (u: Record<string, Usage>): number | null => usageUsd(u, config.pricing);
  const roleUsage = (u: Record<string, Usage>): RoleUsage => ({ usage: u, usd: usdOf(u) });
  // 月の累計（cost:）に使用量の推定 USD を足す（record と record-cost の段階の中で呼ぶ）
  const addMonthCost = async (u: Record<string, Usage>): Promise<void> => {
    if (Object.keys(u).length === 0) return;
    let add = 0;
    for (const [model, v] of Object.entries(u)) add += estimateUsd(v, model, config.pricing) ?? 0;
    const raw = await deps.kv.get(month);
    const cur = raw === null || raw.trim() === '' || !Number.isFinite(Number(raw)) ? 0 : Number(raw);
    await deps.kv.put(month, String(Math.round((cur + add) * 1e6) / 1e6));
  };

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
    const b = estimateLoopUsd(asks.risk, limits, config.pricing, sharedPrefixTokens(asks.review, asks.risk));
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

  // 4・5. review と risk（Issue #1061）。Risk は Reviewer の最初の応答（材料のキャッシュが書かれた後）か、review の段階の終わり
  // （Workflow の再開で永続化した結果から返り Claude を呼ばないときを含む）の先の方を待ってから始め、両方を並べて待つ。
  // review が最初の応答の前に投げたら risk は呼ばない
  let firstResponse: () => void = () => {};
  const responded = new Promise<void>((resolve) => (firstResponse = resolve));
  const reviewClient: MessagesClient = {
    async create(p) {
      const res = await claude.create(p);
      firstResponse();
      return res;
    },
  };
  const ask = (name: 'review' | 'risk', client: MessagesClient, request: MessagesParams): Promise<AskStep> =>
    step(name, async (): Promise<AskStep> => ({ skipped: false, result: await askWithTools(client, request, await toolRunner(), config.claude.maxToolCalls) }));
  const reviewing = ask('review', reviewClient, asks.review);
  const go = await Promise.race([responded.then(() => true), reviewing.then(() => true, () => false)]);
  const [reviewSettled, riskSettled] = await Promise.allSettled([reviewing, go ? ask('risk', claude, asks.risk) : Promise.resolve<AskStep>({ skipped: true })]);
  if (reviewSettled.status === 'rejected') {
    // risk が終わっていれば、その使用量を月の累計に足してから投げる（並べたことで数えられない支出を作らない）
    if (riskSettled.status === 'fulfilled' && !riskSettled.value.skipped) {
      const used = riskSettled.value.result.usage;
      await step('record-cost', () => addMonthCost(used));
      log('record-cost risk');
    }
    throw reviewSettled.reason;
  }
  const review = reviewSettled.value;
  log(`review ${review.skipped ? 'skipped' : review.result.ok ? 'ok' : review.result.reason}`);
  // review が ok: false で risk が投げたときは、投げずに verdict-invalid へ進む（risk の使用量は分からないので数えない）
  if (riskSettled.status === 'rejected' && (review.skipped || review.result.ok)) throw riskSettled.reason;
  const risk: AskStep = riskSettled.status === 'fulfilled' ? riskSettled.value : { skipped: true };
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
        const r = await askWithTools(claude, asks.riskCompare!, await toolRunner(), config.claude.maxToolCalls);
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
    await addMonthCost(usage);
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
