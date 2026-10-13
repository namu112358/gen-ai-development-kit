// レビューの材料にするリポジトリの規則（根の CLAUDE.md・AGENTS.md と、それらが `@<パス>` で読み込むファイル）を、
// PR の base の SHA だけで上限つきで集める collectRules と、`@` の取り出し importPaths・パスの解決 resolveImport。
// 深さの上限を超える `@` の先は読まずに残りを渡し、ファイル数・文字数の上限を超えたとき（too-large）と 404 以外の失敗（unreadable）は規則を1つも渡さない。
// import は ./github.ts の型と ./prompts.ts の isSecretPath だけ（Node と Workers の両方で動く）。GitHub に書く操作はしない（読むだけ）。
import type { GitHubClient } from './github.ts';
import { isSecretPath } from './prompts.ts';

export type RulesStatus = 'ok' | 'none' | 'unreadable' | 'too-large';
export type RulesSkipReason = 'outside' | 'secret' | 'missing' | 'depth';

export interface RepositoryRules {
  status: RulesStatus;
  files: { path: string; content: string }[];
  /** 返した files の文字数の合計（too-large・unreadable・none は 0） */
  chars: number;
  skipped: { path: string; reason: RulesSkipReason }[];
}

export interface RulesLimits {
  /** 入口を 0、`@` を1回辿るごとに +1。超える先は読まない */
  maxDepth: number;
  /** 読めたファイルの数（missing は数えない） */
  maxFiles: number;
  /** 読めたファイルの文字数の合計 */
  maxChars: number;
}

export const RULES_LIMITS: RulesLimits = { maxDepth: 3, maxFiles: 20, maxChars: 40000 };

const ENTRIES = ['CLAUDE.md', 'AGENTS.md'];

/** 行頭か空白の直後の `@` から次の空白まで。コードのフェンス（webhook.ts の withoutCommentsAndFences と同じ開き閉じ）とインラインコードの中は見ない。出てくる順・重複なし */
export function importPaths(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence === null) {
      if (m) {
        fence = m[1]!;
        continue;
      }
    } else {
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    const plain = line.replace(/(`+)[\s\S]*?\1/g, ' ');
    for (const hit of plain.matchAll(/(?:^|\s)@(\S+)/g)) {
      const target = hit[1]!;
      if (!out.includes(target)) out.push(target);
    }
  }
  return out;
}

/** fromFile のディレクトリからの相対で target を解き、根からの相対パスを返す。/・~ で始まる、\ を含む、根の外に出るなら null */
export function resolveImport(fromFile: string, target: string): string | null {
  if (target.startsWith('/') || target.startsWith('~') || target.includes('\\')) return null;
  const parts = fromFile.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? null : parts.join('/');
}

export async function collectRules(
  gh: Pick<GitHubClient, 'getFileContent'>,
  baseSha: string,
  limits: Partial<RulesLimits> = {},
): Promise<RepositoryRules> {
  const { maxDepth, maxFiles, maxChars } = { ...RULES_LIMITS, ...limits };
  const files: { path: string; content: string }[] = [];
  const skipped: RepositoryRules['skipped'] = [];
  const seen = new Set<string>();
  const empty = (status: RulesStatus): RepositoryRules => ({ status, files: [], chars: 0, skipped });
  let chars = 0;
  // 幅優先。entry は入口（404 を skipped に入れない）
  const queue: { path: string; depth: number; entry: boolean }[] = ENTRIES.map((path) => ({ path, depth: 0, entry: true }));
  for (const path of ENTRIES) seen.add(path);
  while (queue.length > 0) {
    const item = queue.shift()!;
    let content: string | null;
    try {
      content = await gh.getFileContent(item.path, baseSha);
    } catch {
      return { status: 'unreadable', files: [], chars: 0, skipped };
    }
    if (content === null) {
      if (!item.entry) skipped.push({ path: item.path, reason: 'missing' });
      continue;
    }
    files.push({ path: item.path, content });
    chars += content.length;
    if (files.length > maxFiles || chars > maxChars) return empty('too-large');
    for (const target of importPaths(content)) {
      const resolved = resolveImport(item.path, target);
      const key = resolved ?? target;
      if (seen.has(key)) continue;
      seen.add(key);
      // 理由の順は outside → secret → depth（読んで無ければ missing）
      if (resolved === null) skipped.push({ path: target, reason: 'outside' });
      else if (isSecretPath(resolved)) skipped.push({ path: resolved, reason: 'secret' });
      else if (item.depth + 1 > maxDepth) skipped.push({ path: resolved, reason: 'depth' });
      else queue.push({ path: resolved, depth: item.depth + 1, entry: false });
    }
  }
  if (files.length === 0) return empty('none');
  return { status: 'ok', files, chars, skipped };
}
