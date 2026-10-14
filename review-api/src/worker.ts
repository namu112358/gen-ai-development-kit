// Webhook の受付：リポジトリの表（repos.ts）の読み取り → 表の Webhook の秘密での署名の検証 → 対象の判定 → ReviewWorkflow の起動。GET /health と POST /webhook だけを持つ。
// 本文・署名・ヘッダーは保存せず、ログにも出さない（ログは結果の1行だけ）。エラーの message はレスポンスにもログにも出さない。
// @anthropic-ai/sdk・cloudflare:workers・cloudflare:workflows を import するのは workflow.ts とこのファイルだけ。
import { loadReviewConfig } from './config.ts';
import { parseRepoTable, secretValue, webhookSecretNames, type RepoEnv } from './repos.ts';
import { decideReview, verifyWithSecrets, type PullRequestEvent } from './webhook.ts';
import type { Env, ReviewEventParams } from './workflow.ts';
import reviewConfigJson from '../review.config.json' with { type: 'json' };

export { ReviewWorkflow } from './workflow.ts';

const config = loadReviewConfig(reviewConfigJson);

const MAX_ID_LENGTH = 100;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Workflow の instance id（英数字・-・_ で 100 字まで）。同じ PR の同じ head には同じ id になる */
export async function instanceId(owner: string, repo: string, pr: number, sha: string): Promise<string> {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-');
  const id = `rv-${clean(owner)}-${clean(repo)}-${pr}-${sha}`;
  if (id.length <= MAX_ID_LENGTH) return id;
  const digest = (await sha256Hex(`${owner}/${repo}`)).slice(0, 16);
  return `rv-${digest}-${pr}-${sha}`;
}

interface EventFields {
  action?: unknown;
  repository?: { full_name?: unknown };
  installation?: { id?: unknown };
  pull_request?: { number?: unknown; head?: { sha?: unknown } };
}

function finish(httpStatus: number, status: string, extra: Record<string, unknown> = {}): Response {
  const detail = typeof extra['reason'] === 'string' ? extra['reason'] : typeof extra['id'] === 'string' ? extra['id'] : '';
  console.log(`webhook ${status}${detail === '' ? '' : ` ${detail}`}`);
  return json(httpStatus, { status, ...extra });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // REVIEW_REPOS が無ければ今の vars（ALLOWED_REPOS など）から表を組む。表が誤りならどのイベントも受けない（ログは誤りの鍵のパスだけ。誤りの文に値は入らない）
  const repoEnv = env as unknown as RepoEnv;
  const parsed = parseRepoTable(repoEnv);
  if (parsed.errors.length > 0) {
    const paths = parsed.errors.map((e) => e.replace(/^- /, '').split(':')[0]);
    console.log(`webhook repo-table-invalid ${paths.join(',')}`);
    return finish(200, 'skipped', { reason: 'repo-table-invalid' });
  }
  const candidates = webhookSecretNames(parsed.table).map((name) => ({ name, value: secretValue(repoEnv, name) }));
  const raw = await request.text();
  const verified = await verifyWithSecrets(candidates, raw, request.headers.get('X-Hub-Signature-256'));
  if (verified.length === 0) return finish(401, 'unauthorized');
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return finish(400, 'invalid-json');
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return finish(400, 'invalid-json');
  const decision = decideReview(event as PullRequestEvent, config, parsed.table, verified);
  if (!decision.review) return finish(200, 'skipped', { reason: decision.reason });

  const fields = event as EventFields;
  const number = fields.pull_request?.number;
  const sha = fields.pull_request?.head?.sha;
  const fullName = fields.repository?.full_name;
  const installationId = fields.installation?.id;
  const [owner, repo, ...rest] = typeof fullName === 'string' ? fullName.split('/') : [];
  if (
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    number <= 0 ||
    typeof sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(sha) ||
    owner === undefined ||
    owner === '' ||
    repo === undefined ||
    repo === '' ||
    rest.length > 0 ||
    typeof installationId !== 'number'
  ) {
    return finish(400, 'invalid-event');
  }
  const params: ReviewEventParams = {
    owner,
    repo,
    pr: number,
    headSha: sha.toLowerCase(),
    ...(typeof fields.action === 'string' ? { action: fields.action } : {}),
    installationId,
    deliveryId: request.headers.get('X-GitHub-Delivery') ?? '',
  };
  const id = await instanceId(params.owner, params.repo, params.pr, params.headSha);
  try {
    await env.REVIEW_WORKFLOW.create({ id, params });
    return finish(202, 'started', { id });
  } catch {
    try {
      await env.REVIEW_WORKFLOW.get(id);
      return finish(200, 'duplicate', { id });
    } catch {
      return finish(500, 'error');
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      return request.method === 'GET' ? json(200, { status: 'ok' }) : json(405, { status: 'method-not-allowed' });
    }
    if (pathname === '/webhook') {
      return request.method === 'POST' ? handleWebhook(request, env) : json(405, { status: 'method-not-allowed' });
    }
    return json(404, { status: 'not-found' });
  },
} satisfies ExportedHandler<Env>;
