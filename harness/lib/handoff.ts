/** 引き継ぎ（```agent-handoff）：fleet の入れ子の ship が段階の終わりに fleet へ返す書式と検査（Issue #447）。書式は docs/formats.md。 */
import { Checker } from './validate.ts';

export const HANDOFF_STAGES = ['plan', 'implement', 'judge', 'fix', 'sync', 'merged'] as const;
export const HANDOFF_STATUSES = ['continue', 'merge-wait', 'human-decision', 'wait', 'no-nesting', 'return-to-human', 'closed', 'not-closed'] as const;

export type HandoffStage = (typeof HANDOFF_STAGES)[number];
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export interface Handoff {
  version: 1;
  issue: number;
  stage: HandoffStage;
  status: HandoffStatus;
  next: HandoffStage | null;
  pr: number | null;
  branch: string | null;
  done: string;
  notes: string[];
}

const MAX_TEXT = 2000;
const MAX_NOTES = 20;

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export function parseHandoff(value: unknown): { ok: true; value: Handoff } | { ok: false; errors: string[] } {
  const c = new Checker();
  const o = c.object(value, 'handoff');
  if (!o) return { ok: false, errors: c.errors };
  if (o.version !== 1) c.errors.push('handoff.version: 1 ではありません');
  if (!isPositiveInt(o.issue)) c.errors.push('handoff.issue: 正の整数ではありません');
  const stage = c.oneOf(o.stage, HANDOFF_STAGES, 'handoff.stage');
  const status = c.oneOf(o.status, HANDOFF_STATUSES, 'handoff.status');
  let next: HandoffStage | null = null;
  if (status === 'continue') {
    const nextStages = HANDOFF_STAGES.filter((s) => s !== 'merged');
    if (typeof o.next === 'string' && (nextStages as readonly string[]).includes(o.next)) next = o.next as HandoffStage;
    else c.errors.push(`handoff.next: status が continue のときは ${nextStages.join(' / ')} のいずれかが必要です`);
  } else if (o.next !== null) c.errors.push('handoff.next: status が continue 以外のときは null です');
  if (o.pr !== null && !isPositiveInt(o.pr)) c.errors.push('handoff.pr: 正の整数か null ではありません');
  if (o.branch !== null) c.string(o.branch, 'handoff.branch', { nonEmpty: true });
  const done = c.string(o.done, 'handoff.done', { nonEmpty: true });
  if (done.length > MAX_TEXT) c.errors.push(`handoff.done: ${MAX_TEXT} 文字までです`);
  const notes = c.stringArray(o.notes, 'handoff.notes');
  if (notes.length > MAX_NOTES) c.errors.push(`handoff.notes: ${MAX_NOTES} 件までです`);
  notes.forEach((n, i) => {
    if (n.trim() === '') c.errors.push(`handoff.notes[${i}]: 空です`);
    if (n.length > MAX_TEXT) c.errors.push(`handoff.notes[${i}]: ${MAX_TEXT} 文字までです`);
  });
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return {
    ok: true,
    value: { version: 1, issue: o.issue as number, stage, status, next, pr: (o.pr as number | null) ?? null, branch: (o.branch as string | null) ?? null, done, notes },
  };
}
