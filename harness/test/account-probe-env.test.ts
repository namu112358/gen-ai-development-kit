// Issue #822：probe.ts が claude を呼ぶ子プロセスの環境変数（probeChildEnv）を確かめる（#839 の判定の懸念：probe の子プロセスに資格情報の
// 環境変数が渡ると、CLAUDE_CONFIG_DIR のアカウントではなくその資格情報で問い合わせ、別のアカウントの使用量を控えに書いてしまう）。
// ANTHROPIC_API_KEY・ANTHROPIC_AUTH_TOKEN・CLAUDE_CODE_OAUTH_TOKEN を除き、CLAUDE_CONFIG_DIR を渡した設定ディレクトリにし（元の値は上書き）、
// ほかの変数は残し、渡した env を書き換えないことを見る。実際の設定ディレクトリは読まない（値は架空のパス）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeChildEnv } from '../scripts/accounts/probe.ts';

const CONFIG_DIR = '/home/someone/.claude-accounts/work';
const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** 資格情報と別の CLAUDE_CONFIG_DIR を含む元の env */
const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/someone',
  LANG: 'ja_JP.UTF-8',
  CLAUDE_CONFIG_DIR: '/home/someone/.claude',
  ANTHROPIC_API_KEY: 'sk-fake-api-key',
  ANTHROPIC_AUTH_TOKEN: 'fake-auth-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token',
});

test('probeChildEnv：資格情報の環境変数を除く', () => {
  const out = probeChildEnv(baseEnv(), CONFIG_DIR);
  for (const key of CREDENTIALS) assert.equal(key in out, false, `${key} が子プロセスに渡っています`);
});

test('probeChildEnv：CLAUDE_CONFIG_DIR を渡した設定ディレクトリにする（元の値があっても上書き、無くても足す）', () => {
  assert.equal(probeChildEnv(baseEnv(), CONFIG_DIR).CLAUDE_CONFIG_DIR, CONFIG_DIR);
  assert.equal(probeChildEnv({ PATH: '/usr/bin' }, CONFIG_DIR).CLAUDE_CONFIG_DIR, CONFIG_DIR);
});

test('probeChildEnv：資格情報でない変数は残す', () => {
  const out = probeChildEnv(baseEnv(), CONFIG_DIR);
  assert.equal(out.PATH, '/usr/local/bin:/usr/bin');
  assert.equal(out.HOME, '/home/someone');
  assert.equal(out.LANG, 'ja_JP.UTF-8');
});

test('probeChildEnv：渡した env を書き換えない', () => {
  const env = baseEnv();
  const before = { ...env };
  const out = probeChildEnv(env, CONFIG_DIR);
  assert.deepEqual(env, before);
  assert.notEqual(out, env);
});
