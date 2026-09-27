import { globToRegExp, validateScopePattern } from './scope.ts';
import { parseTitle } from './title.ts';
import type { Checker } from './validate.ts';

/**
 * Epic：計画の `split` で大きな課題を子課題に分ける。書式は docs/formats.md を参照。
 * 分け方は人が承認しない。ここの検査に通れば App が子 Issue を作る（harness/gates/epic-split.ts）。
 */

export interface SplitChild {
  /** 子 Issue のタイトル（Conventional Commits） */
  title: string;
  goal: string;
  requirements: string[];
  acceptanceCriteria: string[];
  /** 触るファイル（範囲パターン）。兄弟どうしで重ならないこと */
  files: string[];
  /** 先に終わらせる兄弟の添字（自分より前に並ぶものだけ） */
  dependsOn: number[];
}

/** 型の検査だけを行う（意味の検査は validateSplit） */
export function parseSplit(c: Checker, raw: unknown, path = 'plan.split'): SplitChild[] {
  return c.array(raw, path).map((item, i) => {
    const p = `${path}[${i}]`;
    const o = c.object(item, p) ?? {};
    return {
      title: c.string(o.title, `${p}.title`, { nonEmpty: true }),
      goal: c.string(o.goal, `${p}.goal`, { nonEmpty: true }),
      requirements: c.stringArray(o.requirements, `${p}.requirements`),
      acceptanceCriteria: c.stringArray(o.acceptanceCriteria, `${p}.acceptanceCriteria`),
      files: c.stringArray(o.files, `${p}.files`),
      dependsOn: o.dependsOn === undefined ? [] : c.array(o.dependsOn, `${p}.dependsOn`).map((d, j) => c.integer(d, `${p}.dependsOn[${j}]`)),
    };
  });
}

/** 2つの範囲パターンが重なるか（同じパス、または片方のパターンがもう片方に一致する） */
export function patternsOverlap(a: string, b: string): boolean {
  return a === b || globToRegExp(a).test(b) || globToRegExp(b).test(a);
}

/** 分け方の検査。問題があれば理由を返す（空なら通過） */
export function validateSplit(split: SplitChild[]): string[] {
  const reasons: string[] = [];
  if (split.length < 2) reasons.push(`split は2件以上にしてください（${split.length} 件）`);
  split.forEach((child, i) => {
    const p = `split[${i}]`;
    const title = parseTitle(child.title);
    if (!title.ok) reasons.push(`${p}.title「${child.title}」: ${title.error}`);
    if (child.requirements.filter((r) => r.trim() !== '').length === 0) reasons.push(`${p}.requirements が空です`);
    if (child.acceptanceCriteria.filter((a) => a.trim() !== '').length === 0) reasons.push(`${p}.acceptanceCriteria が空です`);
    if (child.files.length === 0) reasons.push(`${p}.files が空です`);
    for (const pattern of child.files) {
      const problem = validateScopePattern(pattern);
      if (problem) reasons.push(`${p}.files「${pattern}」: ${problem}`);
    }
    for (const d of child.dependsOn) {
      if (d < 0 || d >= i) reasons.push(`${p}.dependsOn の ${d} は自分より前の兄弟の添字ではありません`);
    }
    if (new Set(child.dependsOn).size !== child.dependsOn.length) reasons.push(`${p}.dependsOn が重複しています`);
  });
  for (let i = 0; i < split.length; i++) {
    for (let j = i + 1; j < split.length; j++) {
      for (const a of split[i]!.files) {
        for (const b of split[j]!.files) {
          if (patternsOverlap(a, b)) reasons.push(`split[${i}] と split[${j}] の files が重なります（「${a}」と「${b}」）`);
        }
      }
    }
  }
  return reasons;
}

export const childMarker = (parent: number, index: number): string => `<!-- agent-harness:epic-child parent=${parent} index=${index} -->`;

/** 子 Issue の本文の目印を読む（無ければ null） */
export function parseChildMarker(body: string | null | undefined): { parent: number; index: number } | null {
  const m = (body ?? '').match(/<!-- agent-harness:epic-child parent=(\d+) index=(\d+) -->/);
  return m ? { parent: Number(m[1]), index: Number(m[2]) } : null;
}

/** 子 Issue の本文（Issue Form の見出し）。blockers は dependsOn の兄弟の Issue 番号 */
export function renderChildBody(parent: number, index: number, split: SplitChild[], blockers: number[]): string {
  const child = split[index]!;
  const bullets = (items: string[]) => items.map((x) => `- ${x}`).join('\n');
  return [
    '### Goal', '', child.goal, '',
    '### Background', '', `Epic #${parent} の子課題（${index + 1}/${split.length}）。App が Epic の計画から作った。`, '',
    `触るファイルの見込み：${child.files.map((f) => `\`${f}\``).join(', ')}`, '',
    '### Requirements', '', bullets(child.requirements), '',
    '### Non-goals', '', `Epic #${parent} の他の子課題の範囲`, '',
    '### Acceptance Criteria', '', child.acceptanceCriteria.map((a) => `- [ ] ${a}`).join('\n'), '',
    '### Dependencies', '', blockers.length > 0 ? `${blockers.map((n) => `#${n}`).join('、')} の後（Issue Dependencies に登録済み）` : '_No response_', '',
    '### Validation Requirements', '', `Epic #${parent} の Validation Requirements に従う`, '',
    childMarker(parent, index),
  ].join('\n');
}
