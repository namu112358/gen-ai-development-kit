// Issue #157：SessionStart の hook（.claude/hooks/session-env.ts）が、セッション ID を AGENT_HARNESS_SESSION として CLAUDE_ENV_FILE に書くか
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const HOOK = '.claude/hooks/session-env.ts';

/** 実行する環境（Claude Code のセッションの中か CI か）で結果が変わらないように、関係する変数を消してから渡す */
function hookEnv(envFile: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  delete env.CLAUDE_ENV_FILE;
  if (envFile !== null) env.CLAUDE_ENV_FILE = envFile;
  return env;
}

function runHook(input: string, envFile: string | null) {
  return spawnSync(process.execPath, [HOOK], { cwd: root, input, encoding: 'utf8', env: hookEnv(envFile) });
}

/** 一時ディレクトリに既存の行を1つ入れた env ファイルを作り、hook を動かしてその中身を返す */
function withEnvFile(input: string): { status: number | null; stderr: string; content: string } {
  const dir = mkdtempSync(join(tmpdir(), 'session-env-'));
  try {
    const file = join(dir, 'env.sh');
    writeFileSync(file, 'export EXISTING=1\n');
    const r = runHook(input, file);
    return { status: r.status, stderr: r.stderr, content: readFileSync(file, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exportLine = (id: string): RegExp => new RegExp(`^export AGENT_HARNESS_SESSION=(['"]?)${id}\\1$`, 'm');

test('session_id を export AGENT_HARNESS_SESSION=<id> として CLAUDE_ENV_FILE に追記する（既存の行は残す）', () => {
  const r = withEnvFile(JSON.stringify({ session_id: 'abc', hook_event_name: 'SessionStart' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.content, exportLine('abc'));
  assert.ok(r.content.startsWith('export EXISTING=1\n'), '追記であり、既存の行を消さない');
});

test('UUID の session_id も書く', () => {
  const id = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
  const r = withEnvFile(JSON.stringify({ session_id: id, hook_event_name: 'SessionStart' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.content, exportLine(id));
});

test('session_id が無い・JSON が壊れているときは何も書かず終了コード 0', () => {
  for (const input of [JSON.stringify({ hook_event_name: 'SessionStart' }), '{not json', '']) {
    const r = withEnvFile(input);
    assert.equal(r.status, 0, `${input}: ${r.stderr}`);
    assert.equal(r.content, 'export EXISTING=1\n', `書かない: ${input}`);
  }
});

test('session_id に英数字・-・_ 以外が入っていたら書かない（シェルに渡すため）', () => {
  for (const id of ['abc; rm -rf /', 'a b', '$(whoami)', 'x`id`', "a'b", 'a\nexport X=1', '']) {
    const r = withEnvFile(JSON.stringify({ session_id: id, hook_event_name: 'SessionStart' }));
    assert.equal(r.status, 0, `${JSON.stringify(id)}: ${r.stderr}`);
    assert.ok(!r.content.includes('AGENT_HARNESS_SESSION'), `書かない: ${JSON.stringify(id)}`);
  }
});

test('CLAUDE_ENV_FILE が無いときは何もせず終了コード 0', () => {
  const r = runHook(JSON.stringify({ session_id: 'abc', hook_event_name: 'SessionStart' }), null);
  assert.equal(r.status, 0, r.stderr);
});

test('.claude/settings.json の SessionStart に session-env.ts を呼ぶ command hook がある', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as {
    hooks?: Record<string, { hooks?: { type: string; command?: string }[] }[]>;
  };
  const entries = settings.hooks?.SessionStart ?? [];
  assert.ok(
    entries.some((e) => e.hooks?.some((h) => h.type === 'command' && typeof h.command === 'string' && h.command.includes('.claude/hooks/session-env.ts'))),
    'SessionStart に session-env.ts の hook がありません',
  );
});
