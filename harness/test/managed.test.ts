import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Issue #155：配布の準備。ハーネスが管理するファイルの一覧（harness/managed.json）、
// CLAUDE.md から harness/CLAUDE.harness.md へ移した規則、設定の雛形（harness/templates/）、gate.yml の Node の版を検査する
import { loadConfig, projectChecks, syncLoopConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

interface Managed {
  managed: string[];
  exclude?: string[];
  projectOwned: { path: string; template: string }[];
  settingsKeys: string[];
  settingsAllow?: string[];
  notDistributed?: string[];
}
const loadManaged = (): Managed => JSON.parse(read('harness/managed.json')) as Managed;

/** ディレクトリの下にファイルが1つでもあるか */
function hasFile(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasFile(join(dir, entry.name))) return true;
  }
  return false;
}

// ---- harness/managed.json ----

test('managed.json：managed・projectOwned・settingsKeys の形で書かれている', () => {
  const m = loadManaged();
  assert.ok(Array.isArray(m.managed) && m.managed.length > 0, 'managed は空でない配列');
  for (const p of m.managed) assert.equal(typeof p, 'string');
  assert.ok(Array.isArray(m.projectOwned));
  for (const o of m.projectOwned) {
    assert.equal(typeof o.path, 'string');
    assert.equal(typeof o.template, 'string');
  }
  // Issue #652：配らないものの一覧（文字列の配列）と、一覧そのものを配ること
  assert.ok(Array.isArray(m.notDistributed), 'notDistributed は文字列の配列');
  for (const p of m.notDistributed) assert.equal(typeof p, 'string');
  assert.ok(m.managed.includes('harness/managed.json'), 'harness/managed.json 自身を managed に入れる');
  assert.deepEqual(m.settingsKeys, ['permissions.deny', 'permissions.disableBypassPermissionsMode', 'hooks', 'permissions.allow']);
});

test('managed.json：managed のパスがすべて存在する（/** はディレクトリが存在し中にファイルがある）', () => {
  for (const p of loadManaged().managed) {
    if (p.endsWith('/**')) {
      const dir = join(root, p.slice(0, -3));
      assert.ok(existsSync(dir) && statSync(dir).isDirectory(), `${p} のディレクトリが無い`);
      assert.ok(hasFile(dir), `${p} の中にファイルが無い`);
    } else {
      assert.ok(!p.includes('*'), `${p}：glob は /** で終わる形だけ`);
      const file = join(root, p);
      assert.ok(existsSync(file) && statSync(file).isFile(), `${p} が無い`);
    }
  }
});

test('managed.json：主なハーネスのファイルが managed に入っている', () => {
  const managed = loadManaged().managed;
  for (const p of [
    'harness/lib/**',
    '.claude/skills/**',
    '.github/workflows/gate.yml',
    'harness/CLAUDE.harness.md',
    'harness/docs/**',
    '.github/pull_request_template.md',
  ]) {
    assert.ok(managed.includes(p), `${p} が managed に無い`);
  }
});

test('managed.json：harness/test 以下・package.json・tsconfig.json を含まない', () => {
  for (const p of loadManaged().managed) {
    const base = p.endsWith('/**') ? p.slice(0, -3) : p;
    assert.notEqual(p, 'package.json');
    assert.notEqual(p, 'tsconfig.json');
    assert.ok(!(p === '**' || base === '' || base === '.'), `${p} はすべてを含む`);
    assert.ok(!(base === 'harness/test' || base.startsWith('harness/test/')), `${p} は harness/test 以下`);
    // harness/** のように harness/test を含む glob も不可
    if (p.endsWith('/**')) assert.ok(!'harness/test/'.startsWith(`${base}/`), `${p} は harness/test を含む`);
  }
});

// Issue #652：workflow の雛形（harness-sync.yml・ci.yml）の path はこのリポジトリに置かないので、path の存在は harness.config.json・CLAUDE.md だけ
test('managed.json：projectOwned の template がすべて存在し、path は harness.config.json・CLAUDE.md だけ存在を確かめる', () => {
  const owned = loadManaged().projectOwned;
  for (const o of owned) assert.ok(existsSync(join(root, o.template)), `${o.template} が無い`);
  for (const p of ['harness.config.json', 'CLAUDE.md']) assert.ok(existsSync(join(root, p)), `${p} が無い`);
  assert.deepEqual(
    owned.map((o) => [o.path, o.template]),
    [
      ['harness.config.json', 'harness/templates/harness.config.json'],
      ['CLAUDE.md', 'harness/templates/CLAUDE.template.md'],
      ['.github/workflows/harness-sync.yml', 'harness/templates/harness-sync.yml'],
      ['.github/workflows/ci.yml', 'harness/templates/ci.yml'],
    ],
  );
  const managed = loadManaged().managed;
  for (const o of owned) assert.ok(!managed.includes(o.path), `${o.path} はプロジェクトのもので managed に入れない`);
});

// ---- CLAUDE.md と harness/CLAUDE.harness.md ----

const linesOf = (text: string): Set<string> => new Set(text.split('\n').map((l) => l.trimEnd()));

test('CLAUDE.md：@harness/CLAUDE.harness.md の行で読み込む', () => {
  assert.ok(linesOf(read('CLAUDE.md')).has('@harness/CLAUDE.harness.md'));
});

test('CLAUDE.harness.md：先頭に見出しと説明の段落がある（readme.ts が README の表の説明に使う）', () => {
  assert.match(read('harness/CLAUDE.harness.md'), /^# .+\n\n[^#\n].+/);
});

test('CLAUDE.harness.md：相対リンクが harness/ から見て存在するファイルを指す', () => {
  const text = read('harness/CLAUDE.harness.md');
  for (const m of text.matchAll(/\]\((\.\.\/[^)#\s]+)(#[^)]*)?\)/g)) {
    assert.ok(existsSync(join(root, 'harness', m[1] ?? '')), `${m[1]} が無い`);
  }
});

test('CLAUDE.template.md：@harness/CLAUDE.harness.md の行がある', () => {
  assert.ok(linesOf(read('harness/templates/CLAUDE.template.md')).has('@harness/CLAUDE.harness.md'));
  assert.ok(!existsSync(join(root, 'harness/templates/CLAUDE.md')), '雛形のファイル名は CLAUDE.md にしない');
});

test('harness.config.json：guardrailPaths に harness/CLAUDE.harness.md がある', () => {
  assert.ok(loadConfig().guardrailPaths?.includes('harness/CLAUDE.harness.md'));
});

// ---- harness/templates/harness.config.json ----

const TEMPLATE = join(root, 'harness/templates/harness.config.json');

/** 値の型の名前（配列・数値・文字列・真偽・null・オブジェクト） */
const kind = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** オブジェクトのキーと値の型の組（$comment を除く） */
function shape(obj: unknown): Record<string, string> {
  assert.equal(kind(obj), 'object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (k !== '$comment') out[k] = kind(v);
  return out;
}

test('雛形の harness.config.json：loadConfig で読め、トップレベルのキーが harness.config.json と同じ', () => {
  const tpl = loadConfig(TEMPLATE) as unknown as Record<string, unknown>;
  const cur = loadConfig() as unknown as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => k !== '$comment').sort();
  assert.deepEqual(keys(tpl), keys(cur));
  assert.deepEqual(shape(tpl), shape(cur));
});

test('雛形の harness.config.json：routine・fixLoop・jev.thresholds・classification のキーと値の型がそろう', () => {
  const tpl = loadConfig(TEMPLATE);
  const cur = loadConfig();
  assert.deepEqual(shape(tpl.routine), shape(cur.routine));
  assert.deepEqual(shape(tpl.fixLoop), shape(cur.fixLoop));
  assert.deepEqual(shape(tpl.jev), shape(cur.jev));
  assert.deepEqual(shape(tpl.jev.thresholds), shape(cur.jev.thresholds));
  assert.deepEqual(shape(tpl.classification), shape(cur.classification));
  // sizes は [名前, 上限] の組、sizeExclude は文字列の配列、areas は 名前 → 文字列の配列
  for (const s of tpl.classification.sizes) {
    assert.equal(kind(s), 'array');
    assert.equal(typeof s[0], 'string');
    assert.equal(typeof s[1], 'number');
  }
  for (const p of tpl.classification.sizeExclude) assert.equal(typeof p, 'string');
  for (const patterns of Object.values(tpl.classification.areas)) {
    assert.equal(kind(patterns), 'array');
    for (const p of patterns) assert.equal(typeof p, 'string');
  }
  assert.ok(['off', 'shadow', 'label'].includes(tpl.classification.issueTriage));
});

test('雛形の harness.config.json：guardrailPaths に設定・規則・settings のファイルがある', () => {
  const g = loadConfig(TEMPLATE).guardrailPaths ?? [];
  for (const p of ['harness.config.json', 'harness/CLAUDE.harness.md', 'CLAUDE.md', '.claude/settings.json']) {
    assert.ok(g.includes(p), `${p} が guardrailPaths に無い`);
  }
});

test('雛形の harness.config.json：projectChecks が書式の検査を通る', () => {
  assert.doesNotThrow(() => projectChecks(loadConfig(TEMPLATE)));
});

// ---- gate.yml ----

test('gate.yml：.node-version を読まず、node-version: 24 を使う', () => {
  const yml = read('.github/workflows/gate.yml');
  assert.ok(!yml.includes('node-version-file'), 'node-version-file がある');
  assert.ok(!yml.includes('.node-version'), '.node-version がある');
  assert.match(yml, /node-version: 24\b/);
});

// Issue #306：sync ⇄ judge のループの上限（syncLoop）
test('雛形の harness.config.json：syncLoop のキーと値の型が harness.config.json とそろい、syncLoopConfig の検査を通る', () => {
  const tpl = loadConfig(TEMPLATE);
  const cur = loadConfig();
  assert.deepEqual(shape(tpl.syncLoop), shape(cur.syncLoop));
  assert.deepEqual(syncLoopConfig(tpl), syncLoopConfig(cur));
});
