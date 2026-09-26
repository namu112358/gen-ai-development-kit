import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { appLogin, loadConfig } from '../lib/config.ts';
import { GitHub, type RequestOptions, type Transport } from '../lib/github.ts';
import { RISK_QUESTIONS, type Verdict } from '../lib/verdict.ts';
import type { GateContext } from '../gates/context.ts';
import { onComment } from '../gates/on-comment.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { onIssue } from '../gates/on-issue.ts';

/** 偽の GitHub。呼び出しを記録し、ルートごとの応答を返す */
class FakeGitHub implements Transport {
  calls: { method: string; path: string; body?: any }[] = [];
  private routes: [string, RegExp, (m: RegExpMatchArray, body: any) => unknown][] = [];

  on(method: string, pattern: RegExp, reply: (m: RegExpMatchArray, body: any) => unknown): this {
    this.routes.unshift([method, pattern, reply]);
    return this;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    this.calls.push({ method, path, body: opts.body });
    for (const [m, re, reply] of this.routes) {
      const match = path.match(re);
      if (m === method && match) return reply(match, opts.body);
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

const config = loadConfig();
const APP = appLogin(config);
const HEAD = 'a'.repeat(40);
const DIFF = 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+b\n';

function ctxFor(fake: FakeGitHub, eventName: string, event: unknown): GateContext {
  return { config, gh: new GitHub(fake, 'o/r'), repository: 'o/r', eventName, event, secrets: {}, log: () => {} };
}

function pr(patch: Record<string, unknown> = {}) {
  return {
    number: 5, state: 'open', draft: true, node_id: 'PR_5', title: 't', body: 'Closes #3', html_url: 'u', updated_at: '2026-09-26T00:00:00Z',
    auto_merge: null, labels: [], user: { login: 'me' },
    head: { ref: 'claude/issue-3', sha: HEAD, repo: { full_name: 'o/r' } }, base: { ref: 'main', sha: 'b'.repeat(40) }, ...patch,
  };
}

const planGateComment = {
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files: ['docs/**'] } })}`,
};

function verdict(patch: Partial<Verdict> = {}): Verdict {
  return {
    version: 1, pr: 5, headSha: HEAD,
    review: { pass: true, blocking: [], nonBlocking: [] },
    risk: { level: 'low', answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Verdict['risk']['answers'], rationale: 'docs' },
    facts: { references: 'none', tests: 'none', fileKinds: 'docs' },
    ...patch,
  };
}

/** 判定の受け付けに必要な応答を揃えた偽の GitHub */
function acceptanceFake(state: { pr: ReturnType<typeof pr>; dashboardLabels?: string[]; prComments?: unknown[] }): FakeGitHub {
  let autoMerge: unknown = state.pr.auto_merge;
  return new FakeGitHub()
    .on('GET', /\/pulls\/5$/, () => ({ ...state.pr, auto_merge: autoMerge }))
    .on('GET', /\/compare\//, () => DIFF)
    .on('GET', /\/pulls\/5\/files/, () => [{ filename: 'docs/a.md' }])
    .on('GET', /\/pulls\/5\/reviews/, () => [])
    .on('GET', /\/issues\/3\/comments/, () => [planGateComment])
    .on('GET', /\/issues\/5\/comments/, () => state.prComments ?? [])
    .on('GET', /\/issues\?state=open&creator=/, () => (state.dashboardLabels ? [{ number: 1, title: config.dashboardIssueTitle, labels: state.dashboardLabels.map((name) => ({ name })) }] : []))
    .on('POST', /\/graphql/, (_m, body) => {
      if (String(body.query).includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3 }] } } } } };
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

const verdictEvent = (body: string, association = 'OWNER') => ({
  action: 'created',
  issue: { number: 5, pull_request: {}, labels: [], state: 'open' },
  comment: { id: 70, body, html_url: 'v', author_association: association, created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
});

test('low の判定：Ready 化 → auto-merge → merge-route → agent/risk → agent/review の順', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.deepEqual(fake.writes(), [
    'comment:acceptance',
    'markPullRequestReadyForReview',
    'enablePullRequestAutoMerge',
    'check:merge-route=success',
    'check:agent/risk=success',
    'check:agent/review=success',
  ]);
});

test('停止スイッチ中は auto-merge を付けず、人にレビューを依頼する', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [config.autoMergeStopLabel] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(w.includes('comment:human-review'));
  assert.equal(w.at(-1), 'check:agent/review=success', 'Human Merge は通す');
  assert.ok(w.includes('check:merge-route=success'), 'auto-merge なし＝Human Merge 経路');
});

test('medium の判定：auto-merge を付けない', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict({ risk: { ...verdict().risk, level: 'medium' } })))));
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'));
});

test('範囲外のファイルがあれば auto-merge を付けない', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [] }).on('GET', /\/pulls\/5\/files/, () => [{ filename: 'docs/a.md' }, { filename: 'package.json' }]);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'));
});

test('ブロッキング指摘：Draft のまま App が変更要求、agent/review は failure', async () => {
  const fake = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [] });
  const v = verdict({ review: { pass: false, blocking: [{ kind: 'ac-unmet', detail: 'AC 2' }], nonBlocking: [] } });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v))));
  const w = fake.writes();
  assert.ok(w.includes('convertPullRequestToDraft'));
  assert.ok(w.includes('POST /repos/o/r/pulls/5/reviews'));
  assert.equal(w.at(-1), 'check:agent/review=failure');
});

test('コラボレーター以外の判定コメントは無視する（Q60）', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()), 'NONE')));
  assert.equal(fake.calls.length, 0);
});

test('差分が変わった後の判定は受け付けない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'claude/issue-3', sha: 'c'.repeat(40), repo: { full_name: 'o/r' } } }), dashboardLabels: [] })
    .on('GET', /\/compare\/main\.\.\.c+$/, () => DIFF.replace('+b', '+changed'));
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.deepEqual(fake.writes(), ['comment:verdict-rejected']);
});

test('push：最初に auto-merge を解除し、差分が同じなら判定を引き継ぐ', async () => {
  const { patchId } = await import('../lib/patch-id.ts');
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: true, reasons: [] };
  const prComments = [{ id: 91, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: `${appMark('acceptance')}\n${renderBlock('agent-app', acceptance)}` }];
  const fake = acceptanceFake({ pr: pr({ auto_merge: { enabled: true }, draft: false }), dashboardLabels: [], prComments });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.equal(w[0], 'disablePullRequestAutoMerge', '最初に解除');
  assert.ok(w.indexOf('enablePullRequestAutoMerge') < w.indexOf('check:agent/review=success'));
});

test('push：差分が変わっていれば auto-merge を外したまま、agent/review は書かない', async () => {
  const fake = acceptanceFake({ pr: pr({ auto_merge: { enabled: true }, draft: false }), dashboardLabels: [], prComments: [] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.equal(w[0], 'disablePullRequestAutoMerge');
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.some((x) => x.startsWith('check:agent/review')));
  assert.ok(w.includes('check:merge-route=success'), 'auto-merge なし＝Human Merge 経路');
});

test('Agent 以外の PR は agent/review を判定対象外で通す', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }), dashboardLabels: [] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.deepEqual(fake.writes(), ['check:agent/review=success', 'check:merge-route=success']);
});

test('fork の claude/ ブランチは Agent PR とみなさない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'claude/x', sha: HEAD, repo: { full_name: 'evil/r' } }, auto_merge: { enabled: true } }), dashboardLabels: [] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(fake.writes().includes('check:merge-route=failure'), 'auto-merge が付いていても自動経路に乗らない');
});

test('計画ゲート：通過なら plan-ok と計画の写し、停止なら plan-review', async () => {
  const plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'] };
  const event = (p: unknown) => ({
    action: 'created',
    issue: { number: 3, labels: [{ name: 'agent:ready' }], state: 'open' },
    comment: { id: 80, body: renderBlock('agent-plan', p), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
  });
  const fake = acceptanceFake({ pr: pr() });
  await onComment(ctxFor(fake, 'issue_comment', event(plan)));
  assert.deepEqual(fake.writes(), ['label+agent:plan-ok', 'comment:plan-gate']);
  assert.match(fake.calls.at(-1)!.body.body, /"files": \[\s*"docs\/a.md"/);

  const stop = acceptanceFake({ pr: pr() });
  await onComment(ctxFor(stop, 'issue_comment', event({ ...plan, openQuestions: ['?'] })));
  assert.deepEqual(stop.writes(), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate']);
});

test('App 以外が付けた plan-ok は外す', async () => {
  const fake = acceptanceFake({ pr: pr() });
  await onIssue(ctxFor(fake, 'issues', { action: 'labeled', label: { name: 'agent:plan-ok' }, sender: { login: 'me' }, issue: { number: 3, body: '', labels: [], state: 'open' } }));
  assert.deepEqual(fake.writes(), ['label-agent:plan-ok', 'comment:plan-ok-removed']);
  const byApp = acceptanceFake({ pr: pr() });
  await onIssue(ctxFor(byApp, 'issues', { action: 'labeled', label: { name: 'agent:plan-ok' }, sender: { login: APP }, issue: { number: 3, body: '', labels: [], state: 'open' } }));
  assert.equal(byApp.calls.length, 0);
});
