// runReview を段階ごとに step.do で動かす ReviewWorkflow と、Worker の Env・Workflow の params の型 ReviewEventParams。
// collect の結果（diff と変更ファイルの中身）は 1 MiB を超えうるので、collect だけは step.do で包まず、再開のたびに GitHub を読み直す。
// 最初に step.sleep で settleSeconds 秒待つ（push が続くあいだの古い head に Claude を呼ばない）。
// token・API キー・本文・署名は段階の結果にもログにも入れない。
// @anthropic-ai/sdk・cloudflare:workers・cloudflare:workflows を import するのは worker.ts とこのファイルだけ。
import Anthropic from '@anthropic-ai/sdk';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError as WorkflowNonRetryableError } from 'cloudflare:workflows';
import { NonRetryableError, type Message, type MessagesClient, type MessagesParams } from './claude.ts';
import { loadReviewConfig } from './config.ts';
import { appJwt, installationToken, READ_PERMISSIONS, WRITE_PERMISSIONS } from './github-app.ts';
import { createGitHubClient } from './github.ts';
import { runReview, type ReviewDeps, type ReviewParams, type ReviewResult, type RunStep, type StepName } from './pipeline.ts';
import { redact } from './redact.ts';
import { RISK_QUESTIONS } from './verdict.ts';
import reviewConfigJson from '../review.config.json' with { type: 'json' };

export interface ReviewEventParams {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  installationId: number;
  deliveryId: string;
}

export interface Env {
  REVIEW_WORKFLOW: Workflow<ReviewEventParams>;
  REVIEW_KV: KVNamespace;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  // 識別子も Secret として入れる（wrangler.jsonc に vars を置かない。docs/review-api.md の節8.3）ので、入れる前は無い
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_INSTALLATION_ID?: string;
  ALLOWED_REPOS?: string;
  REVIEW_APP_LOGIN?: string;
  GATE_APP_LOGIN?: string;
  DRY_RUN?: string;
}

const RETRY_CONFIG = { retries: { limit: 1, delay: '30 seconds', backoff: 'constant' } } as const;

/** DRY_RUN=1 のときの固定の JSON。Claude を呼ばず、API キーも要らない */
function dryRunClient(): MessagesClient {
  return {
    async create(params: MessagesParams): Promise<Message> {
      const outputConfig = params['output_config'] as { format?: { schema?: { properties?: Record<string, unknown> } } } | undefined;
      const isReviewer = outputConfig?.format?.schema?.properties?.['pass'] !== undefined;
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
    const result = name === 'review' || name === 'risk' ? await step.do(name, RETRY_CONFIG, body) : await step.do(name, body);
    return result as unknown as T;
  };
}

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewEventParams> {
  override async run(event: WorkflowEvent<ReviewEventParams>, step: WorkflowStep): Promise<ReviewResult> {
    const env = this.env;
    const gateAppLogin = (env.GATE_APP_LOGIN ?? '').trim();
    const reviewAppLogin = (env.REVIEW_APP_LOGIN ?? '').trim();
    if (gateAppLogin === '' || reviewAppLogin === '') {
      throw new WorkflowNonRetryableError('GATE_APP_LOGIN と REVIEW_APP_LOGIN が必要です');
    }
    const { owner, repo, pr, headSha } = event.payload;
    const secrets = [env.GITHUB_WEBHOOK_SECRET, env.GITHUB_APP_PRIVATE_KEY, env.ANTHROPIC_API_KEY].filter(
      (s): s is string => s !== undefined && s !== '',
    );
    const client = async (permissions: typeof READ_PERMISSIONS | typeof WRITE_PERMISSIONS) => {
      const jwt = await appJwt(env.GITHUB_APP_CLIENT_ID ?? '', env.GITHUB_APP_PRIVATE_KEY ?? '');
      const { token } = await installationToken(jwt, env.GITHUB_INSTALLATION_ID ?? '', permissions);
      return createGitHubClient({ token, owner, repo });
    };
    const deps: ReviewDeps = {
      github: { reader: () => client(READ_PERMISSIONS), writer: () => client(WRITE_PERMISSIONS) },
      claude: env.DRY_RUN === '1' ? dryRunClient() : anthropicClient(env.ANTHROPIC_API_KEY ?? ''),
      kv: {
        get: (key) => env.REVIEW_KV.get(key),
        put: (key, value) => env.REVIEW_KV.put(key, value),
      },
      now: () => Date.now(),
      log: (line) => console.log(redact(line, secrets)),
      sleep: (ms) => step.sleep('settle', ms),
      secrets,
    };
    const params: ReviewParams = {
      owner,
      repo,
      pr,
      headSha,
      gateAppLogin,
      reviewAppLogin,
      config: loadReviewConfig(reviewConfigJson),
    };
    return runReview(deps, params, makeRunStep(step));
  }
}
