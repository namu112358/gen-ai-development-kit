import { AREA_PREFIX, areaLabels } from './classify.ts';
import type { HarnessConfig } from './config.ts';
import { isAgentPr, type PullRequest } from './state.ts';

/**
 * 領域（area）ごとの、同時に開いてよい PR の上限。長く開いたままの PR が同じ領域に重なると、
 * 1本 Merge されるたびに残りが衝突するため、上限に達した領域では新しく実装に着手しない。
 * 数えるのは、同じリポジトリの Agent PR のうち Draft のもの（判定の前で、まだ push が続く PR）だけ。
 * App が「Draft＝判定前、Ready＝判定に合格して Merge 待ち」を保つので、Ready の PR（人の Merge 待ち・自動 Merge 待ち）と、人の PR・fork の PR は数えない。
 */

export interface AreaLimit {
  area: string;
  open: number;
  limit: number;
}

/** 領域の上限に数える PR か：同じリポジトリの Agent PR で、Draft のもの */
export function countsTowardAreaLimit(config: HarnessConfig, pr: PullRequest, repository: string): boolean {
  return isAgentPr(config, pr, repository) && pr.draft;
}

/** 開いた PR の一覧から、領域の上限に数える PR のラベル名だけを取り出す（fullAreas の openPrLabels に渡す） */
export function areaLimitLabels(config: HarnessConfig, prs: PullRequest[], repository: string): string[][] {
  return prs.filter((p) => countsTowardAreaLimit(config, p, repository)).map((p) => p.labels.map((l) => l.name));
}

/** 計画の触るファイルが入る領域のうち、数える PR（areaLimitLabels）の数が上限に達しているもの。設定の無い領域は数えない */
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
  return full.map((f) => `\`${AREA_PREFIX}${f.area}\` の判定前の Agent PR（Draft）が上限（${f.open}/${f.limit}）`).join('、');
}
