import { readFileSync } from 'node:fs';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { FetchTransport, GitHub } from '../lib/github.ts';
import { askJev, redact } from '../lib/jev.ts';
import type { CheckOutcome } from '../lib/merge-route.ts';
import type { PullRequest } from '../lib/state.ts';

/**
 * ゲートの実行コンテキスト。イベントは GITHUB_EVENT_PATH の JSON から読み、
 * workflow の式（${{ }}）には PR やコメントの中身を埋め込まない。
 */
export interface GateContext {
  config: HarnessConfig;
  gh: GitHub;
  repository: string;
  eventName: string;
  event: any;
  secrets: { jevApiKey?: string };
  log: (msg: string) => void;
  /** Issue の分類と決定の記録の確かめで Jev に問う関数（無ければ harness/lib/jev.ts の askJev。テストで差し替える） */
  askJev?: typeof askJev;
}

export function createContext(): GateContext {
  const token = process.env.GH_APP_TOKEN;
  if (!token) throw new Error('GH_APP_TOKEN がありません（App のトークンだけを使う）');
  const repository = required('GITHUB_REPOSITORY');
  const eventPath = required('GITHUB_EVENT_PATH');
  const jevApiKey = process.env.JEV_API_KEY || undefined;
  const secrets = [token, jevApiKey];
  return {
    config: loadConfig(),
    gh: new GitHub(new FetchTransport(token, process.env.GITHUB_API_URL ?? 'https://api.github.com'), repository),
    repository,
    eventName: required('GITHUB_EVENT_NAME'),
    event: JSON.parse(readFileSync(eventPath, 'utf8')),
    secrets: { jevApiKey },
    log: (msg) => console.log(redact(msg, ...secrets)),
    askJev,
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} がありません`);
  return v;
}

/** App のコメント。kind と JSON 記録を付ける */
export function appComment(ctx: GateContext, issue: number, kind: string, text: string, record?: unknown): Promise<{ id: number }> {
  const parts = [appMark(kind), text];
  if (record !== undefined) parts.push('', '<details><summary>記録（機械可読）</summary>', '', renderBlock('agent-app', record), '', '</details>');
  const body = redact(parts.join('\n'), ctx.secrets.jevApiKey, process.env.GH_APP_TOKEN);
  return ctx.gh.comment(issue, body);
}

export async function writeCheck(ctx: GateContext, headSha: string, name: string, outcome: Omit<CheckOutcome, 'conclusion'> & { conclusion: 'success' | 'failure' | 'neutral' }): Promise<void> {
  await ctx.gh.request('POST', '/check-runs', {
    body: {
      name,
      head_sha: headSha,
      status: 'completed',
      conclusion: outcome.conclusion,
      output: { title: outcome.title, summary: redact(outcome.summary, ctx.secrets.jevApiKey).slice(0, 60000) },
    },
  });
  ctx.log(`check ${name}@${headSha.slice(0, 7)} = ${outcome.conclusion}: ${outcome.title}`);
}

export function getPr(ctx: GateContext, number: number): Promise<PullRequest> {
  return ctx.gh.get<PullRequest>(`/pulls/${number}`);
}

export async function disableAutoMerge(ctx: GateContext, pr: PullRequest): Promise<void> {
  if (!pr.auto_merge) return;
  await ctx.gh.graphql(`mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}`, { id: pr.node_id });
  pr.auto_merge = null;
  ctx.log(`auto-merge disabled on #${pr.number}`);
}

export async function enableAutoMerge(ctx: GateContext, pr: PullRequest): Promise<boolean> {
  try {
    await ctx.gh.graphql(
      `mutation($id:ID!,$method:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method}){clientMutationId}}`,
      { id: pr.node_id, method: ctx.config.mergeMethod },
    );
    pr.auto_merge = { enabled: true };
    ctx.log(`auto-merge enabled on #${pr.number}`);
    return true;
  } catch (e) {
    ctx.log(`auto-merge を設定できませんでした (#${pr.number}): ${(e as Error).message}`);
    return false;
  }
}

export async function markReady(ctx: GateContext, pr: PullRequest): Promise<void> {
  if (!pr.draft) return;
  await ctx.gh.graphql(`mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`, { id: pr.node_id });
  pr.draft = false;
}

export async function convertToDraft(ctx: GateContext, pr: PullRequest): Promise<void> {
  if (pr.draft) return;
  await ctx.gh.graphql(`mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}`, { id: pr.node_id });
  pr.draft = true;
}

/**
 * PR が base より遅れていれば update-branch する（必須チェックで main への追従を求めているため、遅れた auto-merge 待ちの PR は止まる）。
 * push 直後は mergeable_state が unknown になりやすいので、compare で遅れを直接調べる。
 */
export async function updateBranchIfBehind(ctx: GateContext, pr: PullRequest): Promise<void> {
  const cmp = await ctx.gh.get<{ behind_by: number }>(`/compare/${encodeURIComponent(pr.base.ref)}...${pr.head.sha}`);
  if (cmp.behind_by === 0) return;
  try {
    await ctx.gh.request('PUT', `/pulls/${pr.number}/update-branch`, { body: { expected_head_sha: pr.head.sha } });
    ctx.log(`#${pr.number} を ${pr.base.ref} に追従させました`);
  } catch (e) {
    ctx.log(`#${pr.number} の追従に失敗: ${(e as Error).message}`);
  }
}
