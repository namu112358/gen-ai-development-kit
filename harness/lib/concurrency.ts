import { AREA_PREFIX, areaLabels } from './classify.ts';
import type { HarnessConfig } from './config.ts';

/**
 * 領域（area）ごとの、同時に開いてよい PR の上限。長く開いたままの PR が同じ領域に重なると、
 * 1本 Merge されるたびに残りが衝突するため、上限に達した領域では新しく実装に着手しない。
 */

export interface AreaLimit {
  area: string;
  open: number;
  limit: number;
}

/** 計画の触るファイルが入る領域のうち、開いた PR の数が上限に達しているもの。設定の無い領域は数えない */
export function fullAreas(config: HarnessConfig, planFiles: string[], openPrLabels: string[][]): AreaLimit[] {
  const limits = config.areaConcurrency ?? {};
  const out: AreaLimit[] = [];
  for (const label of areaLabels(config, planFiles)) {
    const area = label.slice(AREA_PREFIX.length);
    const limit = limits[area];
    if (limit === undefined) continue;
    const open = openPrLabels.filter((labels) => labels.includes(label)).length;
    if (open >= limit) out.push({ area, open, limit });
  }
  return out;
}

export function describeFullAreas(full: AreaLimit[]): string {
  return full.map((f) => `\`${AREA_PREFIX}${f.area}\` の開いた PR が上限（${f.open}/${f.limit}）`).join('、');
}
