/**
 * 計画の「触るファイル一覧」と実際の diff の照合（範囲照合）。
 * 一覧の各項目はリポジトリルートからのパス。`*`（1階層内の任意の文字列）と `**`（任意の階層）を使える。
 * `?` などその他の記号はワイルドカードとして扱わない（文字どおりに照合する）。
 * 範囲が意味をなさなくなる広すぎるパターン（最初の階層にワイルドカード）は計画ゲートで拒否する。
 */

export function validateScopePattern(pattern: string): string | null {
  if (pattern.trim() !== pattern || pattern === '') return '空または前後に空白があります';
  if (pattern.startsWith('/') || pattern.startsWith('./')) return 'リポジトリルートからの相対パスで書いてください';
  if (pattern.split('/').includes('..')) return '`..` は使えません';
  if (pattern.split('/')[0]!.includes('*')) return '最初の階層がワイルドカードのパターンは範囲が広すぎます';
  return null;
}

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export interface ScopeResult {
  ok: boolean;
  outside: string[];
}

/** changed: 変更されたファイル（リネームは旧・新の両方を渡す） */
export function checkScope(planned: string[], changed: string[]): ScopeResult {
  const matchers = planned.map(globToRegExp);
  const outside = [...new Set(changed)].filter((file) => !matchers.some((m) => m.test(file))).sort();
  return { ok: outside.length === 0, outside };
}
