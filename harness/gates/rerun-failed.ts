import { appMarkKind } from '../lib/blocks.ts';
import { appLogin, type HarnessConfig } from '../lib/config.ts';
import type { GitHub, IssueComment } from '../lib/github.ts';
import { isTrustedComment, type Review } from '../lib/state.ts';

/**
 * 定期実行：計画・判定・決定の記録のコメントで起動して失敗した gate の実行を見つけ、1回だけやり直す（#390）。
 * gate.yml のジョブ rerun-failed（定期実行と手動の起動のときだけ）が harness/gates/rerun.ts から呼ぶ。
 * やり直すのは直近6時間・1回目（run_attempt が 1）の実行だけで、コメントが処理済みなら飛ばす。
 * Actions の API（実行の一覧・やり直し）だけを GITHUB_TOKEN（actions: write）で呼び、ほかは App のトークンで読む。
 */

/** やり直す実行の窓（時間） */
export const RERUN_WINDOW_HOURS = 6;
/** コメントの作成から実行の作成までの幅（秒）。これを超えると結ばない */
export const RUN_MATCH_WINDOW_SECONDS = 120;
/** App の installation の上限の残りがこれ未満なら、やり直さない（同じ上限で失敗し、1回だけの機会を無駄にするため） */
export const MIN_APP_RATE_REMAINING = 500;
export const GATE_WORKFLOW_FILE = 'gate.yml';

export type BlockKind = 'plan' | 'verdict' | 'decision';

/** GET /actions/workflows/gate.yml/runs の workflow_runs の1件（使う項目だけ） */
export interface WorkflowRun {
  id: number;
  created_at: string;
  run_attempt: number;
  event: string;
  status?: string;
  conclusion: string | null;
  actor: { login: string } | null;
  html_url?: string;
}

/** GET /issues/comments の1件（issue_url の末尾が Issue・PR の番号） */
export type RepoComment = IssueComment & { issue_url: string };

/** 結び付いたコメントの Issue・PR の状態 */
export interface TargetState {
  number: number;
  open: boolean;
  comments: IssueComment[];
  /** PR のときのレビュー（Issue なら []） */
  reviews: Review[];
}

export interface RerunTarget { runId: number; commentId: number; issue: number; kind: BlockKind; commentUrl: string }
export interface RerunSkip { runId: number; reason: string }
export interface RerunSelection { rerun: RerunTarget[]; skipped: RerunSkip[] }

/** gate.yml のジョブの if と同じ（本文に ```agent-plan などを含むか） */
const BLOCKS: [BlockKind, string][] = [
  ['plan', '```agent-plan'],
  ['verdict', '```agent-verdict'],
  ['decision', '```agent-decision'],
];

const KIND_NAMES: Record<BlockKind, string> = { plan: '計画', verdict: '判定', decision: '決定の記録' };

/** App のゲートの応答（これがコメントの後にあれば処理済み）。acceptance は理由を分ける */
const GATE_REPLY_KINDS = new Set(['plan-gate', 'verdict-rejected', 'fix-limit', 'plan-decision', 'plan-proceed']);

export function blockKindOf(body: string | null | undefined): BlockKind | null {
  const text = body ?? '';
  return BLOCKS.find(([, fence]) => text.includes(fence))?.[0] ?? null;
}

export function issueNumberOf(comment: Pick<RepoComment, 'issue_url'>): number {
  return Number(comment.issue_url.match(/\/(\d+)\/?$/)?.[1] ?? NaN);
}

function windowStart(now: Date): number {
  return now.getTime() - RERUN_WINDOW_HOURS * 3600_000;
}

export function isRerunCandidate(run: WorkflowRun, now: Date): boolean {
  const created = Date.parse(run.created_at);
  return run.event === 'issue_comment' && run.conclusion === 'failure' && run.run_attempt === 1
    && created >= windowStart(now) && created <= now.getTime();
}

/** a が b より後か（作成時刻、同じなら id） */
function after(a: { created_at: string; id: number }, b: { created_at: string; id: number }): boolean {
  const d = Date.parse(a.created_at) - Date.parse(b.created_at);
  return d > 0 || (d === 0 && a.id > b.id);
}

export function matchRunsToComments(runs: WorkflowRun[], comments: RepoComment[], now: Date): { matched: Map<number, RepoComment>; unmatched: RerunSkip[] } {
  const start = windowStart(now);
  const pool = comments.filter((c) => blockKindOf(c.body) !== null && isTrustedComment(c) && Date.parse(c.created_at) >= start);
  const used = new Set<number>();
  const matched = new Map<number, RepoComment>();
  const unmatched: RerunSkip[] = [];
  const ordered = [...runs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  for (const run of ordered) {
    const login = run.actor?.login;
    const runAt = Date.parse(run.created_at);
    const sameAuthor = pool.filter((c) => login !== undefined && c.user?.login === login);
    let best: RepoComment | null = null;
    let bestDiff = Infinity;
    let nearest = Infinity;
    for (const c of sameAuthor) {
      const diff = (runAt - Date.parse(c.created_at)) / 1000;
      if (Math.abs(diff) < Math.abs(nearest)) nearest = diff;
      if (used.has(c.id) || diff < 0 || diff > RUN_MATCH_WINDOW_SECONDS) continue;
      if (diff < bestDiff || (diff === bestDiff && best !== null && c.id > best.id)) {
        best = c;
        bestDiff = diff;
      }
    }
    if (best) {
      used.add(best.id);
      matched.set(run.id, best);
    } else {
      const detail = sameAuthor.length === 0 ? '同じ作成者のコメントなし' : `同じ作成者の最も近いコメントとの差 ${Math.round(nearest)} 秒`;
      unmatched.push({ runId: run.id, reason: `コメントを特定できない（${detail}）` });
    }
  }
  return { matched, unmatched };
}

/** コメントが処理済みなら理由を返す（null ならやり直す） */
function processedReason(config: HarnessConfig, comment: RepoComment, kind: BlockKind, state: TargetState): string | null {
  if (!state.open) return 'Close 済みの Issue・PR';
  const app = appLogin(config);
  const later = state.comments.filter((c) => c.id !== comment.id && after(c, comment));
  const replies = later.filter((c) => c.user?.login === app).map((c) => appMarkKind(c.body));
  if (replies.includes('acceptance')) return 'acceptance の後で失敗（受け付けは書かれている。Ready・auto-merge などの続きは人が gh run rerun するか判定し直す）';
  const reply = replies.find((k) => k !== null && GATE_REPLY_KINDS.has(k));
  if (reply) return `処理済み（コメントの後に App の ${reply} がある）`;
  if (kind === 'verdict') {
    const fixRequest = state.reviews.some((r) => r.user?.login === app && appMarkKind(r.body) === 'fix-request'
      && Date.parse(r.submitted_at) >= Date.parse(comment.created_at));
    if (fixRequest) return '途中まで処理済み（fix-request を書いた後で失敗。やり直すと修正回数を二重に数える）';
  }
  if (later.some((c) => isTrustedComment(c) && blockKindOf(c.body) === kind)) return `後に同じ種類（${KIND_NAMES[kind]}）のコメントがある`;
  return null;
}

export function selectRerunTargets(input: { config: HarnessConfig; runs: WorkflowRun[]; comments: RepoComment[]; states: Map<number, TargetState>; now: Date }): RerunSelection {
  const seen = new Set<number>();
  const runs = input.runs.filter((r) => {
    if (seen.has(r.id) || !isRerunCandidate(r, input.now)) return false;
    seen.add(r.id);
    return true;
  });
  const { matched, unmatched } = matchRunsToComments(runs, input.comments, input.now);
  const rerun: RerunTarget[] = [];
  const skipped: RerunSkip[] = [...unmatched];
  for (const run of runs) {
    const comment = matched.get(run.id);
    if (!comment) continue;
    const kind = blockKindOf(comment.body)!;
    const issue = issueNumberOf(comment);
    const state = input.states.get(issue);
    if (!state) {
      skipped.push({ runId: run.id, reason: `Issue・PR の状態を読めない（#${issue}）` });
      continue;
    }
    const reason = processedReason(input.config, comment, kind, state);
    if (reason) skipped.push({ runId: run.id, reason: `${reason}（#${issue} の${KIND_NAMES[kind]}のコメント ${comment.id}）` });
    else rerun.push({ runId: run.id, commentId: comment.id, issue, kind, commentUrl: comment.html_url });
  }
  return { rerun, skipped };
}

export interface RerunDeps {
  config: HarnessConfig;
  /** App のトークンのクライアント（コメント・Issue・レビューを読む） */
  app: GitHub;
  /** GITHUB_TOKEN（actions: write）のクライアント（実行の一覧とやり直しだけ） */
  actions: GitHub;
  /** App の installation の上限の残り（GET /rate_limit の resources.core.remaining） */
  appRateRemaining: () => Promise<number>;
  log: (msg: string) => void;
  now?: Date;
}

export async function rerunFailedGateRuns(deps: RerunDeps): Promise<RerunSelection & { failed: { runId: number; error: string }[] }> {
  const now = deps.now ?? new Date();
  const remaining = await deps.appRateRemaining();
  if (remaining < MIN_APP_RATE_REMAINING) {
    deps.log(`App の上限の残りが少ない（${remaining} < ${MIN_APP_RATE_REMAINING}）ため、失敗した実行のやり直しは次の定期実行に回します`);
    return { rerun: [], skipped: [], failed: [] };
  }
  const since = new Date(windowStart(now)).toISOString();
  const res = await deps.actions.get<{ workflow_runs: WorkflowRun[] }>(
    `/actions/workflows/${GATE_WORKFLOW_FILE}/runs?event=issue_comment&status=failure&created=${encodeURIComponent(`>=${since}`)}&per_page=100`,
  );
  const runs = (res?.workflow_runs ?? []).filter((r) => isRerunCandidate(r, now));
  if (runs.length === 0) {
    deps.log('やり直す候補の実行はありません（直近6時間に失敗した1回目の issue_comment の実行なし）');
    return { rerun: [], skipped: [], failed: [] };
  }
  const comments = await deps.app.paginate<RepoComment>(`/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc`);
  const { matched } = matchRunsToComments(runs, comments, now);
  const states = new Map<number, TargetState>();
  for (const number of new Set([...matched.values()].map(issueNumberOf))) {
    try {
      const issue = await deps.app.get<{ state: string; pull_request?: unknown }>(`/issues/${number}`);
      const list = await deps.app.listComments(number);
      const reviews = issue.pull_request ? await deps.app.paginate<Review>(`/pulls/${number}/reviews`) : [];
      states.set(number, { number, open: issue.state === 'open', comments: list, reviews });
    } catch (e) {
      deps.log(`#${number} の状態を読めませんでした: ${(e as Error).message}`);
    }
  }
  const selection = selectRerunTargets({ config: deps.config, runs, comments, states, now });
  const failed: { runId: number; error: string }[] = [];
  for (const t of selection.rerun) {
    try {
      await deps.actions.request('POST', `/actions/runs/${t.runId}/rerun-failed-jobs`);
      deps.log(`実行 ${t.runId} をやり直しました（#${t.issue} の${KIND_NAMES[t.kind]}: ${t.commentUrl}）`);
    } catch (e) {
      const error = (e as Error).message;
      failed.push({ runId: t.runId, error });
      deps.log(`実行 ${t.runId} のやり直しに失敗しました: ${error}`);
    }
  }
  for (const s of selection.skipped) deps.log(`実行 ${s.runId} は飛ばしました: ${s.reason}`);
  return { ...selection, failed };
}
