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
import { onMainPush } from '../gates/on-main-push.ts';

/** 偽の GitHub。呼び出しを記録し、ルートごとの応答を返す */
class FakeGitHub implements Transport {
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

const config = loadConfig();
const APP = appLogin(config);
const HEAD = 'a'.repeat(40);
const DIFF = 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+b\n';

function ctxFor(fake: FakeGitHub, eventName: string, event: unknown): GateContext {
  return { config, gh: new GitHub(fake, 'o/r'), repository: 'o/r', eventName, event, secrets: {}, log: () => {} };
}

function pr(patch: Record<string, unknown> = {}) {
  return {
    number: 5, state: 'open', draft: true, node_id: 'PR_5', title: 'docs: t', body: 'Closes #3', html_url: 'u', updated_at: '2026-09-26T00:00:00Z',
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
function acceptanceFake(state: { pr: ReturnType<typeof pr>; dashboardLabels?: string[]; prComments?: unknown[]; allowAutoMerge?: boolean; behindBy?: number }): FakeGitHub {
  let autoMerge: unknown = state.pr.auto_merge;
  return new FakeGitHub()
    .on('GET', /\/repos\/o\/r$/, () => ({ allow_auto_merge: state.allowAutoMerge ?? true }))
    .on('GET', /\/pulls\/5$/, () => ({ ...state.pr, auto_merge: autoMerge }))
    .on('GET', /\/compare\//, (_m, _b, o) => (o.raw ? DIFF : { behind_by: state.behindBy ?? 0 }))
    .on('GET', /\/pulls\/5\/files/, () => [{ filename: 'docs/a.md', additions: 1, deletions: 1 }])
    .on('GET', /\/pulls\/5\/reviews/, () => [])
    .on('GET', /\/issues\/3\/comments/, () => [planGateComment])
    .on('GET', /\/issues\/5\/comments/, () => state.prComments ?? [])
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
    .on('GET', /\/compare\/main\.\.\.c+$/, (_m, _b, o) => (o.raw ? DIFF.replace('+b', '+changed') : { behind_by: 0 }));
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

test('人の PR は判定が出るまで agent/review を書かない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }), dashboardLabels: [] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.ok(!w.some((x) => x.startsWith('check:agent/review')));
  assert.ok(w.includes('check:agent/plan-link=success') && w.includes('check:merge-route=success'));
});

test('review:exempt を付けると agent/review を通し、App が記録する。外すと判定待ちに戻す', async () => {
  const human = { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } };
  const on = acceptanceFake({ pr: pr({ head: human, labels: [{ name: 'review:exempt' }] }), dashboardLabels: [] });
  await onPullRequest(ctxFor(on, 'pull_request_target', { action: 'labeled', label: { name: 'review:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.ok(on.writes().includes('comment:review-exempt') && on.writes().includes('check:agent/review=success'));
  const off = acceptanceFake({ pr: pr({ head: human }), dashboardLabels: [] });
  await onPullRequest(ctxFor(off, 'pull_request_target', { action: 'unlabeled', label: { name: 'review:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.ok(off.writes().includes('check:agent/review=failure'));
});

test('人の PR の判定を受け付け、合格なら agent/review を通すが auto-merge は付けない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(w.includes('comment:human-review'));
  assert.equal(w.at(-1), 'check:agent/review=success');
});

test('fork の PR の判定は受け付けない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'claude/x', sha: HEAD, repo: { full_name: 'evil/r' } } }), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.deepEqual(fake.writes(), ['comment:verdict-rejected']);
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
  assert.deepEqual(fake.writes(), ['label+agent:plan-ok', 'comment:plan-gate', 'check:agent/plan-link=success'], '計画を投稿したら、その Issue を Closes する PR の plan-link を書き直す');
  assert.match(fake.calls.find((c) => c.path.endsWith('/issues/3/comments') && c.method === 'POST')!.body.body, /"files": \[\s*"docs\/a.md"/);

  const stop = acceptanceFake({ pr: pr() });
  await onComment(ctxFor(stop, 'issue_comment', event({ ...plan, openQuestions: ['?'] })));
  assert.deepEqual(stop.writes(), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate', 'check:agent/plan-link=success'], '人の判断待ちの計画も計画ありとみなす');
});

test('App 以外が付けた plan-ok は外す', async () => {
  const fake = acceptanceFake({ pr: pr() });
  await onIssue(ctxFor(fake, 'issues', { action: 'labeled', label: { name: 'agent:plan-ok' }, sender: { login: 'me' }, issue: { number: 3, body: '', labels: [], state: 'open' } }));
  assert.deepEqual(fake.writes(), ['label-agent:plan-ok', 'comment:plan-ok-removed']);
  const byApp = acceptanceFake({ pr: pr() });
  await onIssue(ctxFor(byApp, 'issues', { action: 'labeled', label: { name: 'agent:plan-ok' }, sender: { login: APP }, issue: { number: 3, body: '', labels: [], state: 'open' } }));
  assert.equal(byApp.calls.length, 0);
});

test('受け付け中に別の操作で auto-merge が付けられたら、merge-route を failure に書き直す', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [] });
  let enabledBySomeoneElse = false;
  fake.on('POST', /\/check-runs/, (_m, body) => {
    // agent/risk を書いた直後に、Routine（本人名義）が medium の PR に auto-merge を付けた想定
    if (body.name === 'agent/risk') enabledBySomeoneElse = true;
    return {};
  });
  fake.on('GET', /\/pulls\/5$/, () => ({ ...pr(), auto_merge: enabledBySomeoneElse ? { enabled: true } : null }));
  const v = verdict({ risk: { ...verdict().risk, level: 'medium' } });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v))));
  const w = fake.writes();
  assert.equal(w.at(-1), 'check:merge-route=failure', '最後に書かれた merge-route が failure');
});

test('auto-merge を付けられないとき（チェックが揃い済み）は、検証した head を指定して直接 Merge する', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [] });
  fake.on('POST', /\/graphql/, (_m, body) => {
    if (String(body.query).includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: 'o/r' } }] } } } } };
    if (String(body.query).includes('enablePullRequestAutoMerge')) throw new Error('Pull request is in clean status');
    return { data: {} };
  });
  let mergedWith: any = null;
  fake.on('PUT', /\/pulls\/5\/merge/, (_m, body) => (mergedWith = body));
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.deepEqual(mergedWith, { sha: HEAD, merge_method: 'squash' });
  assert.equal(fake.writes().at(-1), `PUT /repos/o/r/pulls/5/merge`);
});

test('hold を外すと、条件を満たす判定があれば auto-merge を付け直す', async () => {
  const { patchId } = await import('../lib/patch-id.ts');
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: true, reasons: [] };
  const prComments = [{ id: 91, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: `${appMark('acceptance')}\n${renderBlock('agent-app', acceptance)}` }];
  const fake = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], prComments });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'unlabeled', label: { name: 'agent:hold' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.ok(w.includes('comment:hold-removed'));
  assert.ok(w.indexOf('enablePullRequestAutoMerge') < w.indexOf('check:agent/review=success'));
});

test('リポジトリ設定の Allow auto-merge が切れていれば、auto-merge も直接 Merge もしない', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [], allowAutoMerge: false });
  let merged = false;
  fake.on('PUT', /\/pulls\/5\/merge/, () => (merged = true));
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'));
  assert.equal(merged, false);
  assert.ok(fake.writes().includes('comment:human-review'));
});

test('Issue が閉じたら進み具合のラベルを外す（hold は残す）', async () => {
  const fake = acceptanceFake({ pr: pr() })
    .on('POST', /\/graphql/, () => ({ data: { repository: { issue: { blocking: { nodes: [] }, parent: null } } } }));
  await onIssue(ctxFor(fake, 'issues', { action: 'closed', sender: { login: 'me' }, issue: { number: 3, body: '', state: 'closed', labels: [{ name: 'agent:ready' }, { name: 'agent:in-pr' }, { name: 'agent:hold' }, { name: 'risk:low' }] } }));
  const w = fake.writes().filter((x) => x.startsWith('label-'));
  assert.deepEqual(w, ['label-agent:ready', 'label-agent:in-pr']);
});

test('plan-link：計画のある Issue を Closes しない PR は failure、plan:exempt なら success', async () => {
  const none = acceptanceFake({ pr: pr({ head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }) })
    .on('POST', /\/graphql/, (_m, body) => (String(body.query).includes('closingIssuesReferences') ? { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } } : { data: {} }));
  await onPullRequest(ctxFor(none, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(none.writes().includes('check:agent/plan-link=failure'));

  const exempt = acceptanceFake({ pr: pr({ labels: [{ name: 'plan:exempt' }], head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }) });
  await onPullRequest(ctxFor(exempt, 'pull_request_target', { action: 'labeled', label: { name: 'plan:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.deepEqual(exempt.writes(), ['check:agent/plan-link=success', 'comment:plan-exempt']);
});

test('auto-merge を付けたとき main より遅れていれば、その場で追従させる', async () => {
  for (const [behindBy, expected] of [[1, true], [0, false]] as const) {
    const fake = acceptanceFake({ pr: pr(), dashboardLabels: [], behindBy });
    let updated = false;
    fake.on('PUT', /\/pulls\/5\/update-branch/, () => (updated = true));
    await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
    assert.ok(fake.writes().includes('enablePullRequestAutoMerge'));
    assert.equal(updated, expected, `behind_by=${behindBy}`);
  }
});

test('人へのレビュー依頼に、懸念点・見てほしい箇所・Risk の根拠を載せる', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [] });
  const v = verdict({ risk: { ...verdict().risk, level: 'medium', rationale: 'API の挙動が変わる' }, review: { pass: true, blocking: [], nonBlocking: [], humanNotes: { concerns: ['空配列のとき例外になりうる'], checkPoints: ['src/a.ts の parse'] } } });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v))));
  const body = fake.calls.find((c) => String(c.body?.body ?? '').includes('kind=human-review'))!.body.body as string;
  assert.match(body, /### 懸念点\n- 空配列のとき例外になりうる/);
  assert.match(body, /### 見てほしい箇所\n- src\/a.ts の parse/);
  assert.match(body, /API の挙動が変わる/);
});

test('判定前に Ready で出された PR は Draft に戻す。判定を引き継げる push と例外ラベルでは戻さない', async () => {
  const ready = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], prComments: [] });
  await onPullRequest(ctxFor(ready, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(ready.writes().includes('convertPullRequestToDraft') && ready.writes().includes('comment:draft-until-judged'));

  const exempt = acceptanceFake({ pr: pr({ draft: false, labels: [{ name: 'review:exempt' }] }), dashboardLabels: [], prComments: [] });
  await onPullRequest(ctxFor(exempt, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(!exempt.writes().includes('convertPullRequestToDraft'));

  const { patchId } = await import('../lib/patch-id.ts');
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: true, reasons: [] };
  const prComments = [{ id: 91, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: `${appMark('acceptance')}\n${renderBlock('agent-app', acceptance)}` }];
  const carried = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], prComments });
  await onPullRequest(ctxFor(carried, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  assert.ok(!carried.writes().includes('convertPullRequestToDraft'));
});

test('agent/title：PR のタイトルの形式を検査する', async () => {
  const ok = acceptanceFake({ pr: pr({ title: 'fix(harness): 直す' }), dashboardLabels: [] });
  await onPullRequest(ctxFor(ok, 'pull_request_target', { action: 'edited', pull_request: { number: 5 } }));
  assert.equal(ok.writes()[0], 'check:agent/title=success');
  const ng = acceptanceFake({ pr: pr({ title: '直す' }), dashboardLabels: [] });
  await onPullRequest(ctxFor(ng, 'pull_request_target', { action: 'edited', pull_request: { number: 5 } }));
  assert.equal(ng.writes()[0], 'check:agent/title=failure');
});

test('形式でない Issue タイトルは agent:ready で blocked になる', async () => {
  const fake = acceptanceFake({ pr: pr() });
  const body = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\nx`).join('\n\n');
  await onIssue(ctxFor(fake, 'issues', { action: 'labeled', label: { name: 'agent:ready' }, sender: { login: 'me' }, issue: { number: 3, title: '用語集に追加', body, labels: [], state: 'open' } }));
  assert.deepEqual(fake.writes(), ['label+agent:blocked', 'comment:form-error']);
});

test('main への push で、auto-merge 待ちでない Agent PR も main に追従させる', async () => {
  const fake = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], behindBy: 2 });
  fake.on('GET', /\/pulls\?state=open/, () => [pr()]);
  let updated = false;
  fake.on('PUT', /\/pulls\/5\/update-branch/, () => (updated = true));
  await onMainPush(ctxFor(fake, 'push', { commits: [{ id: 'x', message: 'docs: 何か' }] }));
  assert.equal(updated, true);
});
