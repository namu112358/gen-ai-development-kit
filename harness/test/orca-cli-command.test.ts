// Issue #773：`node harness/scripts/agent.ts orca-cli`（hq・fleet が env・printenv を使わずに Orca の CLI を得るコマンド）。
// 環境変数の組み合わせ（ORCA_CLI_COMMAND あり／ORCA_DEV_REPO_ROOT だけ／どちらも無し）ごとに command が正しいこと、
// 出力が orcaCliInfo(process.platform, 渡した env) と同じ1行の JSON（鍵は command・found だけ）で環境変数・PATH の値を出さないこと、
// 引数を渡すと終了コード 2 で標準出力が空なことを確かめる（found の場合分けは orca-cli.test.ts に任せる）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { orcaCliInfo } from '../scripts/orca-cli.ts';

const KIT = realpathSync(join(import.meta.dirname, '..', '..'));
const AGENT = join(KIT, 'harness', 'scripts', 'agent.ts');

function runOrcaCli(env: Record<string, string>, args: string[] = []) {
  return spawnSync(process.execPath, [AGENT, 'orca-cli', ...args], { cwd: KIT, env, encoding: 'utf8' });
}

test('orca-cli：環境変数の組み合わせごとに command を出し、出力は orcaCliInfo と同じ1行の JSON で値を漏らさない', { skip: process.platform !== 'linux' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cli-PATHMARK-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases: { name: string; env: Record<string, string>; command: string }[] = [
    { name: 'ORCA_CLI_COMMAND あり（ORCA_DEV_REPO_ROOT より優先）', env: { PATH: dir, ORCA_CLI_COMMAND: '/opt/custom-orca', ORCA_DEV_REPO_ROOT: '/secret/DEVROOTMARK' }, command: '/opt/custom-orca' },
    { name: 'ORCA_DEV_REPO_ROOT だけ', env: { PATH: dir, ORCA_DEV_REPO_ROOT: '/secret/DEVROOTMARK' }, command: 'orca-dev' },
    { name: 'どちらも無し（linux）', env: { PATH: dir }, command: 'orca-ide' },
  ];
  for (const { name, env, command } of cases) {
    const r = runOrcaCli(env);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `${name}: 1行で出す`);
    const out = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ['command', 'found'], name);
    assert.equal(out.command, command, name);
    assert.deepEqual(out, orcaCliInfo(process.platform, env), `${name}: orcaCliInfo と同じ`);
    assert.ok(!r.stdout.includes('DEVROOTMARK'), `${name}: ORCA_DEV_REPO_ROOT の値を出さない`);
    assert.ok(!r.stdout.includes('PATHMARK'), `${name}: PATH の値を出さない`);
  }
});

test('orca-cli：引数を渡すと使い方を標準エラーに出して終了コード 2（標準出力は空）', () => {
  const r = runOrcaCli({ PATH: '' }, ['--json']);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.notEqual(r.stderr.trim(), '');
});
