// Issue #549：critic-input のコマンドを通して、plan-critic に渡す入力の「=== 読み先のリポジトリ」が origin/main の最新を含むパスになるか。
// 本体（作業ディレクトリ）が origin/main より古い git の砂場で critic-input を同じプロセスで走らせ、節の SHA が進めた後の origin/main と一致し、
// 節のパスの HEAD がその SHA を含み、本体ではないことを確かめる（読み先の置き場所は確かめない。選び方は plan-critic-repo.test.ts）。
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import type { GitHub, IssueComment } from '../lib/github.ts';
import { sandbox } from './support/git-sandbox.ts';

/** commands/plan.ts は cli.ts を通して harness.config.json を読むので、使うときだけ読み込む */
const loadPlan = () => import('../scripts/agent/commands/plan.ts');

const SESSION = '549a0b1c-2d3e-4f50-8a9b-0123456789ab';
const N = 549;
const ENV_KEYS = ['AGENT_HARNESS_SESSION', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'AGENT_HARNESS_WORKTREE_ROOT'] as const;

/** このセッションの手動の着手宣言（段階 plan-critique）のコメント */
const claimComment = (): IssueComment => ({
  id: 1,
  body: `${claudeMark(SESSION)}\n着手宣言です。\n\n${renderBlock('agent-claim', { by: 'manual', at: '2026-10-09T00:00:00Z', session: SESSION, stage: 'plan-critique' })}`,
  html_url: 'u1',
  created_at: '2026-10-09T00:00:00Z',
  updated_at: '',
  author_association: 'OWNER',
  user: { login: 'me', type: 'User' },
});

/** get('/issues/<n>') と listComments(n) だけに答える偽の GitHub。ほかのメソッドは呼ばれたら投げる */
function fakeGh(): GitHub {
  const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async get(path) {
      assert.equal(path, `/issues/${N}`);
      return { number: N, title: 'テストの Issue', body: '本文' };
    },
    async listComments(n) {
      assert.equal(n, N);
      return [claimComment()];
    },
  };
  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (prop === 'then') return undefined;
      throw new Error(`偽の GitHub：想定外の呼び出し ${String(prop)}`);
    },
  }) as unknown as GitHub;
}

test('critic-input：本体が origin/main より古くても、読み先のリポジトリは origin/main の最新を含むパスになる', async (t) => {
  const sb = sandbox();
  const cwd = process.cwd();
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const logs: string[] = [];
  const errors: string[] = [];
  t.after(() => {
    process.chdir(cwd);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    sb.cleanup();
    const out = logs.at(-1);
    if (out) rmSync(dirname(out), { recursive: true, force: true });
  });
  process.env.AGENT_HARNESS_SESSION = SESSION;
  delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  process.env.AGENT_HARNESS_WORKTREE_ROOT = join(sb.dir, 'wt');
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  t.mock.method(process, 'exit', (code?: number) => {
    throw new Error(`process.exit(${code}): ${errors.join('\n')}`);
  });

  // origin を seed から1つ進める（本体は fetch しないので古いまま）
  const base = sb.commit(sb.seed, 'b.txt');
  sb.git(sb.seed, 'push', '-q', 'origin', 'main');
  assert.notEqual(sb.git(sb.root, 'rev-parse', 'HEAD'), base, '本体は古いまま');

  const planFile = join(sb.dir, 'plan.md');
  writeFileSync(planFile, '計画の本文\n');

  const { commands } = await loadPlan();
  const cmd = commands.find((c) => c.name === 'critic-input');
  assert.ok(cmd, 'critic-input のコマンドがある');
  process.chdir(sb.root);
  await cmd.run([String(N), planFile], { counter: null, gh: () => fakeGh() });

  assert.equal(logs.length, 1, `出力はファイルのパス1行: ${errors.join('\n')}`);
  const text = readFileSync(logs[0]!, 'utf8');
  const lines = text.split('\n');
  const at = lines.indexOf('=== 読み先のリポジトリ');
  assert.ok(at >= 0, `「=== 読み先のリポジトリ」の節がある:\n${text}`);
  const m = lines[at + 1]?.match(/^(.+)（origin\/main ([0-9a-f]{40}) を含む）$/);
  assert.ok(m, `節の行は「<path>（origin/main <SHA> を含む）」: ${lines[at + 1]}`);
  const [, path, sha] = m;
  assert.equal(sha, base, '節の SHA は進めた後の origin/main');
  assert.equal(sb.git(path!, 'merge-base', '--is-ancestor', sha!, 'HEAD'), '', '節のパスの HEAD は origin/main の最新を含む');
  assert.notEqual(realpathSync.native(path!), realpathSync.native(sb.root), '読み先は古い本体ではない');
});
