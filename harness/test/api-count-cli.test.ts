// Issue #247：AGENT_HARNESS_API_COUNT を付けて agent.ts を動かしたときだけ、終わりに API の回数の要約が標準エラーに出る。
// API を呼ばない check で、付けたとき・付けないとき・0 や空のとき、正常終了と書式エラー（exit 2）を確かめる。標準出力は変わらない。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const dir = mkdtempSync(join(tmpdir(), 'api-count-cli-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const plan = (value: unknown): string => ['計画', '', '```agent-plan', JSON.stringify(value, null, 2), '```', ''].join('\n');

const goodFile = join(dir, 'good.md');
writeFileSync(
  goodFile,
  plan({
    version: 1,
    issue: 247,
    risk: 'low',
    needsHuman: false,
    needsHumanReasons: [],
    acChangeProposed: false,
    openQuestions: [],
    files: ['harness/lib/api-count.ts'],
  }),
);
const badFile = join(dir, 'bad.md');
writeFileSync(badFile, plan({ version: 1, issue: 'x', risk: 'nope' }));

/** value が undefined なら AGENT_HARNESS_API_COUNT を消して動かす（親の環境に左右されない） */
function runCheck(file: string, value: string | undefined): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENT_HARNESS_API_COUNT;
  if (value !== undefined) env.AGENT_HARNESS_API_COUNT = value;
  const r = spawnSync(process.execPath, [join(root, 'harness', 'scripts', 'agent.ts'), 'check', file], { cwd: root, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const SUMMARY = '[api-count] check: 計 0 回（HTTP の応答 0 回）';

test('付けないとき：check は OK (plan) で、標準エラーに [api-count] が出ない', () => {
  const r = runCheck(goodFile, undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'OK (plan)\n');
  assert.ok(!r.stderr.includes('[api-count]'), r.stderr);
});

test('付けたとき：標準エラーに要約が出て、標準出力は付けないときと同じ', () => {
  const off = runCheck(goodFile, undefined);
  const on = runCheck(goodFile, '1');
  assert.equal(on.status, 0, on.stderr);
  assert.ok(on.stderr.includes(SUMMARY), on.stderr);
  assert.equal(on.stdout, off.stdout);
  assert.ok(!on.stdout.includes('[api-count]'));
});

test('書式エラーで exit 2 のときも、付けていれば要約が出る（付けないと出ない）', () => {
  const off = runCheck(badFile, undefined);
  assert.equal(off.status, 2, off.stderr);
  assert.ok(off.stderr.includes('書式エラー'), off.stderr);
  assert.ok(!off.stderr.includes('[api-count]'), off.stderr);
  const on = runCheck(badFile, '1');
  assert.equal(on.status, 2, on.stderr);
  assert.ok(on.stderr.includes('書式エラー'), on.stderr);
  assert.ok(on.stderr.includes(SUMMARY), on.stderr);
  assert.equal(on.stdout, off.stdout);
});

test('AGENT_HARNESS_API_COUNT が 0 や空なら出ない', () => {
  for (const v of ['0', '']) {
    const r = runCheck(goodFile, v);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'OK (plan)\n');
    assert.ok(!r.stderr.includes('[api-count]'), `${JSON.stringify(v)}: ${r.stderr}`);
  }
});
