// Issue #654：SessionStart の hook（.claude/hooks/session-env.ts）が、CLAUDE_PROJECT_DIR のリポジトリの git の共通ディレクトリの下の
// 古いほかの ID の loaded・watch・stage を消し、exit 0 で終わるか。CLAUDE_PROJECT_DIR が無いとき（cwd が git のリポジトリでも）は何も消さず exit 0。
// どのファイルを消すかの細かい決まりは local-state-prune.test.ts に任せる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './support/git-sandbox.ts';

const root = join(import.meta.dirname, '..', '..');
const HOOK = join(root, '.claude', 'hooks', 'session-env.ts');
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';

/** 実行する環境で結果が変わらないように、関係する変数を消してから必要なものだけを入れる */
function hookEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  delete env.CLAUDE_ENV_FILE;
  return { ...env, ...extra };
}

function runHook(input: string, extra: Record<string, string>, cwd = root) {
  return spawnSync(process.execPath, [HOOK], { cwd, input, encoding: 'utf8', env: hookEnv(extra) });
}

const start = JSON.stringify({ session_id: SESSION, hook_event_name: 'SessionStart', source: 'startup' });

/** 砂場の共通ディレクトリの loaded・watch・stage に、40日前のほかの ID のファイルを置く */
function staleSandbox(t: { after: (fn: () => void) => void }) {
  const sb = sandbox();
  t.after(sb.cleanup);
  const commonDir = sb.git(sb.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const files = ['loaded', 'watch', 'stage'].map((kind) => {
    const dir = join(commonDir, 'agent-harness', kind);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${OTHER}.json`);
    writeFileSync(path, '{}');
    utimesSync(path, at, at);
    return path;
  });
  return { sb, files };
}

test('CLAUDE_PROJECT_DIR 付きで起動すると、古いほかの ID の loaded・watch・stage が消えて exit 0', (t) => {
  const { sb, files } = staleSandbox(t);
  const r = runHook(start, { CLAUDE_PROJECT_DIR: sb.root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(files.filter((p) => existsSync(p)), [], '古いファイルが残っている');
});

test('CLAUDE_PROJECT_DIR が無いときは、cwd が砂場のリポジトリでも何も消さず exit 0', (t) => {
  const { sb, files } = staleSandbox(t);
  const r = runHook(start, {}, sb.root);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(files.filter((p) => !existsSync(p)), [], '消してはいけないファイルが消えた');
});
