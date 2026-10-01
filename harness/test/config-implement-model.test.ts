// Issue #469：fleet から起こされた ship の実装のモデル（fleet.implementModel）の既定値・不正な値、設定ファイルの値、panes.ts config の出力を確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { IMPLEMENT_MODEL_DEFAULTS, implementModelConfig, type HarnessConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const asConfig = (fleet: unknown): Pick<HarnessConfig, 'fleet'> => ({ fleet } as unknown as Pick<HarnessConfig, 'fleet'>);

test('implementModelConfig：fleet・implementModel が無ければ既定の sonnet', () => {
  assert.deepEqual(IMPLEMENT_MODEL_DEFAULTS, { implementModel: 'sonnet' });
  assert.deepEqual(implementModelConfig({}), { implementModel: 'sonnet' });
  assert.deepEqual(implementModelConfig({ fleet: {} }), { implementModel: 'sonnet' });
});

test('implementModelConfig：opus を書けば opus', () => {
  assert.deepEqual(implementModelConfig(asConfig({ implementModel: 'opus' })), { implementModel: 'opus' });
});

test('implementModelConfig：sonnet・opus 以外（別のモデル・大文字・空・数値・null）は throw する', () => {
  for (const implementModel of ['haiku', 'Sonnet', '', 1, null]) {
    assert.throws(() => implementModelConfig(asConfig({ implementModel })), Error, String(implementModel));
  }
});

for (const [name, path] of [
  ['harness.config.json', join(root, 'harness.config.json')],
  ['雛形（harness/templates/harness.config.json）', join(root, 'harness', 'templates', 'harness.config.json')],
] as const) {
  test(`${name}：fleet.implementModel sonnet が入り、implementModelConfig で読める`, () => {
    const config = JSON.parse(readFileSync(path, 'utf8')) as HarnessConfig & { fleet?: { implementModel?: unknown } };
    assert.equal(config.fleet?.implementModel, 'sonnet');
    assert.deepEqual(implementModelConfig(config), { implementModel: 'sonnet' });
  });
}

test('panes.ts config：出力の JSON に implementModel（sonnet）と shipMode がある', () => {
  const r = spawnSync(process.execPath, [join(root, 'harness', 'scripts', 'panes.ts'), 'config'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(out.implementModel, 'sonnet');
  assert.ok('shipMode' in out);
});
