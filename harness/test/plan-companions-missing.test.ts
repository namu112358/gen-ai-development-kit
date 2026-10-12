/**
 * 同伴ファイルの検査（plan-companions.ts）が、材料（harness/test/README.md の表のパターン・README の生成の表・
 * agent-commands.test.ts）の無い導入先では該当の規則を飛ばすことの検査（Issue #643）。
 * 偽のリポジトリで抜けを出さないこと、表なしの README だけを置いた一時リポジトリで `agent.ts check` が終了コード 0 になること、
 * このリポジトリでは規則3が今までどおり効くことを確かめる。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { missingCompanions, type CompanionRepo } from '../scripts/plan-companions.ts';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const dir = mkdtempSync(join(tmpdir(), 'plan-companions-missing-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function writePlan(name: string, files: string[]): string {
  const value = {
    version: 1, issue: 643, risk: 'low', needsHuman: false, needsHumanReasons: [],
    acChangeProposed: false, openQuestions: [], files,
  };
  const path = join(dir, name);
  writeFileSync(path, ['計画', '', '```agent-plan', JSON.stringify(value, null, 2), '```', ''].join('\n'));
  return path;
}

function runCheck(file: string, cwd: string) {
  return spawnSync(process.execPath, [join(root, 'harness', 'scripts', 'agent.ts'), 'check', file], { cwd, encoding: 'utf8' });
}

test('missingCompanions：表のパターン・生成の表の無いリポジトリでは harness/test と docs/ の追加で抜けを出さない', () => {
  const EXISTING = ['README.md', 'docs', 'docs/README.md'];
  const repo: CompanionRepo = { exists: (p) => EXISTING.includes(p), testPatterns: () => [], hasGeneratedTable: () => false };
  const cases: { name: string; files: string[] }[] = [
    { name: '規則3：harness/test/README.md が無い', files: ['harness/test/new.test.ts'] },
    { name: '規則4：docs/README.md に生成の表が無い', files: ['docs/x.md'] },
  ];
  for (const c of cases) assert.deepEqual(missingCompanions(c.files, repo), [], c.name);
});

test('agent.ts check：表なしの README.md・docs/README.md だけのリポジトリで docs/x.md を足す計画は終了コード 0', () => {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# project\n');
  writeFileSync(join(repo, 'docs', 'README.md'), '# docs\n');
  const r = runCheck(writePlan('no-table.md', ['docs/x.md']), repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'OK (plan)\n');
});

test('agent.ts check：このリポジトリでは規則3が今までどおり効く（パターンに当たらないテストで終了コード 1）', () => {
  const r = runCheck(writePlan('orphan.md', ['harness/test/zz-orphan.test.ts']), root);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('- harness/test/README.md'), r.stderr);
});
