// Issue #1022：導入先に配る設定（harness/templates/harness.config.json）の reviewSource の既定がローカルのレビューであることと、
// API のレビューの経路に要るファイル（config・api-review の lib と入口・judge の skill）が配られることと、
// 配布物だけを写した木で api-review が { action: 'local', reason: 'disabled' } を返すことを確かめる
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { reviewSourceConfig, type HarnessConfig } from '../lib/config.ts';
import { isManaged } from '../lib/sync.ts';
import { copyDistribution, readManaged } from './support/managed-tree.ts';

const root = join(import.meta.dirname, '..', '..');

let dir = '';

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('managed-review-source：配る harness.config.json の雛形の reviewSource.mode は local', () => {
  const cfg = JSON.parse(readFileSync(join(root, 'harness/templates/harness.config.json'), 'utf8')) as Pick<HarnessConfig, 'reviewSource'>;
  assert.equal(reviewSourceConfig(cfg).mode, 'local');
});

test('managed-review-source：API のレビューの経路に要るファイルが配布物に入る', () => {
  const m = readManaged(root);
  const files = [
    'harness/lib/config.ts',
    'harness/lib/api-review.ts',
    'harness/scripts/agent/commands/api-review.ts',
    '.claude/skills/judge/SKILL.md',
  ];
  const missing = files.filter((f) => !isManaged(m.managed, m.exclude ?? [], f));
  assert.deepEqual(missing, []);
});

test('managed-review-source：配布物だけを写した木で api-review は { action: local, reason: disabled } を返す', () => {
  // cwd は写した木にする（このリポジトリの harness.config.json は mode api なので読まない）
  ({ dir } = copyDistribution(root, 'managed-review-source-'));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GH_APP_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'AGENT_HARNESS_SESSION']) delete env[k];
  env.GITHUB_REPOSITORY = 'example-owner/example-repo';
  const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'api-review', '1', '--judge-input', join(dir, 'no-such-judge-input.md')], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { action: 'local', reason: 'disabled' });
});
