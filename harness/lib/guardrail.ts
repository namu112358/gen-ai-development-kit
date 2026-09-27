import type { HarnessConfig } from './config.ts';
import { patternsOverlap } from './epic.ts';
import { globToRegExp } from './scope.ts';

/**
 * ガードレール：Agent が自分を縛る仕組み（App が機械的に強制している部分）。
 * 一覧は `harness.config.json` の `guardrailPaths`（除外は `guardrailExclude`）。触れる PR は自動 Merge せず、
 * 触れる計画は計画ゲートで止める。一覧が無い設定ではすべてのファイルをガードレールとして扱う（安全側）。
 */

export type GuardrailConfig = Pick<HarnessConfig, 'guardrailPaths' | 'guardrailExclude'>;

/** 一覧自身。除外に書いても外せない */
export const GUARDRAIL_SELF = 'harness.config.json';

const uniqSorted = (items: string[]): string[] => [...new Set(items)].sort();

/** 変更ファイル（リネームは旧パスも渡す）のうち、ガードレールに当たるもの */
export function guardrailFiles(config: GuardrailConfig, files: string[]): string[] {
  if (!config.guardrailPaths) return uniqSorted(files);
  const include = config.guardrailPaths.map(globToRegExp);
  const exclude = (config.guardrailExclude ?? []).map(globToRegExp);
  return uniqSorted(files.filter((f) => f === GUARDRAIL_SELF || (include.some((m) => m.test(f)) && !exclude.some((m) => m.test(f)))));
}

/**
 * 計画のパターンのうち、ガードレールに当たりうるもの（安全側に倒す）。
 * ガードレールのパターンと重なりうれば当たる（harness/lib/epic.ts の patternsOverlap）。
 * 除外は、計画のパターンが除外に完全に含まれるとき（具体的なパスが除外に一致する、または除外と同じパターン）だけ外す。
 */
export function guardrailPatterns(config: GuardrailConfig, patterns: string[]): string[] {
  if (!config.guardrailPaths) return uniqSorted(patterns);
  const paths = config.guardrailPaths;
  const exclude = config.guardrailExclude ?? [];
  const excluded = (p: string): boolean => exclude.some((e) => p === e || (!p.includes('*') && globToRegExp(e).test(p)));
  return uniqSorted(patterns.filter((p) => patternsOverlap(p, GUARDRAIL_SELF) || (paths.some((g) => patternsOverlap(p, g)) && !excluded(p))));
}
