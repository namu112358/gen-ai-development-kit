// Issue #640：harness.config.json の project（検証コマンドと取り込みのコマンド）の検査（config.ts の projectCommands と loadConfig）。
// 無ければ既定（npm run check・npm ci）、null は「行わない」、空・前後の空白・文字列でない値・オブジェクトでない project は throw し、loadConfig はその誤りを決まった書き出しで止める。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, PROJECT_COMMAND_DEFAULTS, projectCommands, type HarnessConfig } from '../lib/config.ts';

const REAL_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));
const cfg = (project: unknown): Pick<HarnessConfig, 'project'> => ({ project } as Pick<HarnessConfig, 'project'>);

test('既定：project が無い・{} なら npm run check・npm ci', () => {
  assert.deepEqual(PROJECT_COMMAND_DEFAULTS, { checkCommand: 'npm run check', installCommand: 'npm ci' });
  for (const c of [{}, cfg(undefined), cfg({})]) {
    assert.deepEqual(projectCommands(c), { checkCommand: 'npm run check', installCommand: 'npm ci' });
  }
});

test('書いた値を返し、null は null（行わない）、片方だけ書けばもう片方は既定', () => {
  const cases: [unknown, { checkCommand: string | null; installCommand: string | null }][] = [
    [{ checkCommand: 'pytest -q', installCommand: 'pip install -e .' }, { checkCommand: 'pytest -q', installCommand: 'pip install -e .' }],
    [{ checkCommand: null, installCommand: null }, { checkCommand: null, installCommand: null }],
    [{ checkCommand: 'make test' }, { checkCommand: 'make test', installCommand: 'npm ci' }],
    [{ installCommand: null }, { checkCommand: 'npm run check', installCommand: null }],
  ];
  for (const [project, expected] of cases) assert.deepEqual(projectCommands(cfg(project)), expected, JSON.stringify(project));
});

test('コマンドが空文字・空白だけ・前後に空白・文字列でない（数値・配列・真偽・オブジェクト）なら throw', () => {
  for (const key of ['checkCommand', 'installCommand']) {
    for (const v of ['', '   ', ' npm ci', 'npm ci ', 1, ['npm', 'ci'], true, {}]) {
      assert.throws(() => projectCommands(cfg({ [key]: v })), Error, `${key}=${JSON.stringify(v)}`);
    }
  }
});

test('project がオブジェクトでない（null・配列・文字列・数値）なら throw', () => {
  for (const v of [null, [], [{ checkCommand: 'npm run check' }], 'npm run check', 1]) {
    assert.throws(() => projectCommands(cfg(v)), Error, JSON.stringify(v));
  }
});

test('実物の harness.config.json：検査を通る', () => {
  assert.doesNotThrow(() => projectCommands(loadConfig()));
});

function writeTemp(config: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'config-project-'));
  const path = join(dir, 'harness.config.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('loadConfig(path)：誤った project を書くと決まった書き出しで throw し、正しい project・無い project は読める', () => {
  const real = JSON.parse(readFileSync(REAL_PATH, 'utf8')) as Record<string, unknown>;
  for (const project of [{ checkCommand: '' }, { installCommand: 1 }, []]) {
    const { path, cleanup } = writeTemp({ ...real, project });
    try {
      assert.throws(
        () => loadConfig(path),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.startsWith('harness.config.json の project の設定に誤りがあります：'), err.message);
          return true;
        },
        JSON.stringify(project),
      );
    } finally {
      cleanup();
    }
  }
  const withoutProject = { ...real };
  delete withoutProject.project;
  for (const config of [{ ...real, project: { checkCommand: null, installCommand: 'pip install -e .' } }, withoutProject]) {
    const { path, cleanup } = writeTemp(config);
    try {
      assert.doesNotThrow(() => loadConfig(path));
    } finally {
      cleanup();
    }
  }
});
