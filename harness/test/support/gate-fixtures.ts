import { appMark, claudeMark, renderBlock } from '../../lib/blocks.ts';
import { appLogin, loadConfig } from '../../lib/config.ts';
import { GitHub, type RequestOptions, type Transport } from '../../lib/github.ts';
import type { Claim, ClaimStage } from '../../lib/queue.ts';
import { RISK_QUESTIONS, type Verdict } from '../../lib/verdict.ts';
import type { GateContext } from '../../gates/context.ts';

/** 偽の GitHub。呼び出しを記録し、ルートごとの応答を返す */
export class FakeGitHub implements Transport {
  calls: { method: string; path: string; body?: any }[] = [];
  private routes: [string, RegExp, (m: RegExpMatchArray, body: any, opts: RequestOptions) => unknown][] = [];

  on(method: string, pattern: RegExp, reply: (m: RegExpMatchArray, body: any, opts: RequestOptions) => unknown): this {
    this.routes.unshift([method, pattern, reply]);
    return this;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    this.calls.push({ method, path, body: opts.body });
    for (const [m, re, reply] of this.routes) {
      const match = path.match(re);
      if (m === method && match) return reply(match, opts.body, opts);
    }
    throw new Error(`unrouted: ${method} ${path}`);
  }

  /** 書き込み系の呼び出しを、順序確認用の短い名前にする */
  writes(): string[] {
    return this.calls
      .filter((c) => c.method !== 'GET' && !(c.path === '/graphql' && String(c.body?.query).startsWith('query')))
      .map((c) => {
        if (c.path === '/graphql') return String(c.body.query).match(/mutation\([^)]*\)\{(\w+)/)?.[1] ?? 'graphql';
        if (c.path.endsWith('/check-runs')) return `check:${c.body.name}=${c.body.conclusion}`;
        if (c.path.endsWith('/comments')) return `comment:${String(c.body.body).match(/kind=([\w-]+)/)?.[1]}`;
        if (c.path.endsWith('/labels')) return `label+${c.body.labels.join(',')}`;
        if (c.path.includes('/labels/')) return `label-${decodeURIComponent(c.path.split('/labels/')[1]!)}`;
        return `${c.method} ${c.path}`;
      });
  }
}

export const config = loadConfig();
export const APP = appLogin(config);
export const HEAD = 'a'.repeat(40);
export const DIFF = 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+b\n';

/** extra で config・secrets・askJev（Jev の fake）などを差し替える */
export function ctxFor(fake: FakeGitHub, eventName: string, event: unknown, extra: Partial<GateContext> = {}): GateContext {
  return { config, gh: new GitHub(fake, 'o/r'), repository: 'o/r', eventName, event, secrets: {}, log: () => {}, ...extra };
}

export function pr(patch: Record<string, unknown> = {}) {
  return {
    number: 5, state: 'open', draft: true, node_id: 'PR_5', title: 'docs: t', body: 'Closes #3', html_url: 'u', updated_at: '2026-09-26T00:00:00Z',
    auto_merge: null, labels: [], user: { login: 'me' },
    head: { ref: 'claude/issue-3', sha: HEAD, repo: { full_name: 'o/r' } }, base: { ref: 'main', sha: 'b'.repeat(40) }, ...patch,
  };
}

export const planGateComment = {
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files: ['docs/**'] } })}`,
};

export function verdict(patch: Partial<Verdict> = {}): Verdict {
  return {
    version: 1, pr: 5, headSha: HEAD,
    review: { pass: true, blocking: [], nonBlocking: [] },
    risk: { level: 'low', answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Verdict['risk']['answers'], rationale: 'docs' },
    facts: { references: 'none', tests: 'none', fileKinds: 'docs' },
    ...patch,
  };
}

/** 判定の受け付けに必要な応答を揃えた偽の GitHub */
export function acceptanceFake(state: { pr: ReturnType<typeof pr>; dashboardLabels?: string[]; prComments?: unknown[]; allowAutoMerge?: boolean; behindBy?: number }): FakeGitHub {
  let autoMerge: unknown = state.pr.auto_merge;
  return new FakeGitHub()
    .on('GET', /\/repos\/o\/r$/, () => ({ allow_auto_merge: state.allowAutoMerge ?? true }))
    .on('GET', /\/pulls\/5$/, () => ({ ...state.pr, auto_merge: autoMerge }))
    .on('GET', /\/compare\//, (_m, _b, o) => (o.raw ? DIFF : { behind_by: state.behindBy ?? 0 }))
    .on('GET', /\/pulls\/5\/files/, () => [{ filename: 'docs/a.md', additions: 1, deletions: 1 }])
    .on('GET', /\/pulls\/5\/reviews/, () => [])
    .on('GET', /\/issues\/3\/comments/, () => [planGateComment])
    .on('GET', /\/issues\/5\/comments/, () => state.prComments ?? [])
    // 開いた PR の一覧（計画の投稿で plan-link を書き直す相手を、スタックの層の Refs からも探すため）。テストごとの .on が優先する
    .on('GET', /\/pulls\?state=open/, () => [])
    .on('GET', /\/issues\?state=open&creator=/, () => (state.dashboardLabels ? [{ number: 1, title: config.dashboardIssueTitle, user: { login: APP }, labels: state.dashboardLabels.map((name) => ({ name })) }] : []))
    .on('POST', /\/graphql/, (_m, body) => {
      if (String(body.query).includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: 'o/r' } }] } } } } };
      if (String(body.query).includes('closedByPullRequestsReferences')) return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: 5, state: 'OPEN', repository: { nameWithOwner: 'o/r' } }] } } } } };
      if (String(body.query).includes('enablePullRequestAutoMerge')) autoMerge = { enabled: true };
      if (String(body.query).includes('disablePullRequestAutoMerge')) autoMerge = null;
      return { data: {} };
    })
    .on('POST', /\/issues\/\d+\/comments/, () => ({ id: 1, html_url: 'u' }))
    .on('POST', /\/check-runs/, () => ({}))
    .on('POST', /\/pulls\/5\/reviews/, () => ({}))
    .on('POST', /\/labels$/, () => ([]))
    .on('DELETE', /\/labels\//, () => null);
}

export const verdictEvent = (body: string, association = 'OWNER') => ({
  action: 'created',
  issue: { number: 5, pull_request: {}, labels: [], state: 'open' },
  comment: { id: 70, body, html_url: 'v', author_association: association, created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
});

let claudeCommentId = 200;

/**
 * PR・Issue のコメントとして置ける着手宣言（Claude の目印と agent-claim ブロック。本文は agent.ts の claimBody と同じ形）。
 * at の既定は今の時刻（ゲートは実行時の時刻で期限を数えるため）。association の既定は OWNER（信頼できる作成者）
 */
export function claimComment(opts: { stage?: ClaimStage; by?: 'manual' | 'routine'; at?: string; released?: boolean; association?: string } = {}) {
  const at = opts.at ?? new Date().toISOString();
  const base: Claim = opts.by === 'routine'
    ? { by: 'routine', session: 'https://claude.ai/code/session_01ABCDEFGHxyz', at, ...(opts.stage ? { stage: opts.stage } : {}) }
    : { by: 'manual', at, ...(opts.stage ? { stage: opts.stage } : {}) };
  const value: Claim = opts.released ? { ...base, released: true } : base;
  const who = value.by === 'routine' ? `Routine: ${value.session}` : '手動';
  const what = value.released ? `着手を解除しました（${who}）。` : `着手しました（${who}${value.stage ? `、段階 ${value.stage}` : ''}）。`;
  const id = claudeCommentId++;
  return {
    id, created_at: at, updated_at: '', html_url: `c${id}`, author_association: opts.association ?? 'OWNER', user: { login: 'me', type: 'User' },
    body: [claudeMark(), what, '', renderBlock('agent-claim', value)].join('\n'),
  };
}

/** Claude の判定コメント（agent-verdict ブロック入り。投稿すると着手宣言が終わる） */
export function verdictComment(patch: Partial<Verdict> = {}, association = 'OWNER') {
  const id = claudeCommentId++;
  return {
    id, created_at: new Date().toISOString(), updated_at: '', html_url: `c${id}`, author_association: association, user: { login: 'me', type: 'User' },
    body: [claudeMark(), '判定しました。', '', renderBlock('agent-verdict', verdict(patch))].join('\n'),
  };
}

/** 今から hours 時間前の ISO 時刻 */
export const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
