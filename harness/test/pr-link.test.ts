import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHub } from '../lib/github.ts';
import { bodyIssueRefs, linkedIssues, openPrsClosing, plannedFilesForPr, planLinkedIssues, withStack } from '../lib/state.ts';
import { FakeGitHub, config, planGateComment, pr } from './support/gate-fixtures.ts';
import { FEATURE_BASE, STACK, countCalls, stackedPr } from './support/stack-fixtures.ts';

/**
 * PR と Issue の紐付けの入口（state.ts の bodyIssueRefs・linkedIssues・withStack）。
 * スタックの層は本文の Refs #N・Closes #N を App が読み、それ以外は GitHub の closingIssuesReferences に頼る
 * （base が既定ブランチの PR で一覧が空なら、本文の Closes で補う。PR を作った直後の反映の遅れ）。
 */

const numbers = (body: string | null) => bodyIssueRefs(body).map((r) => r.number);
const graphqlCalls = (fake: FakeGitHub, name: string) => fake.calls.filter((c) => c.path === '/graphql' && String(c.body?.query).includes(name)).length;

/** closingIssuesReferences と closedByPullRequestsReferences の応答を決めた偽の GitHub。detail は GET /pulls/5 の応答 */
function linkFake(opts: { detail?: unknown; closing?: number[]; closedBy?: number[]; list?: unknown[] } = {}): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/pulls\/5$/, () => opts.detail ?? pr())
    .on('GET', /\/pulls\/7$/, () => stackedPr({ number: 7, body: 'Refs #3' }))
    .on('GET', /\/pulls\?state=open/, () => opts.list ?? [])
    .on('GET', /\/issues\/3\/comments/, () => [planGateComment])
    .on('GET', /\/issues\/4\/comments/, () => [])
    .on('POST', /\/graphql/, (_m, body) => {
      const q = String(body.query);
      if (q.includes('closingIssuesReferences')) {
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: (opts.closing ?? []).map((number) => ({ number, repository: { nameWithOwner: 'o/r' } })) } } } } };
      }
      if (q.includes('closedByPullRequestsReferences')) {
        return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: (opts.closedBy ?? []).map((number) => ({ number, state: 'OPEN', repository: { nameWithOwner: 'o/r' } })) } } } } };
      }
      return { data: {} };
    });
}
const ghOf = (fake: FakeGitHub) => new GitHub(fake, 'o/r');

// ---- bodyIssueRefs（本文の Refs #N・Closes #N を読む純粋な関数） ----

test('bodyIssueRefs：Refs は refs、GitHub の閉じるキーワードの別形は closes として読む（大文字小文字・直後の : を問わない）', () => {
  assert.deepEqual(bodyIssueRefs('Refs #3'), [{ number: 3, keyword: 'refs' }]);
  assert.deepEqual(bodyIssueRefs('refs: #3'), [{ number: 3, keyword: 'refs' }]);
  assert.deepEqual(bodyIssueRefs('REFS #3'), [{ number: 3, keyword: 'refs' }]);
  for (const word of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved', 'Closes', 'FIXES', 'Resolved:']) {
    assert.deepEqual(bodyIssueRefs(`${word} #4`), [{ number: 4, keyword: 'closes' }], word);
  }
});

test('bodyIssueRefs：キーワードの無い #N・別リポジトリの owner/repo#N・URL は読まない', () => {
  assert.deepEqual(numbers('#3 を見てください'), []);
  assert.deepEqual(numbers('Refs o/r#3'), []);
  assert.deepEqual(numbers('Closes other/repo#9'), []);
  assert.deepEqual(numbers('Refs https://github.com/o/r/issues/3'), []);
  assert.deepEqual(numbers(null), []);
  assert.deepEqual(numbers(''), []);
});

test('bodyIssueRefs：HTML コメントとフェンスのコードブロックの中は読まない', () => {
  assert.deepEqual(numbers('<!-- 下の層は Refs #1、一番上は Closes #2 と書く -->\n本文'), []);
  assert.deepEqual(numbers('<!--\nRefs #1\n-->\nRefs #3'), [3]);
  assert.deepEqual(numbers('例：\n```\nRefs #1\nCloses #2\n```\nRefs #3'), [3]);
  assert.deepEqual(numbers('~~~md\nCloses #2\n~~~\nCloses #4'), [4]);
});

test('bodyIssueRefs：同じ番号は1つにまとめ、本文に出てくる順に返す', () => {
  assert.deepEqual(numbers('Closes #5\nRefs #3\nRefs #5\nfixes #3'), [5, 3]);
  assert.equal(bodyIssueRefs('Refs #3\nCloses #3').length, 1);
});

// ---- linkedIssues（紐付けの入口） ----

test('linkedIssues：スタックの層（stacked）は本文の Refs #N を読み、closingIssuesReferences を呼ばない', async () => {
  const fake = linkFake({ closing: [99] });
  assert.deepEqual(await linkedIssues(ghOf(fake), config, stackedPr({ body: 'Refs #3' })), [3]);
  assert.deepEqual(await linkedIssues(ghOf(fake), config, stackedPr({ body: 'Closes #4' })), [4], '一番上の層の Closes #N も本文から読む');
  assert.equal(graphqlCalls(fake, 'closingIssuesReferences'), 0);
});

test('linkedIssues：スタックでない PR は closingIssuesReferences（本文の Refs #N は読まない）', async () => {
  const fake = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(fake), config, pr({ body: 'Refs #3' })), []);
  assert.equal(graphqlCalls(fake, 'closingIssuesReferences'), 1);
  const closing = linkFake({ closing: [3] });
  assert.deepEqual(await linkedIssues(ghOf(closing), config, pr({ body: 'Closes #3' })), [3]);
});

test('linkedIssues：形の崩れた stack・一番下が既定ブランチ宛てでない stack（orphan-base）は本文の Refs を読まない', async () => {
  const malformed = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(malformed), config, stackedPr({ body: 'Refs #3', stack: { ...STACK, position: 'x' } })), []);
  assert.equal(graphqlCalls(malformed, 'closingIssuesReferences'), 1);
  const orphan = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(orphan), config, stackedPr({ body: 'Refs #3', stack: { ...STACK, base: { ref: 'develop', sha: 'c'.repeat(40) } } })), []);
  assert.equal(graphqlCalls(orphan, 'closingIssuesReferences'), 1);
  const noStack = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(noStack), config, pr({ base: FEATURE_BASE, body: 'Refs #3' })), [], 'stack の無い別ブランチ宛ての PR');
});

// ---- withStack（一覧の要素の取り直し） ----

test('withStack：一覧の要素に stack のキーがあれば取り直さない', async () => {
  const fake = linkFake();
  const item = stackedPr({ body: 'Refs #3' });
  assert.equal(await withStack(ghOf(fake), config, item), item);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/pulls/5'), 0);
});

test('withStack：既定ブランチ宛てで Refs の無い PR は取り直さない（API の呼び出しを増やさない）', async () => {
  const fake = linkFake();
  const item = pr({ body: 'Closes #3' });
  assert.equal(await withStack(ghOf(fake), config, item), item);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/pulls/5'), 0);
});

test('withStack：stack のキーが無く、base が既定ブランチでないか本文に Refs があれば /pulls/{n} で取り直す', async () => {
  const detail = stackedPr({ body: 'Refs #3' });
  const offBase = linkFake({ detail });
  const got = await withStack(ghOf(offBase), config, pr({ base: FEATURE_BASE, body: 'Refs #3' }));
  assert.deepEqual((got as { stack?: unknown }).stack, STACK);
  assert.equal(countCalls(offBase, 'GET', '/repos/o/r/pulls/5'), 1);

  const refsOnMain = linkFake({ detail });
  await withStack(ghOf(refsOnMain), config, pr({ body: 'Refs #3' }));
  assert.equal(countCalls(refsOnMain, 'GET', '/repos/o/r/pulls/5'), 1);
});

// ---- 範囲照合・判定の受け付け・plan-link が同じ紐付けを使う ----

test('plannedFilesForPr：スタックの層の Refs #N の Issue の計画の files を返す（番号で呼ばれたら /pulls/{n} を取り直す）', async () => {
  const fake = linkFake({ detail: stackedPr({ body: 'Refs #3' }), closing: [] });
  assert.deepEqual(await plannedFilesForPr(ghOf(fake), config, 5), { files: ['docs/**'] });
  assert.ok(countCalls(fake, 'GET', '/repos/o/r/pulls/5') >= 1);
  assert.deepEqual(await plannedFilesForPr(ghOf(linkFake({ closing: [] })), config, stackedPr({ body: 'Refs #3' })), { files: ['docs/**'] }, 'PR のオブジェクトも渡せる');
});

test('plannedFilesForPr：見つからないときの文言は、スタックの層なら Refs か Closes、スタックでない PR は今のまま', async () => {
  const layer = await plannedFilesForPr(ghOf(linkFake({ closing: [] })), config, stackedPr({ body: '説明だけ' }));
  assert.ok('missing' in layer && layer.missing.includes('Refs #番号') && layer.missing.includes('Closes #番号'), JSON.stringify(layer));
  const plain = await plannedFilesForPr(ghOf(linkFake({ closing: [] })), config, pr({ body: 'Refs #3' }));
  assert.deepEqual(plain, { missing: '本文に `Closes #番号` がありません' });
});

test('planLinkedIssues：スタックの層は本文の Issue を計画のある／無いに分ける', async () => {
  const fake = linkFake({ closing: [] });
  assert.deepEqual(await planLinkedIssues(ghOf(fake), config, stackedPr({ body: 'Refs #3' })), { linked: [3], unplanned: [] });
  assert.deepEqual(await planLinkedIssues(ghOf(fake), config, stackedPr({ body: 'Refs #4' })), { linked: [], unplanned: [4] });
  assert.deepEqual(await planLinkedIssues(ghOf(fake), config, pr({ body: 'Refs #3' })), { linked: [], unplanned: [] }, 'スタックでない PR の Refs は紐付かない');
});

// ---- openPrsClosing（計画の投稿で plan-link を書き直す相手） ----

test('openPrsClosing：Closes する PR（GraphQL）に、本文でその Issue を Refs するスタックの層を足す（GraphQL の分が先、重なりは1つ）', async () => {
  const list = [
    stackedPr({ number: 7, body: 'Refs #3' }),
    pr({ number: 8, body: 'Refs #3' }),
    stackedPr({ number: 9, body: 'Refs #4' }),
    stackedPr({ number: 5, body: 'Closes #3' }),
  ];
  const fake = linkFake({ closedBy: [5], list });
  assert.deepEqual(await openPrsClosing(ghOf(fake), 3), [5, 7], 'スタックでない PR の Refs・別の Issue の層は入れない');
});

test('openPrsClosing：一覧の要素に stack のキーが無ければ /pulls/{n} で取り直して層かを確かめる', async () => {
  const fake = linkFake({ closedBy: [], list: [pr({ number: 7, base: FEATURE_BASE, body: 'Refs #3' })] });
  assert.deepEqual(await openPrsClosing(ghOf(fake), 3), [7]);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/pulls/7'), 1);
});
