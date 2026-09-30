// harness/scripts/agent.ts とそのサブコマンド（harness/scripts/agent/ の下）のソースを読む補助（Issue #313）。
// コマンドは agent/commands/ のファイルに分かれているので、ソースの文字列や使い方のコメントを確かめるテストは、ここで全部をつないで読む。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');

/** agent.ts と、harness/scripts/agent/ の下の全部の .ts のパス（リポジトリのルートからの相対パス。名前の順） */
export function agentSourceFiles(): string[] {
  const dir = join(root, 'harness', 'scripts', 'agent');
  const nested = (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `harness/scripts/agent/${f}`);
  return ['harness/scripts/agent.ts', ...nested];
}

/** agent.ts とサブコマンドのソースをつないだ文字列 */
export function agentSource(): string {
  return agentSourceFiles().map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
}

/** 使い方のコメント（`node harness/scripts/agent.ts <コマンド>` の行）に書かれたコマンド名 */
export function documentedAgentCommands(): Set<string> {
  const usage = (agentSource().match(/\/\*\*[\s\S]*?\*\//g) ?? []).filter((c) => c.includes('node harness/scripts/agent.ts')).join('\n');
  return new Set([...usage.matchAll(/^\s*\*\s+node harness\/scripts\/agent\.ts ([a-z][a-z-]*)/gm)].map((m) => m[1]!));
}
