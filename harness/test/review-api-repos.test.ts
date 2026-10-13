// review-api のリポジトリの表（REVIEW_REPOS）を読む parseRepoTable と、行から実行に要る値を選ぶ resolveRepoRuntime・findRepo・collectSecrets・webhookSecretNames
// （review-api/src/repos.ts）が、行ごとの値を混ぜずに返すこと、REVIEW_REPOS が無ければ今の vars から同じ値の表を組むこと、
// 形の誤り・規則外の Secret の名前を値を出さずに誤りにして表を空にすることを確かめる（Issue #1048）。識別子はすべて架空の値
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectSecrets,
  findRepo,
  parseRepoTable,
  resolveRepoRuntime,
  webhookSecretNames,
  type RepoEnv,
} from '../../review-api/src/repos.ts';

// 2つの行の表。どの欄もほかの行と違う値にして、混ざれば分かるようにする
const row1 = () => ({
  installationId: '111',
  app: { clientId: 'cid-one', privateKeySecret: 'KEY_ONE', webhookSecret: 'HOOK_ONE', login: 'review-one[bot]' },
  gateAppLogin: 'gate-one[bot]',
  anthropicKeySecret: 'CLAUDE_ONE',
  budget: { monthlyUsd: 10, perReviewUsd: 1 },
  trigger: { branchPrefix: 'one/', requireClosesIssue: false, issueLink: 'closes-or-refs' },
});
const row2 = () => ({
  installationId: 222,
  app: { clientId: 'cid-two', privateKeySecret: 'KEY_TWO', webhookSecret: 'HOOK_TWO', login: 'review-two[bot]' },
  gateAppLogin: 'gate-two[bot]',
  anthropicKeySecret: 'CLAUDE_TWO',
});
const secrets = {
  KEY_ONE: 'pem-one',
  KEY_TWO: 'pem-two',
  HOOK_ONE: 'hook-one',
  HOOK_TWO: 'hook-two',
  CLAUDE_ONE: 'sk-one',
  CLAUDE_TWO: 'sk-two',
};
const twoRowEnv = (): RepoEnv => ({ REVIEW_REPOS: JSON.stringify({ 'o1/r1': row1(), 'o2/r2': row2() }), ...secrets });

test('2つの行の表で、resolveRepoRuntime はそれぞれの行の値だけを返し、表に無いリポジトリでは null', () => {
  const env = twoRowEnv();
  const parsed = parseRepoTable(env);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.source, 'table');
  assert.equal(parsed.table.size, 2);

  const one = resolveRepoRuntime(env, parsed.table, 'o1/r1');
  assert.ok(one);
  assert.equal(one.fullName, 'o1/r1');
  assert.equal(one.installationId, '111');
  assert.equal(one.clientId, 'cid-one');
  assert.equal(one.privateKey, 'pem-one');
  assert.equal(one.anthropicKey, 'sk-one');
  assert.equal(one.webhookSecretName, 'HOOK_ONE');
  assert.equal(one.reviewAppLogin, 'review-one[bot]');
  assert.equal(one.gateAppLogin, 'gate-one[bot]');
  assert.deepEqual(one.overrides.budget, { monthlyUsd: 10, perReviewUsd: 1 });
  assert.deepEqual(one.overrides.trigger, { branchPrefix: 'one/', requireClosesIssue: false, issueLink: 'closes-or-refs' });

  const two = resolveRepoRuntime(env, parsed.table, 'o2/r2');
  assert.ok(two);
  assert.equal(two.installationId, '222', '数の installationId は数字の文字列になる');
  assert.equal(two.clientId, 'cid-two');
  assert.equal(two.privateKey, 'pem-two');
  assert.equal(two.anthropicKey, 'sk-two');
  assert.equal(two.webhookSecretName, 'HOOK_TWO');
  assert.equal(two.reviewAppLogin, 'review-two[bot]');
  assert.equal(two.gateAppLogin, 'gate-two[bot]');
  // 行に上限・trigger が無ければ、ほかの行のものを借りない
  assert.equal(two.overrides.budget?.monthlyUsd, undefined);
  assert.equal(two.overrides.budget?.perReviewUsd, undefined);
  assert.equal(two.overrides.trigger?.branchPrefix, undefined);
  assert.equal(two.overrides.trigger?.issueLink, undefined);

  // 大文字小文字の違いは同じリポジトリとして引く
  assert.equal(resolveRepoRuntime(env, parsed.table, 'O2/R2')?.clientId, 'cid-two');
  assert.ok(findRepo(parsed.table, 'O1/r1'));

  for (const missing of ['o3/r3', 'o1/r2', 'o1', '']) {
    assert.equal(resolveRepoRuntime(env, parsed.table, missing), null, missing);
    assert.equal(findRepo(parsed.table, missing), null, missing);
  }
});

test('Secret の値が env に無い・文字列でなければ、その値は空文字になる（ほかの行の値で埋めない）', () => {
  const env: RepoEnv = { ...twoRowEnv(), KEY_TWO: undefined, CLAUDE_TWO: 123 };
  const { table } = parseRepoTable(env);
  const two = resolveRepoRuntime(env, table, 'o2/r2');
  assert.ok(two);
  assert.equal(two.privateKey, '');
  assert.equal(two.anthropicKey, '');
});

test('REVIEW_REPOS が無い・空白だけなら、今の vars から同じ値の表を組む（source は legacy）', () => {
  const legacyVars = {
    ALLOWED_REPOS: 'o1/r1, O2/R2,,',
    GITHUB_INSTALLATION_ID: ' 333 ',
    GITHUB_APP_CLIENT_ID: 'cid-legacy',
    REVIEW_APP_LOGIN: 'review-legacy[bot]',
    GATE_APP_LOGIN: 'gate-legacy[bot]',
    GITHUB_APP_PRIVATE_KEY: 'pem-legacy',
    GITHUB_WEBHOOK_SECRET: 'hook-legacy',
    ANTHROPIC_API_KEY: 'sk-legacy',
  };
  for (const [name, reviewRepos] of [['無い', undefined], ['空', ''], ['空白だけ', '  \n ']] as const) {
    const env: RepoEnv = { ...legacyVars, ...(reviewRepos === undefined ? {} : { REVIEW_REPOS: reviewRepos }) };
    const parsed = parseRepoTable(env);
    assert.deepEqual(parsed.errors, [], name);
    assert.equal(parsed.source, 'legacy', name);
    assert.equal(parsed.table.size, 2, `${name}: 空の要素は飛ばす`);
    for (const fullName of ['o1/r1', 'o2/r2']) {
      const rt = resolveRepoRuntime(env, parsed.table, fullName);
      assert.ok(rt, `${name}: ${fullName}`);
      assert.equal(rt.installationId, '333', name);
      assert.equal(rt.clientId, 'cid-legacy', name);
      assert.equal(rt.privateKey, 'pem-legacy', name);
      assert.equal(rt.anthropicKey, 'sk-legacy', name);
      assert.equal(rt.webhookSecretName, 'GITHUB_WEBHOOK_SECRET', name);
      assert.equal(rt.reviewAppLogin, 'review-legacy[bot]', name);
      assert.equal(rt.gateAppLogin, 'gate-legacy[bot]', name);
      assert.equal(rt.overrides.budget?.monthlyUsd, undefined, name);
      assert.equal(rt.overrides.trigger?.branchPrefix, undefined, name);
    }
    assert.deepEqual(webhookSecretNames(parsed.table), ['GITHUB_WEBHOOK_SECRET'], name);
  }

  // ALLOWED_REPOS が空・無いなら空の表。今の vars の識別子が空でも誤りにしない
  for (const env of [{ ...legacyVars, ALLOWED_REPOS: '' }, {}] as RepoEnv[]) {
    const parsed = parseRepoTable(env);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.source, 'legacy');
    assert.equal(parsed.table.size, 0);
  }
  const blankIds = parseRepoTable({ ALLOWED_REPOS: 'o1/r1' });
  assert.deepEqual(blankIds.errors, []);
  assert.equal(resolveRepoRuntime({ ALLOWED_REPOS: 'o1/r1' }, blankIds.table, 'o1/r1')?.installationId, '');

  // REVIEW_REPOS があれば今の vars は使わない
  const both = parseRepoTable({ ...legacyVars, ...twoRowEnv(), ALLOWED_REPOS: 'o9/r9' });
  assert.equal(both.source, 'table');
  assert.equal(findRepo(both.table, 'o9/r9'), null);
});

// 誤りの文に出てはいけない目印（Secret の名前の欄の文字列・不正な数・JSON の中身・形の違う鍵）
const SENTINEL = 'sentinelzq';
const SENTINEL_NUM = 98765.4321;

// [名前, REVIEW_REPOS の文字列, 誤りの文に入るべきパス（無ければ件数だけ見る）]
const withRow1 = (mutate: (r: Record<string, any>) => void): string => {
  const r: Record<string, any> = row1();
  mutate(r);
  return JSON.stringify({ 'o1/r1': r, 'o2/r2': row2() });
};
const invalidCases: [string, string, string | null][] = [
  ['JSON でない', `{"o1/r1": ${SENTINEL}`, null],
  ['最上位が配列', JSON.stringify([row1()]), null],
  ['最上位が文字列', JSON.stringify(SENTINEL), null],
  ['行が null', JSON.stringify({ 'o1/r1': null, 'o2/r2': row2() }), 'o1/r1'],
  ['行が配列', JSON.stringify({ 'o1/r1': [], 'o2/r2': row2() }), 'o1/r1'],
  ['鍵に / が無い', JSON.stringify({ 'o2/r2': row2(), [`${SENTINEL}`]: row1() }), '#1'],
  ['鍵の / が2つ', JSON.stringify({ [`o1/r1/${SENTINEL}`]: row1() }), '#0'],
  ['鍵の owner が空', JSON.stringify({ [`/${SENTINEL}`]: row1() }), '#0'],
  ['鍵の repo が空', JSON.stringify({ [`${SENTINEL}/`]: row1() }), '#0'],
  ['大文字小文字違いの重複', JSON.stringify({ 'o1/r1': row1(), 'O1/R1': row1() }), null],
  ['installationId が無い', withRow1((r) => { delete r.installationId; }), 'o1/r1.installationId'],
  ['installationId が数字でない文字列', withRow1((r) => { r.installationId = `${SENTINEL}`; }), 'o1/r1.installationId'],
  ['installationId が 0', withRow1((r) => { r.installationId = 0; }), 'o1/r1.installationId'],
  ['installationId が負', withRow1((r) => { r.installationId = -SENTINEL_NUM; }), 'o1/r1.installationId'],
  ['installationId が小数', withRow1((r) => { r.installationId = SENTINEL_NUM; }), 'o1/r1.installationId'],
  ['app が無い', withRow1((r) => { delete r.app; }), 'o1/r1.app'],
  ['clientId が空', withRow1((r) => { r.app.clientId = ''; }), 'o1/r1.app.clientId'],
  ['login が無い', withRow1((r) => { delete r.app.login; }), 'o1/r1.app.login'],
  ['gateAppLogin が文字列でない', withRow1((r) => { r.gateAppLogin = 1; }), 'o1/r1.gateAppLogin'],
  ['privateKeySecret が小文字', withRow1((r) => { r.app.privateKeySecret = `key_${SENTINEL}`; }), 'o1/r1.app.privateKeySecret'],
  ['privateKeySecret が数字で始まる', withRow1((r) => { r.app.privateKeySecret = '1KEY'; }), 'o1/r1.app.privateKeySecret'],
  ['webhookSecret にハイフン', withRow1((r) => { r.app.webhookSecret = 'HOOK-ONE'; }), 'o1/r1.app.webhookSecret'],
  ['webhookSecret が空', withRow1((r) => { r.app.webhookSecret = ''; }), 'o1/r1.app.webhookSecret'],
  ['anthropicKeySecret が値そのもの', withRow1((r) => { r.anthropicKeySecret = `sk-ant-${SENTINEL}`; }), 'o1/r1.anthropicKeySecret'],
  ['anthropicKeySecret が _ で始まる', withRow1((r) => { r.anthropicKeySecret = '_KEY'; }), 'o1/r1.anthropicKeySecret'],
  ['anthropicKeySecret が無い', withRow1((r) => { delete r.anthropicKeySecret; }), 'o1/r1.anthropicKeySecret'],
  ['行の知らない鍵', withRow1((r) => { r.extra = 1; }), 'o1/r1'],
  ['app の知らない鍵', withRow1((r) => { r.app.privateKey = 'x'; }), 'o1/r1.app'],
  ['budget の知らない鍵', withRow1((r) => { r.budget.dailyUsd = 1; }), 'o1/r1.budget'],
  ['trigger の知らない鍵', withRow1((r) => { r.trigger.actions = ['opened']; }), 'o1/r1.trigger'],
  ['budget.monthlyUsd が負', withRow1((r) => { r.budget.monthlyUsd = -SENTINEL_NUM; }), 'o1/r1.budget.monthlyUsd'],
  ['budget.perReviewUsd が 0', withRow1((r) => { r.budget.perReviewUsd = 0; }), 'o1/r1.budget.perReviewUsd'],
  ['budget.monthlyUsd が文字列', withRow1((r) => { r.budget.monthlyUsd = `${SENTINEL_NUM}`; }), 'o1/r1.budget.monthlyUsd'],
  ['budget がオブジェクトでない', withRow1((r) => { r.budget = 5; }), 'o1/r1.budget'],
  ['trigger.branchPrefix が文字列でない', withRow1((r) => { r.trigger.branchPrefix = 1; }), 'o1/r1.trigger.branchPrefix'],
  ['trigger.requireClosesIssue が文字列', withRow1((r) => { r.trigger.requireClosesIssue = 'true'; }), 'o1/r1.trigger.requireClosesIssue'],
  ['trigger.issueLink が規則外', withRow1((r) => { r.trigger.issueLink = `refs-${SENTINEL}`; }), 'o1/r1.trigger.issueLink'],
];

test('形の誤り・規則外の Secret の名前は誤りになり、表は空になり、誤りの文に値が入らない', () => {
  for (const [name, reviewRepos, path] of invalidCases) {
    const env: RepoEnv = { ...secrets, REVIEW_REPOS: reviewRepos };
    const parsed = parseRepoTable(env);
    assert.ok(parsed.errors.length > 0, `${name}: 誤りになる`);
    assert.equal(parsed.source, 'table', name);
    assert.equal(parsed.table.size, 0, `${name}: 一部の行だけで動かさない`);
    assert.equal(resolveRepoRuntime(env, parsed.table, 'o2/r2'), null, `${name}: 正しい行も引けない`);
    const text = parsed.errors.join('\n');
    if (path !== null) assert.ok(text.includes(path), `${name}: ${path} が誤りの文に無い: ${text}`);
    assert.ok(!text.includes(SENTINEL), `${name}: 値が誤りの文に出た: ${text}`);
    assert.ok(!text.includes(String(SENTINEL_NUM)), `${name}: 数が誤りの文に出た: ${text}`);
    for (const value of Object.values(secrets)) assert.ok(!text.includes(value), `${name}: Secret の値が誤りの文に出た`);
  }
});

test('誤りは全部集める（2つの行の誤りが両方とも入る）', () => {
  const a: Record<string, any> = row1();
  a.app.privateKeySecret = 'bad-name';
  const b: Record<string, any> = row2();
  b.budget = { monthlyUsd: -1 };
  const parsed = parseRepoTable({ REVIEW_REPOS: JSON.stringify({ 'o1/r1': a, 'o2/r2': b }) });
  const text = parsed.errors.join('\n');
  assert.ok(text.includes('o1/r1.app.privateKeySecret'), text);
  assert.ok(text.includes('o2/r2.budget.monthlyUsd'), text);
  assert.equal(parsed.table.size, 0);
});

test('規則に合う Secret の名前の境界（1文字・数字と _ を含む）は受け付ける', () => {
  const r: Record<string, any> = row1();
  r.app.privateKeySecret = 'A';
  r.app.webhookSecret = 'HOOK_2_X';
  r.anthropicKeySecret = 'K9';
  const env: RepoEnv = { REVIEW_REPOS: JSON.stringify({ 'o1/r1': r }), A: 'pem-a', K9: 'sk-k9' };
  const parsed = parseRepoTable(env);
  assert.deepEqual(parsed.errors, []);
  const rt = resolveRepoRuntime(env, parsed.table, 'o1/r1');
  assert.equal(rt?.privateKey, 'pem-a');
  assert.equal(rt?.anthropicKey, 'sk-k9');
  assert.equal(rt?.webhookSecretName, 'HOOK_2_X');
});

test('collectSecrets はすべての行の秘密の値を重複なく集め、空・文字列でないものを除く。webhookSecretNames は出てくる順に重複なく返す', () => {
  const r3: Record<string, any> = row2();
  r3.app = { ...r3.app, clientId: 'cid-three', privateKeySecret: 'KEY_THREE', webhookSecret: 'HOOK_ONE' };
  r3.anthropicKeySecret = 'CLAUDE_ONE';
  const env: RepoEnv = {
    REVIEW_REPOS: JSON.stringify({ 'o1/r1': row1(), 'o2/r2': row2(), 'o3/r3': r3 }),
    ...secrets,
    KEY_TWO: '',
    HOOK_TWO: 42,
    KEY_THREE: 'pem-one', // 別の名前で同じ値
  };
  const parsed = parseRepoTable(env);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual([...collectSecrets(env, parsed.table)].sort(), ['hook-one', 'pem-one', 'sk-one', 'sk-two']);
  assert.deepEqual(webhookSecretNames(parsed.table), ['HOOK_ONE', 'HOOK_TWO']);
});
