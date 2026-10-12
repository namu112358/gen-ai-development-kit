// Issue #790：sync が導入先の .claude/settings.json に入れるとき、permissions.allow だけは managed.json の settingsAllow の行を
// 導入先の配列に足し（和集合）、ほかの settingsKeys（deny・disableBypassPermissionsMode・hooks）は kit の値で置き換えることと、
// このリポジトリが配る allow の一覧（4行）を確かめる。kit の settings の allow が入らないことは sync-kit.test.ts の (3) で見る。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeSettings } from '../lib/sync.ts';

const KEYS = ['permissions.deny', 'permissions.disableBypassPermissionsMode', 'hooks', 'permissions.allow'];

const kitSettings = {
  permissions: {
    deny: ['Bash(git push --force:*)', 'Read(.env)'],
    allow: ['Bash(kit-only)'],
    disableBypassPermissionsMode: 'disable',
  },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node harness/hooks/start.ts' }] }] },
};

test('(a)(b)(c) 導入先の allow の行と順は残り、配る行は無いものだけ順に1回ずつ足され、deny・disableBypassPermissionsMode・hooks は kit の値になる', () => {
  const target = {
    permissions: {
      deny: ['Bash(rm:*)'],
      allow: ['Bash(local-1)', 'Bash(gh pr view *)', 'Bash(local-2)'],
      disableBypassPermissionsMode: 'enable',
    },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo local' }] }] },
    model: 'opus',
  };
  const allowRows = ['Bash(gh issue view *)', 'Bash(gh pr view *)', 'Bash(gh issue view *)', 'Bash(gh pr diff *)'];
  assert.deepEqual(mergeSettings(target, kitSettings, KEYS, allowRows), {
    merged: {
      permissions: {
        deny: kitSettings.permissions.deny,
        allow: ['Bash(local-1)', 'Bash(gh pr view *)', 'Bash(local-2)', 'Bash(gh issue view *)', 'Bash(gh pr diff *)'],
        disableBypassPermissionsMode: 'disable',
      },
      hooks: kitSettings.hooks,
      model: 'opus',
    },
    changedKeys: KEYS,
  });
});

test('(b) 配る行がすべて導入先にあれば allow は変わらず、changedKeys に permissions.allow が無い', () => {
  const target = {
    permissions: { deny: kitSettings.permissions.deny, allow: ['Bash(gh pr diff *)', 'Bash(local)', 'Bash(gh pr view *)'] },
  };
  const { merged, changedKeys } = mergeSettings(target, kitSettings, KEYS, ['Bash(gh pr view *)', 'Bash(gh pr diff *)']);
  assert.deepEqual((merged.permissions as { allow: string[] }).allow, ['Bash(gh pr diff *)', 'Bash(local)', 'Bash(gh pr view *)']);
  assert.ok(!changedKeys.includes('permissions.allow'), JSON.stringify(changedKeys));
});

test('(d) このリポジトリの managed.json が配る allow は4行だけ（npm run・WebFetch の行が無い）', () => {
  const root = join(import.meta.dirname, '..', '..');
  const m = JSON.parse(readFileSync(join(root, 'harness', 'managed.json'), 'utf8')) as { settingsAllow?: unknown };
  assert.deepEqual(m.settingsAllow, [
    'Bash(node harness/scripts/agent.ts *)',
    'Bash(gh issue view *)',
    'Bash(gh pr view *)',
    'Bash(gh pr diff *)',
  ]);
});

test('(e) 導入先の permissions.allow が配列でない（文字列・オブジェクト・数値・null）なら throw', () => {
  for (const allow of ['Bash(x)', { a: 'Bash(x)' }, 1, null]) {
    const target = { permissions: { allow } };
    assert.throws(() => mergeSettings(target, kitSettings, KEYS, ['Bash(gh pr view *)']), Error, JSON.stringify(allow));
  }
});
