// .claude/settings.json と deny の雛形の permissions.deny を読み、Bash の規則の照合を近似する補助（Issue #218・#241・#404）。
// deny の規則を確かめるテスト（settings-deny.test.ts・settings-deny-push.test.ts）が同じ読み方と照合を使う。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');

export interface SettingsLike { permissions?: { deny?: string[] } }

export function denyOf(p: string): string[] {
  const json = JSON.parse(readFileSync(join(root, p), 'utf8')) as SettingsLike;
  const deny = json.permissions?.deny;
  assert.ok(Array.isArray(deny), `${p} に permissions.deny がありません`);
  return deny;
}

export const SETTINGS = '.claude/settings.json';
export const TEMPLATE = 'harness/templates/claude-settings.deny.json';

/**
 * Claude Code の Bash の規則の照合の近似：`Bash(<型>)` の `*` を任意の文字の並び（改行も含む）として、コマンド全体に当てる。
 * 本物の照合（`&&` などで区切った部分ごとの照合など）とは違うので、Merge の後に付き添いのセッションで実物を確かめる。
 */
export function matchesRule(rule: string, command: string): boolean {
  const m = /^Bash\(([\s\S]*)\)$/.exec(rule);
  if (!m) return false;
  const re = new RegExp(`^${m[1]!.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);
  return re.test(command);
}

export const hits = (deny: string[], command: string): string[] => deny.filter((r) => matchesRule(r, command));
