import type { HarnessConfig } from './config.ts';
import { globToRegExp } from './scope.ts';

/**
 * PR の分類ラベル（表示用）。App が差分から決定的に付ける。
 * - size:*：追加＋削除の行数（lockfile など sizeExclude は数えない）。App が管理し、変われば付け替える
 * - area:*：変更ファイルのパス。足すだけで外さない（人が付けたものを上書きしない）
 */

export interface ChangedFile {
  filename: string;
  additions: number;
  deletions: number;
}

export const SIZE_PREFIX = 'size:';
export const AREA_PREFIX = 'area:';

export function sizeLabel(config: HarnessConfig, files: ChangedFile[]): string {
  const excluded = config.classification.sizeExclude.map(globToRegExp);
  const lines = files
    .filter((f) => !excluded.some((re) => re.test(f.filename)))
    .reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const hit = config.classification.sizes.find(([, max]) => lines < max);
  return `${SIZE_PREFIX}${hit ? hit[0] : 'XXL'}`;
}

export function areaLabels(config: HarnessConfig, files: string[]): string[] {
  const areas = Object.entries(config.classification.areas).map(([name, patterns]) => ({ name, res: patterns.map(globToRegExp) }));
  const hits = new Set<string>();
  for (const file of files) for (const a of areas) if (a.res.some((re) => re.test(file))) hits.add(`${AREA_PREFIX}${a.name}`);
  return [...hits].sort();
}

/** 付け外しするラベル。size は1つに揃え、area は足すだけ */
export function classificationChanges(current: string[], size: string, areas: string[]): { add: string[]; remove: string[] } {
  const remove = current.filter((l) => l.startsWith(SIZE_PREFIX) && l !== size);
  const add = [size, ...areas].filter((l) => !current.includes(l));
  return { add, remove };
}
