// Issue #652：配布物（harness/managed.json の managed から exclude を除いたもの）と projectOwned の雛形だけを
// 一時ディレクトリに写し、入口（render-claim・gates/run.ts・hooks/run.mjs）が起動して想定の所で止まることと、
// 配布物の相対 import が配布物の中に収まること、写した .ts が node --check を通ることを確かめる
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { copyDistribution } from './support/managed-tree.ts';

const root = join(import.meta.dirname, '..', '..');

let dir = '';
let copied: string[] = [];

/** 写した木で node を起動する。セッション・App のトークンは環境から外す */
function run(args: string[], input = '') {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GH_APP_TOKEN', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'AGENT_HARNESS_SESSION']) delete env[k];
  return spawnSync(process.execPath, args, { cwd: dir, input, encoding: 'utf8', env });
}

before(() => {
  ({ dir, copied } = copyDistribution(root, 'managed-smoke-'));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('managed-smoke：写した木に harness.config.json と CLAUDE.md が雛形から置かれる', () => {
  for (const p of ['harness.config.json', 'CLAUDE.md']) assert.ok(existsSync(join(dir, p)), `${p} が無い`);
});

test('managed-smoke：render-claim --stage plan が終了コード 0 で agent-claim のブロックを出す', () => {
  const r = run(['harness/scripts/agent.ts', 'render-claim', '--stage', 'plan']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /```agent-claim\n/);
});

test('managed-smoke：GH_APP_TOKEN の無い gates/run.ts は「GH_APP_TOKEN がありません」で止まる', () => {
  const r = run(['harness/gates/run.ts']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes('GH_APP_TOKEN がありません'), r.stderr);
});

test('managed-smoke：hooks/run.mjs は許可の一覧に無い引数で終了コード 2 と理由を stderr に出す', () => {
  const r = run(['.claude/hooks/run.mjs', 'nope'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(r.status, 2, r.stdout);
  assert.ok(r.stderr.includes('許可の一覧に無い引数です'), r.stderr);
});

test('managed-smoke：配布物の .ts・.mjs の相対 import が配布物の中に存在する', () => {
  const re = /(?:\bfrom|\bimport\(|new URL\()\s*(['"])(\.\.?\/[^'"]*)\1/g;
  const missing: string[] = [];
  for (const f of copied.filter((p) => /\.(ts|mjs)$/.test(p))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const hit of src.matchAll(re)) {
      const target = resolve(dirname(join(dir, f)), hit[2] ?? '');
      if (!existsSync(target)) missing.push(`${f} → ${hit[2]}`);
    }
  }
  assert.deepEqual(missing, []);
});

/** find harness .claude/hooks -name '*.ts' と同じ列挙 */
function listTs(rel: string): string[] {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listTs(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// 最後の test にする（上の test は package.json の無い木で確かめるため。concurrency を付けず順に流す）
test('managed-smoke：写した harness と .claude/hooks の .ts がすべて node --check を通る（ci.yml の雛形と同じ手順）', async () => {
  // ci.yml の雛形と同じく、無ければ {"type":"module"} を置く（Node 24 はいちばん近い package.json に type が無いと型注釈を剥がさない）
  for (const d of ['harness', '.claude/hooks']) {
    const pkg = join(dir, d, 'package.json');
    if (!existsSync(pkg)) writeFileSync(pkg, '{"type":"module"}\n');
  }
  const queue = [...listTs('harness'), ...listTs('.claude/hooks')];
  const failed: string[] = [];
  // 1ファイルずつ起動すると遅いので、8本ずつ並べて流す
  const worker = async (): Promise<void> => {
    for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
      const file = f;
      await new Promise<void>((done) => {
        execFile(process.execPath, ['--check', file], { cwd: dir }, (err, _out, stderr) => {
          if (err) failed.push(`${file}: ${stderr.split('\n').find((l) => l.includes('Error')) ?? stderr.trim()}`);
          done();
        });
      });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  assert.deepEqual(failed.sort(), []);
});
