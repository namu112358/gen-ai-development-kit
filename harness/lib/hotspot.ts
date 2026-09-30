import { globToRegExp } from './scope.ts';

/**
 * 保守の観測（harness/scripts/observe.ts）のホットスポット：直近の期間に変更の多い大きなファイル。
 * `git log --numstat` の出力と今の行数を読んで数えるだけの純粋関数（git を動かすのは呼び出し側）。
 * 並びは「変更回数（コミット数）× 今の行数」の大きい順。消えたファイルと classification.sizeExclude に当たるものは除く。
 */

export interface FileChurn {
  file: string;
  /** 変更したコミットの数 */
  commits: number;
  added: number;
  deleted: number;
}

export interface Hotspot extends FileChurn {
  /** 今の行数 */
  lines: number;
  /** commits × lines */
  score: number;
}

/** parseNumstat が読む形の git log の引数（リネームは追わない。コミットごとに `commit <sha>` の行が先に出る） */
export const HOTSPOT_LOG_ARGS = (sinceIso: string): string[] => ['log', `--since=${sinceIso}`, '--no-renames', '--numstat', '--format=commit %H'];

/** `git log --no-renames --numstat --format=commit %H` の出力を、ファイルごとの変更回数と追加・削除行数にする（バイナリの `-` は 0 行） */
export function parseNumstat(log: string): FileChurn[] {
  const byFile = new Map<string, FileChurn>();
  let seen = new Set<string>();
  for (const raw of log.split(/\r?\n/)) {
    if (/^commit [0-9a-f]+\s*$/.test(raw)) {
      seen = new Set();
      continue;
    }
    const m = raw.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const file = m[3]!;
    const churn = byFile.get(file) ?? { file, commits: 0, added: 0, deleted: 0 };
    if (!seen.has(file)) {
      churn.commits++;
      seen.add(file);
    }
    churn.added += m[1] === '-' ? 0 : Number(m[1]);
    churn.deleted += m[2] === '-' ? 0 : Number(m[2]);
    byFile.set(file, churn);
  }
  return [...byFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** 行数（末尾の改行は数えない。空なら 0） */
export function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/** 今あるファイル（lines にあるもの）だけを、score の大きい順（同じなら変更回数の多い順、ファイル名の順）に並べ、top で切る */
export function rankHotspots(
  churn: FileChurn[],
  lines: ReadonlyMap<string, number>,
  opts: { top: number; exclude: string[] },
): { items: Hotspot[]; total: number; truncated: number } {
  const excluded = opts.exclude.map(globToRegExp);
  const all: Hotspot[] = churn
    .filter((c) => lines.has(c.file) && !excluded.some((re) => re.test(c.file)))
    .map((c) => {
      const n = lines.get(c.file)!;
      return { ...c, lines: n, score: c.commits * n };
    })
    .sort((a, b) => b.score - a.score || b.commits - a.commits || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const items = all.slice(0, opts.top);
  return { items, total: all.length, truncated: all.length - items.length };
}
