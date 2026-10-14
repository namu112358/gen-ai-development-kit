// リポジトリの表（REVIEW_REPOS）の行ごとに review-api のレビューを回す prepareRepoReview と runReview（review-api/src/pipeline.ts）を確かめる（Issue #1050）。
// 2行の表で、それぞれの行のキーで作った Claude のクライアントが使われ、月の累計が cost:<owner>/<repo>:<YYYY-MM>（小文字）の鍵に分かれて入ること（AC1）、
// 片方が月の上限で止まってももう片方は posted になること（AC2）、行のキーが無いと Claude と collect を呼ばずに no-api-key の記録が1件付くこと
// （DRY_RUN=1 ならキーを見ない。表に無い・表が壊れている・行の識別子が空なら ok: false で、誤りの文に秘密の値が入らない）（AC3）、
// ほかの行の秘密がログ・投稿したコメント・KV の記録に出ないこと（AC4）を見る。行の budget の上書きそのものは review-api-apply-repo-overrides.test.ts で見る。識別子はすべて架空の値
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, MessagesClient } from '../../review-api/src/claude.ts';
import { costKey, prepareRepoReview, reviewKey, runReview } from '../../review-api/src/pipeline.ts';
import { parseApiReviewComment } from '../../review-api/src/record.ts';
import { answer, baseConfig, CALL_USD, fakeGitHub, HEAD, MODEL, NOW, OTHER, REVIEW_OK, RISK_OK, run } from './support/review-api-pipeline.ts';

const SECRETS = {
  KEY_ONE: 'pem-one-FAKE',
  HOOK_ONE: 'hook-one-FAKE',
  CLAUDE_ONE: 'sk-one-FAKE',
  KEY_TWO: 'pem-two-FAKE',
  HOOK_TWO: 'hook-two-FAKE',
  CLAUDE_TWO: 'sk-two-FAKE',
};
const ALL_SECRET_VALUES = Object.values(SECRETS);

const row = (n: 'one' | 'two', monthlyUsd: number) => {
  const N = n.toUpperCase();
  return {
    installationId: n === 'one' ? '111' : '222',
    app: { clientId: `cid-${n}`, privateKeySecret: `KEY_${N}`, webhookSecret: `HOOK_${N}`, login: `review-${n}[bot]` },
    gateAppLogin: `gate-${n}[bot]`,
    anthropicKeySecret: `CLAUDE_${N}`,
    budget: { monthlyUsd, perReviewUsd: 5 },
  };
};
type Env = Parameters<typeof prepareRepoReview>[0];
const twoRowEnv = (opts: { monthly?: [number, number]; extra?: Record<string, unknown> } = {}): Env => {
  const [m1, m2] = opts.monthly ?? [10, 10];
  return { REVIEW_REPOS: JSON.stringify({ 'o1/r1': row('one', m1), 'o2/r2': row('two', m2) }), ...SECRETS, ...opts.extra };
};

// 行のキーごとに偽の Claude を作る。どのキーのクライアントが何回呼ばれたかを calls に残す
function fakeClients(responsesFor: (key: string) => Message[] = () => [answer(REVIEW_OK), answer(RISK_OK)]) {
  const made: string[] = [];
  const calls: string[] = [];
  let dryRuns = 0;
  const dryRunClient: MessagesClient = { create: async () => assert.fail('dryRun のクライアントはこのテストでは呼ばない') };
  const clients = {
    dryRun(): MessagesClient {
      dryRuns++;
      return dryRunClient;
    },
    anthropic(apiKey: string): MessagesClient {
      made.push(apiKey);
      const responses = responsesFor(apiKey);
      let i = 0;
      return {
        async create() {
          calls.push(apiKey);
          const r = responses[i++];
          if (r === undefined) throw new Error('偽の Claude の応答が足りない');
          return r;
        },
      };
    },
  };
  return { clients, made, calls, dryRunClient, dryRuns: () => dryRuns };
}

function prepared(env: Env, fullName: string, clients: Parameters<typeof prepareRepoReview>[3]) {
  const r = prepareRepoReview(env, baseConfig(), fullName, clients);
  if (!r.ok) assert.fail(`${fullName}: ${r.reason}`);
  return r;
}

// prepareRepoReview の結果だけで runReview を回す。KV は呼び出し元が渡し、2つのリポジトリで共有できる
async function runRepo(prep: ReturnType<typeof prepared>, fullName: string, kv: Map<string, string>, prBody?: string) {
  const [owner, repo] = fullName.split('/') as [string, string];
  const { gh, calls, posted } = fakeGitHub({ pr: { state: 'open', head: HEAD, ...(prBody === undefined ? {} : { body: prBody }) }, comments: [] }, {}, { owner, repo });
  const logs: string[] = [];
  const result = await runReview(
    {
      github: { reader: async () => gh, writer: async () => gh },
      claude: prep.claude,
      kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
      now: () => NOW,
      log: (line) => logs.push(line),
      secrets: prep.secrets,
    },
    { owner, repo, pr: 5, headSha: HEAD, gateAppLogin: prep.runtime.gateAppLogin, reviewAppLogin: prep.runtime.reviewAppLogin, config: prep.config },
  );
  return { result, calls, posted, logs };
}

const near = (actual: string | undefined, expected: number, message: string) =>
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${message}: ${actual}`);

test('AC1: 2行の表で、それぞれの行のキーの Claude のクライアントが使われ、月の累計はリポジトリごとの小文字の鍵に入る', async () => {
  const fake = fakeClients();
  const env = twoRowEnv();
  const kv = new Map<string, string>();
  const one = prepared(env, 'o1/r1', fake.clients);
  const two = prepared(env, 'o2/r2', fake.clients);
  assert.deepEqual(fake.made, [SECRETS.CLAUDE_ONE, SECRETS.CLAUDE_TWO], '行のキーでクライアントを作る');

  const r1 = await runRepo(one, 'o1/r1', kv);
  assert.equal(r1.result.outcome, 'posted');
  assert.deepEqual(fake.calls, [SECRETS.CLAUDE_ONE, SECRETS.CLAUDE_ONE], 'o1/r1 は o1 のキーのクライアントだけを呼ぶ');
  const r2 = await runRepo(two, 'o2/r2', kv);
  assert.equal(r2.result.outcome, 'posted');
  assert.deepEqual(fake.calls.slice(2), [SECRETS.CLAUDE_TWO, SECRETS.CLAUDE_TWO], 'o2/r2 は o2 のキーのクライアントだけを呼ぶ');

  near(kv.get('cost:o1/r1:2026-10'), 2 * CALL_USD, 'o1/r1 の月の累計');
  near(kv.get('cost:o2/r2:2026-10'), 2 * CALL_USD, 'o2/r2 の月の累計');
  assert.equal(kv.has('cost:2026-10'), false, 'リポジトリを分けない古い鍵には書かない');

  // 鍵の owner/repo は小文字
  assert.equal(costKey('O1', 'R1', new Date(NOW)), 'cost:o1/r1:2026-10');
});

test('AC2: 片方のリポジトリが自分の月の上限に達しても、もう片方は自分の鍵と上限で posted になる', async () => {
  const fake = fakeClients();
  // o1 の上限は 1、o2 の上限は 20。o2 の累計（5）は o1 の上限を超えるが o2 の上限には届かない
  const env = twoRowEnv({ monthly: [1, 20] });
  const kv = new Map<string, string>([
    ['cost:o1/r1:2026-10', '1'],
    ['cost:o2/r2:2026-10', '5'],
  ]);

  const r1 = await runRepo(prepared(env, 'o1/r1', fake.clients), 'o1/r1', kv);
  assert.equal(r1.result.outcome, 'budget-exceeded');
  assert.equal(r1.posted.length, 1, 'o1/r1 は止めた記録を1件');
  assert.equal(parseApiReviewComment(r1.posted[0]!)?.outcome, 'budget-exceeded');

  const r2 = await runRepo(prepared(env, 'o2/r2', fake.clients), 'o2/r2', kv);
  assert.equal(r2.result.outcome, 'posted');
  assert.deepEqual(fake.calls, [SECRETS.CLAUDE_TWO, SECRETS.CLAUDE_TWO], 'Claude を呼ぶのは o2/r2 だけ');
  assert.equal(kv.get('cost:o1/r1:2026-10'), '1', 'o1/r1 の累計は変わらない');
  near(kv.get('cost:o2/r2:2026-10'), 5 + 2 * CALL_USD, 'o2/r2 の累計');
});

test('AC3: 行のキーの Secret が無い・空・空白だけなら claude は null（クライアントを作らない）。DRY_RUN=1 ならキーを見ずに dryRun のクライアント', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['無い', { CLAUDE_ONE: undefined }],
    ['空', { CLAUDE_ONE: '' }],
    ['空白だけ', { CLAUDE_ONE: '  \n' }],
  ];
  for (const [name, extra] of cases) {
    const fake = fakeClients();
    const r = prepared(twoRowEnv({ extra }), 'o1/r1', fake.clients);
    assert.equal(r.claude, null, name);
    assert.deepEqual(fake.made, [], `${name}: ほかの行のキーで作らない`);
    assert.equal(fake.dryRuns(), 0, name);
  }
  for (const [name, extra] of [['キーが無い', { CLAUDE_ONE: undefined }], ['キーがある', {}]] as const) {
    const fake = fakeClients();
    const r = prepared(twoRowEnv({ extra: { ...extra, DRY_RUN: '1' } }), 'o1/r1', fake.clients);
    assert.equal(r.claude, fake.dryRunClient, `DRY_RUN=1・${name}`);
    assert.deepEqual(fake.made, [], `DRY_RUN=1・${name}: anthropic は作らない`);
  }
});

test('AC3: claude が null なら fetch-pr の後に止め、Claude と collect を呼ばず、KV に no-api-key、止めた記録を1件投稿する（fetch-pr で止まれば出さない）', async () => {
  const r = await run({ claude: null });
  assert.equal(r.result.outcome, 'no-api-key');
  assert.equal(r.result.usd, null);
  assert.equal(r.claudeCalls.length, 0);
  assert.equal(r.record?.outcome, 'no-api-key', 'KV の review: の記録');
  assert.equal(r.kv.has('cost:o/r:2026-10'), false, '月の累計は書かない');
  for (const url of r.calls) assert.doesNotMatch(url, /\/compare\/|\/git\/trees\/|\/contents\//, `collect を呼ばない: ${url}`);
  assert.equal(r.posted.length, 1);
  const parsed = parseApiReviewComment(r.posted[0]!);
  assert.equal(parsed?.outcome, 'no-api-key');
  assert.equal(parsed?.headSha, HEAD);

  // head が変わっていれば fetch-pr の superseded が先で、no-api-key の記録は出さない
  const superseded = await run({ claude: null, pr: { state: 'open', head: OTHER } });
  assert.equal(superseded.result.outcome, 'superseded');
  assert.equal(superseded.posted.length, 0);
});

test('AC3: 表に無い・表が壊れている・行の識別子が空なら ok: false で、Claude のクライアントを作らず、誤りの文に秘密の値が入らない', () => {
  const legacy = {
    ALLOWED_REPOS: 'o1/r1',
    GITHUB_INSTALLATION_ID: '333',
    GITHUB_APP_CLIENT_ID: 'cid-legacy',
    REVIEW_APP_LOGIN: 'review-legacy[bot]',
    GATE_APP_LOGIN: 'gate-legacy[bot]',
    GITHUB_APP_PRIVATE_KEY: 'pem-legacy-FAKE',
    GITHUB_WEBHOOK_SECRET: 'hook-legacy-FAKE',
    ANTHROPIC_API_KEY: 'sk-legacy-FAKE',
  };
  const secretValues = [...ALL_SECRET_VALUES, legacy.GITHUB_APP_PRIVATE_KEY, legacy.GITHUB_WEBHOOK_SECRET, legacy.ANTHROPIC_API_KEY];
  // [名前, env, リポジトリ, 期待の reason]
  const cases: [string, Env, string, string][] = [
    ['表に無い', twoRowEnv(), 'o3/r3', 'not-in-table'],
    ['表が JSON として読めない', { ...SECRETS, REVIEW_REPOS: `{ "o1/r1": ${SECRETS.CLAUDE_ONE}` }, 'o1/r1', 'repo-table-invalid'],
    ['gateAppLogin が空', { ...legacy, GATE_APP_LOGIN: '' }, 'o1/r1', 'repo-row-incomplete'],
    ['reviewAppLogin が空', { ...legacy, REVIEW_APP_LOGIN: '' }, 'o1/r1', 'repo-row-incomplete'],
    ['installationId が空', { ...legacy, GITHUB_INSTALLATION_ID: ' ' }, 'o1/r1', 'repo-row-incomplete'],
    ['clientId が空', { ...legacy, GITHUB_APP_CLIENT_ID: undefined }, 'o1/r1', 'repo-row-incomplete'],
  ];
  for (const [name, env, fullName, reason] of cases) {
    const fake = fakeClients();
    const r = prepareRepoReview(env, baseConfig(), fullName, fake.clients);
    assert.equal(r.ok, false, name);
    if (r.ok) continue;
    assert.equal(r.reason, reason, name);
    if (reason === 'repo-row-incomplete') assert.ok(r.errors.length > 0, `${name}: 空の項目の名前を返す`);
    const text = JSON.stringify(r);
    for (const secret of secretValues) assert.equal(text.includes(secret), false, `${name}: ${secret}`);
    assert.deepEqual(fake.made, [], `${name}: クライアントを作らない`);
    assert.equal(fake.dryRuns(), 0, name);
  }

  // 識別子がそろった legacy の表は通る（vars のキーを使う）
  const fake = fakeClients();
  const ok = prepared(legacy, 'o1/r1', fake.clients);
  assert.deepEqual(fake.made, [legacy.ANTHROPIC_API_KEY]);
  assert.notEqual(ok.claude, null);
});

test('AC4: ほかの行（と自分の行）の秘密は、PR 本文・Claude の応答に混ざっても、ログ・投稿したコメント・KV の記録に出ない', async () => {
  const leak = `${SECRETS.CLAUDE_TWO} ${SECRETS.KEY_TWO} ${SECRETS.HOOK_TWO} ${SECRETS.CLAUDE_ONE}`;
  // 応答のモデル名は usage の鍵として記録とコメントに入る。指摘の文はコメントに入る
  const leakyModel = `${MODEL}-${SECRETS.CLAUDE_TWO}`;
  const fake = fakeClients(() => [answer({ ...REVIEW_OK, nonBlocking: [`混入 ${leak}`] }, leakyModel), answer(RISK_OK, leakyModel)]);
  const kv = new Map<string, string>();
  const r = await runRepo(prepared(twoRowEnv(), 'o1/r1', fake.clients), 'o1/r1', kv, `PR 本文 ${leak}`);
  assert.equal(r.result.outcome, 'posted');
  assert.ok(kv.has(reviewKey('o1', 'r1', 5, HEAD)), 'KV の review: の記録がある');

  const outputs: [string, string[]][] = [
    ['ログ', r.logs],
    ['コメント', r.posted],
    ['KV', [...kv.entries()].map(([k, v]) => `${k} ${v}`)],
  ];
  for (const [where, texts] of outputs) {
    for (const text of texts) {
      for (const secret of ALL_SECRET_VALUES) assert.equal(text.includes(secret), false, `${where} に ${secret}`);
    }
  }
});
