// Issue #650：sync の対象を決める純粋関数 planSync（harness/lib/sync.ts）。
// 共通の偽の kit と導入先を1つ用意し、返る SyncPlan 全体を deepEqual で確かめる（上書き・新規・unchanged・除外・missingInKit・
// projectOwned・settings の merge・kitVersion・prune のときだけ remove）。mergeSettings は planSync から確かめにくい分岐だけ単体で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSettings, planSync, type ManagedJson, type SyncInput, type SyncPlan } from '../lib/sync.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const managed: ManagedJson = {
  managed: ['harness/lib/**', '.claude/agents/**', 'harness/CLAUDE.harness.md'],
  exclude: ['harness/lib/private.ts'],
  projectOwned: [
    { path: 'harness.config.json', template: 'harness/templates/harness.config.json' },
    { path: 'CLAUDE.md', template: 'harness/templates/CLAUDE.template.md' },
  ],
  settingsKeys: ['permissions.deny', 'permissions.disableBypassPermissionsMode', 'hooks'],
};

const kitSettings = {
  permissions: {
    deny: ['Bash(git push --force:*)', 'Read(.env)'],
    allow: ['Bash(kit-only)'],
    disableBypassPermissionsMode: 'disable',
  },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node harness/hooks/start.ts' }] }] },
  env: { KIT_ONLY: '1' },
};

/** kit の全ファイル（managed に当たらないものも含む） */
const kitFiles = (): Map<string, Uint8Array> =>
  new Map<string, Uint8Array>([
    ['harness/lib/a.ts', enc('A2')], // 導入先と違う → overwrite
    ['harness/lib/b.ts', enc('B')], // 導入先と同じ → unchanged
    ['harness/lib/new.ts', enc('NEW')], // 導入先に無い → create
    ['harness/CLAUDE.harness.md', enc('rules')], // 導入先に無い → create
    ['harness/lib/private.ts', enc('P2')], // managed.json の exclude → どこにも出さない
    ['.claude/agents/x.md', enc('X')], // managed.local.json の exclude → excluded
    ['README.md', enc('kit readme')], // managed に当たらない → どこにも出さない
    ['harness/templates/harness.config.json', enc('{}')],
    ['harness/templates/CLAUDE.template.md', enc('# CLAUDE.md')],
    ['.claude/settings.json', enc(JSON.stringify(kitSettings))],
  ]);

/** 導入先の全ファイル */
const targetFiles = new Map<string, string>([
  ['harness/lib/a.ts', 'A1'],
  ['harness/lib/b.ts', 'B'],
  ['harness/lib/old.ts', 'OLD'], // managed に当たり kit に無い → missingInKit
  ['harness/lib/private.ts', 'P1'], // managed.json の exclude → 中身が違っても触らない
  ['.claude/agents/y.md', 'Y'], // kit に無いが managed.local.json の exclude → excluded
  ['harness.config.json', '{"project":true}'], // projectOwned で有る → 触らない
  ['src/app.ts', 'app'], // managed に当たらない → どこにも出さない
  ['.claude/settings.json', '{}'],
]);

/** 導入先の settings（managed のキーは kit と同じ、導入先の allow と独自のキーを持つ） */
const sameTargetSettings = () => ({
  permissions: {
    deny: ['Bash(git push --force:*)', 'Read(.env)'],
    allow: ['Bash(npm test)'],
    disableBypassPermissionsMode: 'disable',
  },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node harness/hooks/start.ts' }] }] },
  model: 'opus',
});

const kit = { repository: 'owner/gen-ai-development-kit', ref: 'v1.2.0', sha: '0123456789abcdef0123456789abcdef01234567' };
const now = new Date('2026-10-11T01:02:03.000Z');

const baseInput = (over: Partial<SyncInput> = {}): SyncInput => ({
  managed,
  local: { exclude: ['.claude/agents/**'] },
  kitFiles: kitFiles(),
  targetList: () => [...targetFiles.keys()],
  targetRead: (path) => {
    const s = targetFiles.get(path);
    return s === undefined ? null : enc(s);
  },
  targetSettings: sameTargetSettings(),
  kit,
  now,
  prune: false,
  ...over,
});

const basePlan = (): SyncPlan => ({
  overwrite: ['harness/lib/a.ts'],
  create: ['CLAUDE.md', 'harness/CLAUDE.harness.md', 'harness/lib/new.ts'],
  unchanged: ['harness/lib/b.ts'],
  excluded: ['.claude/agents/x.md', '.claude/agents/y.md'],
  missingInKit: ['harness/lib/old.ts'],
  remove: [],
  settings: { merged: sameTargetSettings(), changedKeys: [] },
  kitVersion: { ...kit, syncedAt: '2026-10-11T01:02:03.000Z' },
});

test('(1) 上書き・新規・unchanged・除外・missingInKit・projectOwned（有る／無い）・managed.json の exclude を1回で決める（prune でなければ remove は空）', () => {
  assert.deepEqual(planSync(baseInput()), basePlan());
});

test('(2) prune のときだけ remove が missingInKit と同じになる', () => {
  assert.deepEqual(planSync(baseInput({ prune: true })), { ...basePlan(), remove: ['harness/lib/old.ts'] });
});

test('(3) settings：deny は kit の値で置き換え、導入先の allow と独自のキーは残り、changedKeys は settingsKeys の順', () => {
  const target = {
    permissions: { deny: ['Bash(rm:*)'], allow: ['Bash(npm test)'], disableBypassPermissionsMode: 'disable' },
    hooks: { Stop: [] },
    model: 'opus',
  };
  assert.deepEqual(planSync(baseInput({ targetSettings: target })), {
    ...basePlan(),
    settings: {
      merged: {
        permissions: {
          deny: ['Bash(git push --force:*)', 'Read(.env)'],
          allow: ['Bash(npm test)'],
          disableBypassPermissionsMode: 'disable',
        },
        hooks: kitSettings.hooks,
        model: 'opus',
      },
      changedKeys: ['permissions.deny', 'hooks'],
    },
  });
});

test('(4) 導入先に settings が無い：kit の settingsKeys のキーだけで作り、changedKeys は取り出したキーの全部', () => {
  assert.deepEqual(planSync(baseInput({ targetSettings: null })), {
    ...basePlan(),
    settings: {
      merged: {
        permissions: { deny: kitSettings.permissions.deny, disableBypassPermissionsMode: 'disable' },
        hooks: kitSettings.hooks,
      },
      changedKeys: ['permissions.deny', 'permissions.disableBypassPermissionsMode', 'hooks'],
    },
  });
});

test('(5) kitVersion：kit の repository・ref・sha と、now の ISO 文字列の syncedAt', () => {
  const other = { repository: 'acme/kit', ref: 'main', sha: 'ffffffffffffffffffffffffffffffffffffffff' };
  const at = new Date('2027-01-02T03:04:05.678Z');
  assert.deepEqual(planSync(baseInput({ kit: other, now: at })), {
    ...basePlan(),
    kitVersion: { ...other, syncedAt: '2027-01-02T03:04:05.678Z' },
  });
});

test('mergeSettings：keys のパスが kit に無いキーは触らない', () => {
  const target = { permissions: { deny: ['old'], allow: ['a'] }, hooks: { Stop: [] } };
  const kitOnlyDeny = { permissions: { deny: ['new'] } };
  assert.deepEqual(mergeSettings(target, kitOnlyDeny, ['permissions.deny', 'permissions.disableBypassPermissionsMode', 'hooks']), {
    merged: { permissions: { deny: ['new'], allow: ['a'] }, hooks: { Stop: [] } },
    changedKeys: ['permissions.deny'],
  });
});

test('導入先の settings がオブジェクトでない（配列・文字列・数値・真偽値）なら throw', () => {
  for (const target of [[], ['x'], 'settings', 1, true]) {
    assert.throws(() => mergeSettings(target, kitSettings, managed.settingsKeys), Error, JSON.stringify(target));
    assert.throws(() => planSync(baseInput({ targetSettings: target })), Error, JSON.stringify(target));
  }
});
