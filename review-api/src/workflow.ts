// runReview を段階ごとに step.do で動かす ReviewWorkflow と、Worker の Env・Workflow の params の型 ReviewEventParams。
// collect の結果（diff と変更ファイルの中身）は 1 MiB を超えうるので、collect だけは step.do で包まず、再開のたびに GitHub を読み直す。
// 最初に step.sleep で settleSeconds 秒待つ（push が続くあいだの古い head に Claude を呼ばない）。待つのは action が trigger.settleActions にあるときと、action の無い古い params のときだけ。
// 実行に要る値（installation・App の鍵と login・Claude のキー・上限・trigger）は、リポジトリの表（REVIEW_REPOS。無ければ vars から組む1行の表）の
// その PR のリポジトリの行だけから prepareRepoReview（pipeline.ts）で選ぶ。表に無い・行が足りなければ Claude を呼ばずに止める。
// token・API キー・本文・署名は段階の結果にもログにも入れない（ログ・コメント・KV の記録は表のすべての行の秘密で伏せる）。
// @anthropic-ai/sdk・cloudflare:workers・cloudflare:workflows を import するのは worker.ts とこのファイルだけ。
import Anthropic from '@anthropic-ai/sdk';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError as WorkflowNonRetryableError } from 'cloudflare:workflows';
import { NonRetryableError, type Message, type MessagesClient, type MessagesParams } from './claude.ts';
import { loadReviewConfig } from './config.ts';
import { appJwt, installationToken, READ_PERMISSIONS, WRITE_PERMISSIONS } from './github-app.ts';
import { createGitHubClient } from './github.ts';
import { prepareRepoReview, runReview, type ReviewDeps, type ReviewParams, type ReviewResult, type RunStep, type StepName } from './pipeline.ts';
import { askRole } from './prompts.ts';
import { redact } from './redact.ts';
import { RISK_QUESTIONS } from './verdict.ts';
import reviewConfigJson from '../review.config.json' with { type: 'json' };

export interface ReviewEventParams {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  /** Webhook の action（Issue #1067 より前に作った Workflow の params には無い） */
  action?: string;
  installationId: number;
  deliveryId: string;
}

export interface Env {
  REVIEW_WORKFLOW: Workflow<ReviewEventParams>;
  REVIEW_KV: KVNamespace;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  // リポジトリの表（ダッシュボードの変数。JSON の文字列）。行が名指しする Secret は名前で env から読む（docs/review-api.md の節8.3）
  REVIEW_REPOS?: string;
  // REVIEW_REPOS が無い間は、wrangler.jsonc の vars のこれらから1行の表を組む（docs/review-api.md の節8.3）
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_INSTALLATION_ID?: string;
  ALLOWED_REPOS?: string;
  REVIEW_APP_LOGIN?: string;
  GATE_APP_LOGIN?: string;
  DRY_RUN?: string;
  // 費用の上限の上書き（ダッシュボードの変数。keep_vars でデプロイの後も残る。docs/review-api.md の節7）
  BUDGET_MONTHLY_USD?: string;
  BUDGET_PER_REVIEW_USD?: string;
}

const RETRY_CONFIG = { retries: { limit: 1, delay: '30 seconds', backoff: 'constant' } } as const;

/** DRY_RUN=1 のときの固定の JSON。Claude を呼ばず、API キーも要らない */
function dryRunClient(): MessagesClient {
  return {
    async create(params: MessagesParams): Promise<Message> {
      const isReviewer = askRole(params) === 'review';
      const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, 'no']));
      const body = isReviewer
        ? { pass: true, blocking: [], nonBlocking: ['DRY_RUN'] }
        : {
            level: 'low',
            answers,
            rationale: 'DRY_RUN',
            facts: { references: 'DRY_RUN', tests: 'DRY_RUN', fileKinds: 'DRY_RUN' },
          };
      return {
        model: typeof params['model'] === 'string' ? params['model'] : 'dry-run',
        content: [{ type: 'text', text: JSON.stringify(body) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
}

function anthropicClient(apiKey: string): MessagesClient {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    async create(params: MessagesParams): Promise<Message> {
      // askWithTools は同じ配列を渡して後で push するので、写して渡す
      const message = await client.messages.create({ ...params, messages: [...params.messages] } as unknown as Anthropic.MessageCreateParamsNonStreaming);
      return message as unknown as Message;
    },
  };
}

/** collect は結果が 1 MiB を超えうるので step.do で包まない。ほかは step.do で再試行・永続化する */
function makeRunStep(step: WorkflowStep): RunStep {
  return async <T>(name: StepName, fn: () => Promise<T>): Promise<T> => {
    if (name === 'collect') return fn();
    const body = async () => {
      try {
        return (await fn()) as Rpc.Serializable<T>;
      } catch (err) {
        if (err instanceof NonRetryableError) throw new WorkflowNonRetryableError(err.message);
        throw err;
      }
    };
    const result = name === 'review' || name === 'risk' || name === 'risk-compare' ? await step.do(name, RETRY_CONFIG, body) : await step.do(name, body);
    return result as unknown as T;
  };
}

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewEventParams> {
  override async run(event: WorkflowEvent<ReviewEventParams>, step: WorkflowStep): Promise<ReviewResult> {
    const env = this.env;
    const { owner, repo, pr, headSha, action } = event.payload;
    const setup = prepareRepoReview(env as unknown as Parameters<typeof prepareRepoReview>[0], loadReviewConfig(reviewConfigJson), `${owner}/${repo}`, {
      dryRun: dryRunClient,
      anthropic: anthropicClient,
    });
    // 理由と項目の名前・パスだけを出す（値は入れない）
    if (!setup.ok) throw new WorkflowNonRetryableError(`repo ${setup.reason}${setup.errors.length > 0 ? ` ${setup.errors.join(' ')}` : ''}`);
    const { runtime, secrets } = setup;
    const client = async (permissions: typeof READ_PERMISSIONS | typeof WRITE_PERMISSIONS) => {
      const jwt = await appJwt(runtime.clientId, runtime.privateKey);
      const { token } = await installationToken(jwt, runtime.installationId, permissions);
      return createGitHubClient({ token, owner, repo });
    };
    // 記録の印は、prepareRepoReview が固定の JSON のクライアントを選ぶのと同じ条件（DRY_RUN=1）で決める（Issue #1068）
    const dryRun = env.DRY_RUN === '1';
    const deps: ReviewDeps = {
      github: { reader: () => client(READ_PERMISSIONS), writer: () => client(WRITE_PERMISSIONS) },
      claude: setup.claude,
      dryRun,
      kv: {
        get: (key) => env.REVIEW_KV.get(key),
        put: (key, value) => env.REVIEW_KV.put(key, value),
      },
      now: () => Date.now(),
      log: (line) => console.log(redact(line, secrets)),
      sleep: (ms) => step.sleep('settle', ms),
      secrets,
    };
    // 名前だけを出す（値は budget の段階のログに出る）
    if (setup.invalid.length > 0) console.log(`budget env invalid ${setup.invalid.join(',')}`);
    const params: ReviewParams = {
      owner,
      repo,
      pr,
      headSha,
      ...(action === undefined ? {} : { action }),
      gateAppLogin: runtime.gateAppLogin,
      reviewAppLogin: runtime.reviewAppLogin,
      config: setup.config,
    };
    return runReview(deps, params, makeRunStep(step));
  }
}
