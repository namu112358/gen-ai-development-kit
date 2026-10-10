// Issue #633：クラウドのセッション（CLAUDE_CODE_REMOTE=true）では、トークンがあっても GitHub の読み書きを gh api の経路にし、
// ハーネスのコマンドが 401 にならないようにする（harness/lib/github.ts の transportFromEnv）。
// transportFromEnv の第2引数に env を渡し、環境変数ごとに GhTransport / FetchTransport のどちらが返るかを確かめる（gh は起動しない。process.env は書き換えない）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FetchTransport, GhTransport, transportFromEnv } from '../lib/github.ts';

type Env = Record<string, string | undefined>;
type Kind = 'gh' | 'fetch';

function kindOf(env: Env, opts: Parameters<typeof transportFromEnv>[0] = {}): Kind {
  const t = transportFromEnv(opts, env);
  if (t instanceof GhTransport) return 'gh';
  if (t instanceof FetchTransport) return 'fetch';
  throw new Error(`想定外の Transport: ${t.constructor.name}`);
}

test('transportFromEnv：CLAUDE_CODE_REMOTE=true ならトークンがあっても gh api の経路', () => {
  const cases: [string, Env][] = [
    ['GITHUB_TOKEN', { CLAUDE_CODE_REMOTE: 'true', GITHUB_TOKEN: 'ghp_x' }],
    ['GH_APP_TOKEN', { CLAUDE_CODE_REMOTE: 'true', GH_APP_TOKEN: 'ghs_x' }],
    ['両方', { CLAUDE_CODE_REMOTE: 'true', GH_APP_TOKEN: 'ghs_x', GITHUB_TOKEN: 'ghp_x' }],
    ['GITHUB_API_URL あり', { CLAUDE_CODE_REMOTE: 'true', GITHUB_TOKEN: 'ghp_x', GITHUB_API_URL: 'https://ghe.example.com/api/v3' }],
  ];
  for (const [name, env] of cases) assert.equal(kindOf(env), 'gh', name);
});

test('transportFromEnv：CLAUDE_CODE_REMOTE が無ければ、今までどおりトークンがあれば fetch の経路', () => {
  const cases: [string, Env][] = [
    ['GITHUB_TOKEN', { GITHUB_TOKEN: 'ghp_x' }],
    ['GH_APP_TOKEN', { GH_APP_TOKEN: 'ghs_x' }],
    ['両方', { GH_APP_TOKEN: 'ghs_x', GITHUB_TOKEN: 'ghp_x' }],
  ];
  for (const [name, env] of cases) assert.equal(kindOf(env), 'fetch', name);
});

test('transportFromEnv：CLAUDE_CODE_REMOTE が "true" 以外なら切り替えない（トークンがあれば fetch）', () => {
  const cases: [string, Env][] = [
    ['false', { CLAUDE_CODE_REMOTE: 'false', GITHUB_TOKEN: 'ghp_x' }],
    ['1', { CLAUDE_CODE_REMOTE: '1', GITHUB_TOKEN: 'ghp_x' }],
    ['空', { CLAUDE_CODE_REMOTE: '', GITHUB_TOKEN: 'ghp_x' }],
    ['TRUE（大文字）', { CLAUDE_CODE_REMOTE: 'TRUE', GITHUB_TOKEN: 'ghp_x' }],
    ['undefined', { CLAUDE_CODE_REMOTE: undefined, GH_APP_TOKEN: 'ghs_x' }],
  ];
  for (const [name, env] of cases) assert.equal(kindOf(env), 'fetch', name);
});

test('transportFromEnv：トークンが無ければ CLAUDE_CODE_REMOTE の有無にかかわらず gh api の経路', () => {
  const cases: [string, Env][] = [
    ['何も無い', {}],
    ['remote=true', { CLAUDE_CODE_REMOTE: 'true' }],
    ['remote=false', { CLAUDE_CODE_REMOTE: 'false' }],
    ['トークンが空文字', { GITHUB_TOKEN: '', GH_APP_TOKEN: '' }],
  ];
  for (const [name, env] of cases) assert.equal(kindOf(env), 'gh', name);
});

test('transportFromEnv：onResponse を渡しても返る経路は同じ', () => {
  const opts = { onResponse: () => {} };
  assert.equal(kindOf({ CLAUDE_CODE_REMOTE: 'true', GITHUB_TOKEN: 'ghp_x' }, opts), 'gh');
  assert.equal(kindOf({ GITHUB_TOKEN: 'ghp_x' }, opts), 'fetch');
  assert.equal(kindOf({}, opts), 'gh');
});
