// Issue #195：権限のモードの設定。.claude/settings.json で bypass（--dangerously-skip-permissions）を使えなくし、
// defaultMode はリポジトリに書かない（利用者の ~/.claude/settings.json に任せる）こと、managed.json がそのキーを持つこと、
// docs/setup.md の Orca の節に利用者の設定と Orca の Agent Permissions の手順が書かれていることを確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, ...rel.split('/')), 'utf8');

/** docs/setup.md の Orca の節の番号（人の判断待ち。変えるときはここだけ直す） */
const ORCA_SECTION_NO = 11;
const ORCA_HEADING_PREFIX = `## ${ORCA_SECTION_NO}. Orca`;

interface Settings {
  permissions?: { disableBypassPermissionsMode?: unknown; defaultMode?: unknown };
}

test('.claude/settings.json：permissions.disableBypassPermissionsMode が "disable" で、defaultMode は書かない', () => {
  const settings = JSON.parse(read('.claude/settings.json')) as Settings;
  assert.equal(settings.permissions?.disableBypassPermissionsMode, 'disable');
  assert.ok(!(settings.permissions && 'defaultMode' in settings.permissions), 'permissions.defaultMode が書かれている');
});

test('harness/managed.json：settingsKeys に permissions.disableBypassPermissionsMode がある', () => {
  const m = JSON.parse(read('harness/managed.json')) as { settingsKeys: string[] };
  assert.ok(m.settingsKeys.includes('permissions.disableBypassPermissionsMode'));
});

test(`docs/setup.md の節${ORCA_SECTION_NO}（Orca）に、利用者の権限の設定と Orca の Agent Permissions の手順がある`, () => {
  const lines = read('docs/setup.md').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(ORCA_HEADING_PREFIX));
  assert.ok(start !== -1, `docs/setup.md に「${ORCA_HEADING_PREFIX}」で始まる見出しが無い`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  const section = lines.slice(start, end).join('\n');
  for (const s of [
    '~/.claude/settings.json',
    '"defaultMode": "auto"',
    'Agent Permissions',
    'Manual',
    '--permission-mode auto',
    '--dangerously-skip-permissions',
    'agentDefaultArgs',
    'disableBypassPermissionsMode',
  ]) {
    assert.ok(section.includes(s), `Orca の節に ${s} が無い`);
  }
});
