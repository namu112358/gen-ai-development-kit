import { appMark, renderBlock } from '../../lib/blocks.ts';
import { appLogin, loadConfig } from '../../lib/config.ts';
import { GitHub, type RequestOptions, type Transport } from '../../lib/github.ts';
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

/**
 * 判定の受け付けに必要な応答を揃えた偽の GitHub。
 * dashboardEvents はダッシュボード（#1）の timeline の応答（委任 Merge のラベルを付けた記録）、
 * closedPrs は閉じた PR の一覧（GET /pulls?state=closed。定期実行のダッシュボードの「委任 Merge で Merge された PR」）の応答。
 */
export function acceptanceFake(state: { pr: ReturnType<typeof pr>; dashboardLabels?: string[]; prComments?: unknown[]; allowAutoMerge?: boolean; behindBy?: number; dashboardEvents?: unknown[]; closedPrs?: unknown[] }): FakeGitHub {
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
    .on('GET', /\/pulls\?state=closed/, () => state.closedPrs ?? [])
    .on('GET', /\/issues\/1\/timeline/, () => state.dashboardEvents ?? [])
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

/** 委任 Merge のテスト用の世界（delegateWorldFake が書き込みを反映する） */
export interface DelegateWorld {
  /** 開いた PR（auto_merge は GraphQL の付け外しで書き換わる） */
  prs: Record<string, any>[];
  /** 閉じた PR の一覧（GET /pulls?state=closed）の応答。/pulls/{n} でも返す */
  closedPrs?: Record<string, any>[];
  /** Issue・PR ごとのコメント（App のコメントの POST が足される）。#3 は既定で planGateComment */
  comments?: Record<number, unknown[]>;
  /** PR ごとの変更ファイル（既定は docs/a.md） */
  files?: Record<number, string[]>;
  /** すべての PR の差分（既定は DIFF） */
  diff?: string;
  /** ダッシュボード（#1）のラベル（ラベルの付け外しが反映される） */
  dashboardLabels: string[];
  /** ダッシュボードの timeline（ラベルの付け外しが足される） */
  dashboardEvents?: unknown[];
}

/**
 * 委任 Merge のテスト用。複数の PR・ダッシュボードのラベルと timeline・閉じた PR の一覧を持つ偽の GitHub。
 * App のコメント・ダッシュボードのラベルの付け外し・auto-merge の付け外しを w に反映する（続けて別のイベントを渡すと、その後の状態を読む）。
 */
export function delegateWorldFake(w: DelegateWorld): FakeGitHub {
  const comments = (w.comments ??= {});
  const events = (w.dashboardEvents ??= []);
  const all = (): Record<string, any>[] => [...w.prs, ...(w.closedPrs ?? [])];
  const dashboard = () => ({ number: 1, title: config.dashboardIssueTitle, html_url: 'd', updated_at: '2026-09-27T00:00:00Z', user: { login: APP }, labels: w.dashboardLabels.map((name) => ({ name })) });
  let nextId = 1000;
  return new FakeGitHub()
    .on('GET', /\/repos\/o\/r$/, () => ({ allow_auto_merge: true }))
    .on('GET', /\/pulls\/(\d+)$/, (m) => {
      const found = all().find((p) => p.number === Number(m[1]));
      if (!found) throw new Error(`404 pulls/${m[1]}`);
      return { ...found };
    })
    .on('GET', /\/compare\//, (_m, _b, o) => (o.raw ? (w.diff ?? DIFF) : { behind_by: 0 }))
    .on('GET', /\/pulls\/(\d+)\/files/, (m) => (w.files?.[Number(m[1])] ?? ['docs/a.md']).map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/pulls\/\d+\/reviews/, () => [])
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => comments[Number(m[1])] ?? (Number(m[1]) === 3 ? [planGateComment] : []))
    .on('GET', /\/issues\/\d+\/events/, () => [])
    .on('GET', /\/issues\/1\/timeline/, () => events)
    .on('GET', /\/pulls\?state=open/, () => w.prs.map((p) => ({ ...p })))
    .on('GET', /\/pulls\?state=closed/, () => w.closedPrs ?? [])
    .on('GET', /\/issues\?state=open&creator=/, () => [dashboard()])
    .on('GET', /\/issues\?state=open&per_page/, () => [dashboard()])
    .on('GET', /\/issues\/1$/, () => ({ ...dashboard(), body: '' }))
    .on('PATCH', /\/issues\/1$/, () => ({}))
    .on('POST', /\/graphql/, (_m, body) => {
      const q = String(body.query);
      if (q.includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: 'o/r' } }] } } } } };
      if (q.includes('closedByPullRequestsReferences')) return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } };
      const target = all().find((p) => p.node_id === body.variables?.id);
      if (target && q.includes('enablePullRequestAutoMerge')) target.auto_merge = { enabled: true };
      if (target && q.includes('disablePullRequestAutoMerge')) target.auto_merge = null;
      if (target && q.includes('markPullRequestReadyForReview')) target.draft = false;
      if (target && q.includes('convertPullRequestToDraft')) target.draft = true;
      return { data: {} };
    })
    .on('POST', /\/issues\/(\d+)\/comments$/, (m, body) => {
      const c = { id: nextId++, created_at: new Date().toISOString(), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: String(body.body) };
      (comments[Number(m[1])] ??= Number(m[1]) === 3 ? [planGateComment] : []).push(c);
      return c;
    })
    .on('POST', /\/check-runs/, () => ({}))
    .on('POST', /\/pulls\/\d+\/reviews/, () => ({}))
    .on('PUT', /\/pulls\/\d+\/(update-branch|merge)/, () => ({}))
    .on('POST', /\/issues\/(\d+)\/labels$/, (m, body) => {
      if (Number(m[1]) === 1) {
        for (const name of body.labels as string[]) {
          w.dashboardLabels.push(name);
          events.push({ event: 'labeled', created_at: new Date().toISOString(), label: { name }, actor: { login: APP } });
        }
      }
      return [];
    })
    .on('DELETE', /\/issues\/(\d+)\/labels\/(.+)$/, (m) => {
      const name = decodeURIComponent(m[2]!);
      if (Number(m[1]) === 1) {
        w.dashboardLabels = w.dashboardLabels.filter((l) => l !== name);
        events.push({ event: 'unlabeled', created_at: new Date().toISOString(), label: { name }, actor: { login: APP } });
      }
      return null;
    });
}
