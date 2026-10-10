/**
 * 計画の files に、今の規則で一緒に変えるファイルが抜けていないかの検査（Issue #466）。
 * missingCompanions が規則1〜4（コマンド → agent-commands.test.ts、agent.ts → コマンドの見本、表のパターンに当たらないテスト →
 * harness/test/README.md、README のあるディレクトリに足すファイル → その README）で抜けを出し、files（文字どおりか glob）に
 * あれば出さないこと、`agent.ts check` が抜けで終了コード 1、無ければ OK (plan) で 0 になることを確かめる。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { missingCompanions, type CompanionRepo } from '../scripts/plan-companions.ts';

// 偽のリポジトリ：既にあるパス（親ディレクトリも含める）と harness/test/README.md の表のパターン
const EXISTING = [
  'README.md', '.github', '.github/workflows', 'docs', 'docs/README.md',
  'harness', 'harness/lib', 'harness/lib/README.md', 'harness/lib/existing.ts',
  'harness/scripts', 'harness/scripts/README.md', 'harness/scripts/agent.ts',
  'harness/scripts/agent', 'harness/scripts/agent/commands', 'harness/scripts/agent/commands/claim.ts',
  'harness/test', 'harness/test/README.md', 'harness/test/agent-commands.test.ts', 'harness/test/support',
];
const fakeRepo: CompanionRepo = { exists: (p) => EXISTING.includes(p), testPatterns: () => ['gates-*.test.ts', 'support/'] };

const CMD = 'harness/scripts/agent/commands/new-cmd.ts';
const CMD_TEST = 'harness/test/agent-commands.test.ts';
const cases: { name: string; files: string[]; want: string[] }[] = [
  // 規則1
  { name: '規則1：コマンドを足して agent-commands.test.ts が無い', files: [CMD], want: [CMD_TEST] },
  { name: '規則1：agent-commands.test.ts があれば出さない', files: [CMD, CMD_TEST], want: [] },
  // 規則2
  {
    name: '規則2：agent.ts だけでコマンドの項目が無い',
    files: ['harness/scripts/agent.ts'],
    want: ['harness/scripts/agent/commands/<名前>.ts', CMD_TEST],
  },
  { name: '規則2：コマンドの項目（glob）とテスト（glob）があれば出さない', files: ['harness/scripts/agent.ts', 'harness/scripts/agent/commands/*.ts', 'harness/test/agent-*.test.ts'], want: [] },
  // 規則3（harness/test は NO_GENERATE_DIRS なので規則4は出ない）
  { name: '規則3：表のパターンに当たらないテスト', files: ['harness/test/orphan.test.ts'], want: ['harness/test/README.md'] },
  { name: '規則3：パターンに当たるテストは出さない', files: ['harness/test/gates-new.test.ts'], want: [] },
  { name: '規則3：harness/test/README.md が files にあれば出さない', files: ['harness/test/orphan.test.ts', 'harness/test/README.md'], want: [] },
  // 規則4（同じ README は1件にまとめる）
  { name: '規則4：README のあるディレクトリに足す', files: ['harness/lib/a.ts', 'harness/lib/b.ts'], want: ['harness/lib/README.md'] },
  { name: '規則4：README が glob で files にあれば出さない', files: ['harness/lib/a.ts', 'harness/lib/*.md'], want: [] },
  { name: '規則4：.github の直下は root の README.md', files: ['.github/new.yml'], want: ['README.md'] },
  { name: '規則4：.github/workflows の直下はその README', files: ['.github/workflows/new.yml'], want: ['.github/workflows/README.md'] },
  { name: '規則4：新しいディレクトリの下は、今ある最も近い上のディレクトリの README', files: ['harness/lib/newdir/x.ts'], want: ['harness/lib/README.md'] },
  { name: '規則4：README.md そのものを足すときは出さない', files: ['docs/newdir/README.md'], want: [] },
  { name: '規則4：harness/test/support/ の下は何も出さない', files: ['harness/test/support/helper.ts'], want: [] },
  // 規則の元にしないもの
  {
    name: '既にあるファイルとワイルドカードの項目は元にしない',
    files: ['harness/lib/existing.ts', 'harness/lib/*.ts', 'harness/test/*.test.ts', 'harness/scripts/agent/commands/claim.ts'],
    want: [],
  },
];

test('missingCompanions：規則1〜4で抜けを出し、files（文字どおりか glob）にあれば出さない', () => {
  for (const c of cases) {
    const got = missingCompanions(c.files, fakeRepo);
    assert.deepEqual(got.map((m) => m.file), c.want, c.name);
    for (const m of got) assert.ok(m.reason.length > 0, `${c.name}：reason が空`);
  }
});

// ---- 結線：agent.ts check ----

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const dir = mkdtempSync(join(tmpdir(), 'plan-companions-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function writePlan(name: string, files: string[]): string {
  const value = {
    version: 1, issue: 466, risk: 'low', needsHuman: false, needsHumanReasons: [],
    acChangeProposed: false, openQuestions: [], files,
  };
  const path = join(dir, name);
  writeFileSync(path, ['計画', '', '```agent-plan', JSON.stringify(value, null, 2), '```', ''].join('\n'));
  return path;
}

function runCheck(file: string) {
  return spawnSync(process.execPath, [join(root, 'harness', 'scripts', 'agent.ts'), 'check', file], { cwd: root, encoding: 'utf8' });
}

const PROBE = 'harness/scripts/agent/commands/zz-plan-companions-probe.ts';

test('agent.ts check：抜けがあれば stderr に見出しと file を出して終了コード 1', () => {
  const r = runCheck(writePlan('missing.md', [PROBE]));
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('計画の files に一緒に変えるファイルが抜けています'), r.stderr);
  assert.ok(r.stderr.includes(`- ${CMD_TEST}`), r.stderr);
});

test('agent.ts check：抜けが無ければ OK (plan) で終了コード 0', () => {
  const r = runCheck(writePlan('ok.md', [PROBE, CMD_TEST]));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'OK (plan)\n');
});
