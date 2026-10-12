// Issue #713：Issue と Draft PR を GraphQL を使わず REST だけで作る入口（harness/lib/gh-rest-create.ts の rejectedLabels・restCreateIssue・restCreateDraftPr と、
// harness/scripts/agent/commands/gh-rest-create.ts の createProtectedLabels）を確かめる。
// 守り（agentBranchPrefix でないブランチ・その Issue を Closes/Refs しない本文・保護ラベル・:exempt のラベル・このセッションの着手宣言が無い・番号が PR）に当たれば
// 書き込み（GET 以外）が0件で止まること、拒む一覧が guard の protectedLabelsOf と同じこと（このリポジトリの設定と、ラベルの名前を変えた設定）、
// 通る入力で POST /pulls の本文が draft: true になること、どの呼び出しも /graphql に行かないことを、偽の GitHub（FakeGitHub）の calls で見る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectedLabelsOf } from '../../.claude/hooks/guard.ts';
import * as configLib from '../lib/config.ts';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { rejectedLabels, restCreateDraftPr, restCreateIssue } from '../lib/gh-rest-create.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import type { StoredClaim } from '../lib/queue.ts';
import { CLAIM_SESSION, claimComment } from './support/claim-fixtures.ts';
import { FakeGitHub } from './support/gate-fixtures.ts';

/** commands のファイルは cli.ts を import し、cli.ts は読み込み時に harness.config.json を読むので、使うときだけ読み込む */
const loadCommand = () => import('../scripts/agent/commands/gh-rest-create.ts');

const config = loadConfig();
const PROTECTED = protectedLabelsOf(config, configLib);
const OTHER_SESSION = '99999999-0000-4000-8000-000000000000';

const now = () => new Date().toISOString();
const ownClaim = (patch: Partial<StoredClaim> = {}): IssueComment =>
  claimComment(300, { by: 'manual', session: CLAIM_SESSION, at: now(), stage: 'implement', ...patch } as StoredClaim, now());

/** 書き込み（GET 以外）の呼び出し */
const writesOf = (fake: FakeGitHub) => fake.calls.filter((c) => c.method !== 'GET');
const graphqlOf = (fake: FakeGitHub) => fake.calls.filter((c) => c.path.startsWith('/graphql'));

/** Issue #7 の世界。comments は #7 のコメント、isPr なら GET /issues/7 に pull_request が付く */
function world(opts: { comments?: IssueComment[]; isPr?: boolean } = {}): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /^\/repos\/o\/r\/issues\/7$/, () => ({ number: 7, state: 'open', title: 'feat: x', labels: [], ...(opts.isPr ? { pull_request: { url: 'p' } } : {}) }))
    .on('GET', /^\/repos\/o\/r\/issues\/7\/comments(\?|$)/, () => opts.comments ?? [ownClaim()])
    .on('POST', /^\/repos\/o\/r\/pulls$/, () => ({ number: 42, html_url: 'https://github.com/o/r/pull/42', draft: true }))
    .on('POST', /^\/repos\/o\/r\/issues$/, () => ({ number: 50, html_url: 'https://github.com/o/r/issues/50' }))
    .on('POST', /^\/repos\/o\/r\/issues\/\d+\/labels$/, () => []);
}

const prInput = (patch: Partial<{ issue: number; head: string; base: string; title: string; body: string; labels: string[] }> = {}) => ({
  issue: 7, head: 'claude/issue-7-x', title: 'feat: x', body: '説明\n\nCloses #7', labels: [] as string[], ...patch,
});
const prOpts = (patch: Partial<{ session: string | null; assignee: () => Promise<string | null> }> = {}) => ({
  prefix: config.agentBranchPrefix, defaultBranch: 'main', protectedLabels: PROTECTED, session: CLAIM_SESSION as string | null, ...patch,
});

// --- AC2：拒む一覧 ---

test('createProtectedLabels：このリポジトリの設定と、ラベルの名前を変えた設定の両方で guard の protectedLabelsOf と同じ一覧になる', async () => {
  const { createProtectedLabels } = await loadCommand();
  const renamed: HarnessConfig = {
    ...config,
    autoMergeStopLabel: 'custom:stopped',
    delegate: { planLabel: 'custom:delegate-plan', mergeLabel: 'custom:delegate-merge' },
    bypassMerge: { label: 'custom:bypass' },
    autoMode: { ...config.autoMode, label: 'custom:auto' },
  } as HarnessConfig;
  for (const [name, cfg] of [['このリポジトリ', config], ['名前を変えた設定', renamed]] as const) {
    const expected = protectedLabelsOf(cfg, configLib);
    assert.deepEqual([...createProtectedLabels(cfg)].sort(), [...expected].sort(), name);
    // 一覧の全部（大文字に変えたもの・前後に空白を足したものも）が拒まれる
    for (const l of expected) {
      for (const v of [l, l.toUpperCase(), `  ${l} `]) assert.deepEqual(rejectedLabels([v], createProtectedLabels(cfg)), [v], `${name}: ${JSON.stringify(v)} を拒むべき`);
    }
  }
  assert.ok(protectedLabelsOf(renamed, configLib).includes('custom:auto'), '名前を変えた設定が一覧に反映されていない（テストの前提）');
});

test('rejectedLabels：保護ラベル・:exempt で終わるもの・空のラベルを入力の文字列のまま返し、ほかは通す', () => {
  const cases: [string[], string[]][] = [
    [['type:feat', 'priority:high', 'area:harness', 'agent:ready'], []],
    [['review:exempt'], ['review:exempt']],
    [['test:exempt'], ['test:exempt']],
    [['Test:EXEMPT '], ['Test:EXEMPT ']],
    [[''], ['']],
    [['   '], ['   ']],
    [['type:feat', ' Agent:Plan-OK ', 'test:exempt', 'priority:high'], [' Agent:Plan-OK ', 'test:exempt']],
    [[], []],
  ];
  for (const [input, expected] of cases) assert.deepEqual(rejectedLabels(input, PROTECTED), expected, JSON.stringify(input));
});

// --- AC1：Draft PR の作成 ---

test('restCreateDraftPr：通る入力は POST /pulls を draft: true で送り、ラベルがあれば /issues/{n}/labels で付ける。/graphql に行かない', async () => {
  const cases: { name: string; input: ReturnType<typeof prInput>; base: string; labels: string[] | null }[] = [
    { name: 'Closes・base 省略・ラベル無し', input: prInput(), base: 'main', labels: null },
    { name: 'Refs・base 指定・ラベルあり', input: prInput({ body: 'Refs #7', base: 'develop', labels: ['type:feat'] }), base: 'develop', labels: ['type:feat'] },
  ];
  for (const c of cases) {
    const fake = world();
    let asked = 0;
    const r = await restCreateDraftPr(new GitHub(fake, 'o/r'), c.input, prOpts({ assignee: async () => { asked++; return null; } }));
    assert.deepEqual(r, { ok: true, number: 42, url: 'https://github.com/o/r/pull/42', isDraft: true }, c.name);
    assert.equal(asked, 1, `${c.name}: Assignee の確かめが呼ばれていない`);
    const writes = writesOf(fake);
    assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ['POST /repos/o/r/pulls', ...(c.labels ? ['POST /repos/o/r/issues/42/labels'] : [])], c.name);
    assert.deepEqual(writes[0]!.body, { title: c.input.title, head: c.input.head, base: c.base, body: c.input.body, draft: true }, c.name);
    if (c.labels) assert.deepEqual(writes[1]!.body, { labels: c.labels }, c.name);
    assert.deepEqual(graphqlOf(fake), [], c.name);
  }
});

test('restCreateDraftPr：守りに当たる入力は理由つきで止まり、書き込みが0件・/graphql に行かない', async () => {
  const cases: { name: string; input?: ReturnType<typeof prInput>; opts?: ReturnType<typeof prOpts>; comments?: IssueComment[]; isPr?: boolean; mention?: string; noReads?: boolean }[] /* noReads：GitHub を読まずに決まる守り（読みもしない） */ = [
    { name: 'head が agentBranchPrefix で始まらない', input: prInput({ head: 'feature/x' }), noReads: true },
    { name: 'head が main', input: prInput({ head: 'main' }), noReads: true },
    { name: '本文がその Issue を参照しない（別の番号）', input: prInput({ body: 'Closes #70' }), noReads: true },
    { name: '本文がキーワード無しで番号だけ', input: prInput({ body: 'see #7' }), noReads: true },
    { name: '本文が空', input: prInput({ body: '' }), noReads: true },
    ...PROTECTED.map((l) => ({ name: `保護ラベル ${l}`, input: prInput({ labels: ['type:feat', l] }), mention: l, noReads: true })),
    { name: '保護ラベル（大文字）', input: prInput({ labels: ['AGENT:PLAN-OK'] }), mention: 'AGENT:PLAN-OK', noReads: true },
    { name: 'test:exempt', input: prInput({ labels: ['test:exempt'] }), mention: 'test:exempt', noReads: true },
    { name: 'review:exempt', input: prInput({ labels: ['review:exempt'] }), mention: 'review:exempt', noReads: true },
    { name: '空のラベル', input: prInput({ labels: [''] }), noReads: true },
    { name: '着手宣言が無い（コメントが空）', comments: [] },
    { name: 'ほかのセッションの着手宣言', comments: [claimComment(301, { by: 'manual', session: OTHER_SESSION, at: now(), stage: 'implement' } as StoredClaim, now())] },
    { name: '自分の宣言が解除済み', comments: [ownClaim({ released: true })] },
    { name: 'このセッションの ID が無い', opts: prOpts({ session: null }) },
    { name: 'Assignee の確かめで止まる', opts: prOpts({ assignee: async () => 'Assignee がほかの人です' }) },
    { name: '番号が PR', isPr: true },
  ];
  for (const c of cases) {
    const fake = world({ comments: c.comments, isPr: c.isPr });
    let asked = 0;
    const opts = c.opts ?? prOpts({ assignee: async () => { asked++; return null; } });
    const r = await restCreateDraftPr(new GitHub(fake, 'o/r'), c.input ?? prInput(), opts);
    assert.equal(r.ok, false, `${c.name}: 止まるべき`);
    if (r.ok) continue;
    assert.ok(r.errors.length > 0 && r.errors.every((e) => typeof e === 'string' && e !== ''), `${c.name}: 理由が無い`);
    if (c.mention) assert.ok(r.errors.some((e) => e.includes(c.mention!)), `${c.name}: 理由に ${c.mention} が無い: ${r.errors.join(' / ')}`);
    assert.deepEqual(writesOf(fake), [], `${c.name}: 書き込みがある`);
    assert.deepEqual(graphqlOf(fake), [], `${c.name}: /graphql に行った`);
    if (c.noReads) assert.deepEqual(fake.calls, [], `${c.name}: GitHub を読まずに決まる守りなのに呼んだ`);
    if (c.isPr) {
      assert.equal(asked, 0, '番号が PR なら Assignee の読みに進まない');
      assert.ok(!fake.calls.some((x) => x.path.includes('/comments')), '番号が PR なら宣言の読みに進まない');
    }
  }
});

test('restCreateDraftPr：GitHub を読まずに決まる守りに複数当たると、理由を全部並べて GitHub を一度も呼ばない', async () => {
  const fake = world();
  const r = await restCreateDraftPr(new GitHub(fake, 'o/r'), prInput({ head: 'feature/x', body: 'Closes #70', labels: ['agent:plan-ok', 'test:exempt'] }), prOpts());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.length >= 3, `ブランチ・本文・ラベルの3つが並ぶべき: ${r.errors.join(' / ')}`);
  assert.ok(r.errors.some((e) => e.includes('agent:plan-ok')) && r.errors.some((e) => e.includes('test:exempt')), r.errors.join(' / '));
  assert.deepEqual(fake.calls, []);
});

// --- AC3：Issue の作成 ---

test('restCreateIssue：通る入力は POST /issues に title・body・labels を送り、番号と URL を返す。/graphql に行かない', async () => {
  const fake = world();
  const input = { title: 'feat: y', body: '本文', labels: ['type:feat', 'priority:high'] };
  const r = await restCreateIssue(new GitHub(fake, 'o/r'), input, PROTECTED);
  assert.deepEqual(r, { ok: true, number: 50, url: 'https://github.com/o/r/issues/50' });
  const writes = writesOf(fake);
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ['POST /repos/o/r/issues']);
  assert.deepEqual(writes[0]!.body, input);
  assert.deepEqual(graphqlOf(fake), []);
});

test('restCreateIssue：保護ラベル・:exempt のラベル・空のラベルは理由つきで止まり、GitHub を一度も呼ばない', async () => {
  const bad = [...PROTECTED, ...PROTECTED.map((l) => l.toUpperCase()), 'test:exempt', 'review:exempt', ''];
  for (const label of bad) {
    const fake = world();
    const r = await restCreateIssue(new GitHub(fake, 'o/r'), { title: 'feat: y', body: '本文', labels: ['type:feat', label] }, PROTECTED);
    assert.equal(r.ok, false, `${JSON.stringify(label)}: 止まるべき`);
    if (r.ok) continue;
    assert.ok(r.errors.length > 0, `${JSON.stringify(label)}: 理由が無い`);
    if (label !== '') assert.ok(r.errors.some((e) => e.includes(label)), `${label}: 理由にラベルが無い: ${r.errors.join(' / ')}`);
    assert.deepEqual(fake.calls, [], `${JSON.stringify(label)}: GitHub を呼んだ`);
  }
});
