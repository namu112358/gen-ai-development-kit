// Issue #272：harness.config.json の上限の検査（config.ts の limitErrors と loadConfig）。
// 実物と雛形が検査を通り、必須キーの欠け・型・範囲の誤りはキーと値を示す文になり、loadConfig はその文で止まる。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { limitErrors, loadConfig } from '../lib/config.ts';

const REAL_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL('../templates/harness.config.json', import.meta.url));
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));

/** 実物の設定の写しに、パス（`a.b`）の値を置く（undefined なら消す） */
function withValue(path: string, value: unknown, base: Record<string, unknown> = readJson(REAL_PATH)): Record<string, unknown> {
  const copy = structuredClone(base);
  const keys = path.split('.');
  let node = copy as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (node[k] === undefined || node[k] === null || typeof node[k] !== 'object') node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

/** 誤りの中に、キーと（値があれば）JSON にした値を含む文がある */
function assertErrorFor(config: unknown, key: string, value?: unknown): void {
  const errors = limitErrors(config);
  const shown = value === undefined ? undefined : JSON.stringify(value);
  assert.ok(
    errors.some((e) => e.includes(key) && (shown === undefined || e.includes(shown))),
    `${key}=${shown} の誤りが無い：${JSON.stringify(errors)}`,
  );
}

const REQUIRED_INTEGER = ['routine.maxItemsPerRun', 'fixLoop.normalLimit', 'fixLoop.criticalLimit', 'jev.maxDiffChars'];
const REQUIRED_NUMBER = ['routine.humanClaimStaleHours', 'routine.routineClaimTakeoverMinutes', 'staleHours'];
const OPTIONAL_INTEGER = [
  'fleet.maxParallelShips',
  'syncLoop.limit',
  'classification.issueTriageJevPerRun',
  'jev.decisionMaxTargets',
  'jev.decisionMaxAnswerChars',
];
const OPTIONAL_NUMBER = ['delegateMerge.hours', 'routine.gateReplyTimeoutMinutes'];

// --- 実物と雛形 ---

test('実物の harness.config.json は上限の検査を通り、loadConfig() でも読める', () => {
  assert.deepEqual(limitErrors(readJson(REAL_PATH)), []);
  assert.doesNotThrow(() => loadConfig());
  assert.doesNotThrow(() => loadConfig(REAL_PATH));
});

test('雛形（harness/templates/harness.config.json）も上限の検査を通る（appSlug が空でも関係ない）', () => {
  const template = readJson(TEMPLATE_PATH);
  assert.equal(template.appSlug, '');
  assert.deepEqual(limitErrors(template), []);
});

test('足した4つのキーが、実物と雛形の両方に今の値で書かれている', () => {
  for (const path of [REAL_PATH, TEMPLATE_PATH]) {
    const c = readJson(path) as { classification: Record<string, unknown>; routine: Record<string, unknown>; jev: Record<string, unknown> };
    assert.equal(c.classification.issueTriageJevPerRun, 5, path);
    assert.equal(c.routine.gateReplyTimeoutMinutes, 30, path);
    assert.equal(c.jev.decisionMaxTargets, 20, path);
    assert.equal(c.jev.decisionMaxAnswerChars, 20000, path);
  }
});

// --- 必須キー ---

test('必須キーが無ければ、そのキーを含む誤りになる', () => {
  for (const key of [...REQUIRED_INTEGER, ...REQUIRED_NUMBER]) assertErrorFor(withValue(key, undefined), key);
});

test('routine・fixLoop・jev そのものが無くても、中の必須キーの誤りになる', () => {
  const noRoutine = withValue('routine', undefined);
  for (const key of ['routine.maxItemsPerRun', 'routine.humanClaimStaleHours', 'routine.routineClaimTakeoverMinutes']) assertErrorFor(noRoutine, key);
  const noFix = withValue('fixLoop', undefined);
  for (const key of ['fixLoop.normalLimit', 'fixLoop.criticalLimit']) assertErrorFor(noFix, key);
  assertErrorFor(withValue('jev', undefined), 'jev.maxDiffChars');
});

// --- 型と範囲 ---

test('正の整数のキー：文字列・0・負・小数・null・真偽値は、キーと値を含む誤り', () => {
  for (const key of [...REQUIRED_INTEGER, ...OPTIONAL_INTEGER]) {
    for (const bad of ['5', 0, -1, 1.5, null, true]) assertErrorFor(withValue(key, bad), key, bad);
  }
});

test('正の整数のキー：1 以上の整数は誤りにしない', () => {
  for (const key of [...REQUIRED_INTEGER, ...OPTIONAL_INTEGER]) {
    // criticalLimit は normalLimit 以上でないといけないので、両方そろえて大きくする
    const config = key.startsWith('fixLoop.') ? withValue('fixLoop', { normalLimit: 7, criticalLimit: 7 }) : withValue(key, 7);
    assert.deepEqual(limitErrors(config), [], key);
  }
  assert.deepEqual(limitErrors(withValue('fixLoop', { normalLimit: 1, criticalLimit: 1 })), []);
});

test('正の数のキー：小数は認め、文字列・0・負・null は、キーと値を含む誤り', () => {
  for (const key of [...REQUIRED_NUMBER, ...OPTIONAL_NUMBER]) {
    assert.deepEqual(limitErrors(withValue(key, 0.5)), [], `${key}=0.5`);
    assert.deepEqual(limitErrors(withValue(key, 12)), [], `${key}=12`);
    for (const bad of ['6', 0, -0.5, -1, null]) assertErrorFor(withValue(key, bad), key, bad);
  }
});

test('delegateMerge.minRemainingMinutes：0 以上の数は認め、負や文字列は誤り', () => {
  for (const ok of [0, 0.5, 30]) assert.deepEqual(limitErrors(withValue('delegateMerge.minRemainingMinutes', ok)), [], String(ok));
  for (const bad of [-1, -0.5, '30', null]) assertErrorFor(withValue('delegateMerge.minRemainingMinutes', bad), 'delegateMerge.minRemainingMinutes', bad);
});

test('fixLoop.criticalLimit が normalLimit を下回れば、criticalLimit の誤り', () => {
  const config = withValue('fixLoop', { normalLimit: 3, criticalLimit: 2 });
  assertErrorFor(config, 'fixLoop.criticalLimit', 2);
});

test('areaConcurrency の値：0・負・小数・文字列は、領域のキー（areaConcurrency.<名前>）と値を含む誤り', () => {
  for (const bad of [0, -1, 1.5, '3', null]) {
    assertErrorFor(withValue('areaConcurrency', { harness: 3, docs: bad }), 'areaConcurrency.docs', bad);
  }
  assertErrorFor(withValue('areaConcurrency.harness', 0), 'areaConcurrency.harness', 0);
  assert.deepEqual(limitErrors(withValue('areaConcurrency', { harness: 1, docs: 10 })), []);
});

test('誤りが複数あれば、それぞれ1文ずつ返す', () => {
  let config = withValue('routine.maxItemsPerRun', 0);
  config = withValue('staleHours', '24', config);
  config = withValue('jev.maxDiffChars', undefined, config);
  const errors = limitErrors(config);
  assert.ok(errors.length >= 3, JSON.stringify(errors));
  assertErrorFor(config, 'routine.maxItemsPerRun', 0);
  assertErrorFor(config, 'staleHours', '24');
  assertErrorFor(config, 'jev.maxDiffChars');
});

// --- 省略できるキー ---

test('省略できるキー（areaConcurrency・fleet・syncLoop・delegateMerge・足した4つ）が無くても誤りにしない', () => {
  let config = readJson(REAL_PATH);
  for (const key of [
    'areaConcurrency',
    'fleet',
    'syncLoop',
    'delegateMerge',
    'classification.issueTriageJevPerRun',
    'routine.gateReplyTimeoutMinutes',
    'jev.decisionMaxTargets',
    'jev.decisionMaxAnswerChars',
  ]) {
    assert.deepEqual(limitErrors(withValue(key, undefined)), [], key);
    config = withValue(key, undefined, config);
  }
  assert.deepEqual(limitErrors(config), [], 'すべて無くても誤りにしない');
});

test('fleet・syncLoop があっても、中の上限のキーが無ければ誤りにしない', () => {
  assert.deepEqual(limitErrors(withValue('fleet', { nesting: 'flat' })), []);
  assert.deepEqual(limitErrors(withValue('syncLoop', {})), []);
  assert.deepEqual(limitErrors(withValue('delegateMerge', { label: 'x' })), []);
  assert.deepEqual(limitErrors(withValue('areaConcurrency', {})), []);
});

// --- loadConfig ---

function writeTemp(config: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'config-limits-'));
  const path = join(dir, 'harness.config.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('loadConfig(path)：上限に誤りがあれば、決まった書き出しとキー・値を含む文で throw する', () => {
  const { path, cleanup } = writeTemp(withValue('routine.maxItemsPerRun', 0));
  try {
    assert.throws(() => loadConfig(path), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('harness.config.json の上限の設定に誤りがあります：'), err.message);
      assert.ok(err.message.includes('routine.maxItemsPerRun'), err.message);
      assert.ok(err.message.includes('0'), err.message);
      return true;
    });
  } finally {
    cleanup();
  }
});

test('loadConfig(path)：必須キーの欠けと criticalLimit の逆転は、どちらのキーも文に含めて throw する', () => {
  let config = withValue('staleHours', undefined);
  config = withValue('fixLoop', { normalLimit: 3, criticalLimit: 1 }, config);
  const { path, cleanup } = writeTemp(config);
  try {
    assert.throws(() => loadConfig(path), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('harness.config.json の上限の設定に誤りがあります：'), err.message);
      assert.ok(err.message.includes('staleHours'), err.message);
      assert.ok(err.message.includes('fixLoop.criticalLimit'), err.message);
      return true;
    });
  } finally {
    cleanup();
  }
});

test('loadConfig(path)：誤りが無ければ読める（省略できるキーが無い設定も）', () => {
  const { path, cleanup } = writeTemp(withValue('fleet', undefined, withValue('routine.gateReplyTimeoutMinutes', undefined)));
  try {
    const cfg = loadConfig(path);
    assert.equal(cfg.routine.maxItemsPerRun, (readJson(REAL_PATH).routine as { maxItemsPerRun: number }).maxItemsPerRun);
    assert.equal(cfg.fleet, undefined);
  } finally {
    cleanup();
  }
});
