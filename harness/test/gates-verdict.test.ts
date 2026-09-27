import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../lib/blocks.ts';
import { onComment } from '../gates/on-comment.ts';
import { config, HEAD, DIFF, ctxFor, pr, verdict, acceptanceFake, verdictEvent } from './support/gate-fixtures.ts';

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
    'label+risk:low',
  ]);
});

test('停止スイッチ中は auto-merge を付けず、人にレビューを依頼する', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [config.autoMergeStopLabel] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(w.includes('comment:human-review'));
  assert.deepEqual(w.slice(-2), ['check:agent/review=success', 'label+risk:low'], 'Human Merge は通す');
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
  assert.deepEqual(w.slice(-2), ['check:agent/review=failure', 'label+risk:low']);
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

test('人の PR の判定を受け付け、合格なら agent/review を通すが auto-merge は付けない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(w.includes('comment:human-review'));
  assert.deepEqual(w.slice(-2), ['check:agent/review=success', 'label+risk:low']);
});

test('fork の PR の判定は受け付けない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'claude/x', sha: HEAD, repo: { full_name: 'evil/r' } } }), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.deepEqual(fake.writes(), ['comment:verdict-rejected']);
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
  assert.deepEqual(w.slice(-2), ['check:merge-route=failure', 'label+risk:medium'], '最後に書かれた merge-route が failure');
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
  assert.deepEqual(fake.writes().slice(-2), [`PUT /repos/o/r/pulls/5/merge`, 'label+risk:low']);
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

test('PR の risk:*：受け付けた判定の Risk を付け、ほかの risk:* を外す（判定し直せば付け替える）', async () => {
  const fake = acceptanceFake({ pr: pr({ labels: [{ name: 'risk:low' }, { name: 'risk:critical' }] }), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict({ risk: { ...verdict().risk, level: 'medium' } })))));
  const w = fake.writes();
  assert.deepEqual(w.slice(-3), ['label-risk:low', 'label-risk:critical', 'label+risk:medium'], '受け付けの書き込みの後に付け替える');
  assert.ok(w.indexOf('check:agent/review=success') < w.indexOf('label-risk:low'));

  const same = acceptanceFake({ pr: pr({ labels: [{ name: 'risk:low' }] }), dashboardLabels: [] });
  await onComment(ctxFor(same, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.ok(!same.writes().some((x) => x.includes('risk:')), '同じ段階なら付け外ししない');
});

test('判定を受け付けなかったときは PR の risk:* を付け替えない', async () => {
  const fake = acceptanceFake({ pr: pr({ labels: [{ name: 'risk:high' }], head: { ref: 'claude/issue-3', sha: 'c'.repeat(40), repo: { full_name: 'o/r' } } }), dashboardLabels: [] })
    .on('GET', /\/compare\/main\.\.\.c+$/, (_m, _b, o) => (o.raw ? DIFF.replace('+b', '+changed') : { behind_by: 0 }));
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.deepEqual(fake.writes(), ['comment:verdict-rejected']);
});
