import type { HarnessConfig } from './config.ts';
import type { IssueContract } from './issue-form.ts';
import type { JevAnswers } from './jev.ts';

/**
 * Issue の分類（種類・領域・優先度）を Jev に問い、提案をまとめる。
 * - shadow：agent:ready が付いたときに提案をコメントするだけでラベルは付けない
 * - label：足りない priority:*・area:* を、確率がそのラベルの下限（jev.thresholds.labelProbabilityByLabel、無ければ labelProbability）以上のときだけ付ける（harness/gates/label-apply.ts）
 * 着手の可否は人が決める。種類・書き方の問題は、人が見て直すための材料。
 */

const TYPES = {
  feature: 'Adds a new capability or user-visible behavior.',
  bug: 'Fixes something that is broken or behaves incorrectly.',
  docs: 'Changes documentation only.',
  refactor: 'Restructures code without changing behavior.',
  test: 'Adds or changes tests only.',
  chore: 'Build, CI, dependencies, or harness maintenance.',
};

/** 選択肢の名前は priority:* の段階と同じ（harness/lib/config.ts の PRIORITY_LABELS） */
const PRIORITIES = {
  highest: 'Emergency: security, data loss, a broken main branch, or everything else is blocked on it. Drop other work.',
  high: 'Urgent: blocks users or other planned work; should be done before regular work.',
  medium: 'Regular planned work.',
  low: 'Nice to have; can wait until there is spare capacity.',
  lowest: 'Someday: only if nothing else is waiting.',
};

export function buildTriageRequest(config: HarnessConfig, title: string, c: IssueContract) {
  const areas: Record<string, string> = Object.fromEntries(
    Object.entries(config.classification.areas).map(([name, patterns]) => [name, `Changes files under ${patterns.join(', ')}`]),
  );
  areas.other = 'None of the above.';
  return {
    model: config.jev.model,
    state: {
      title,
      goal: c.goal,
      background: c.background,
      requirements: c.requirements,
      non_goals: c.nonGoals,
      acceptance_criteria: c.acceptanceCriteria,
    },
    questions: {
      type: { type: 'choice', instructions: 'What kind of change does this issue request?', criteria: TYPES },
      area: { type: 'choice', instructions: 'Which part of the repository will this issue most likely change?', criteria: areas },
      priority: { type: 'choice', instructions: 'How urgent is this issue?', criteria: PRIORITIES },
      ac_verifiable: { type: 'noul', instructions: 'Is every item in `acceptance_criteria` concrete and objectively verifiable (an observable output, a test, or a command result)?' },
      requirements_clear: { type: 'noul', instructions: 'Could an engineer implement this issue without asking any clarifying questions?' },
    },
  };
}

export interface TriageSummary {
  type: [string, number];
  area: [string, number];
  priority: [string, number];
  acVerifiable: number;
  requirementsClear: number;
  warnings: string[];
}

const top = (probs: Record<string, number> | undefined): [string, number] => {
  const entries = Object.entries(probs ?? {}).sort((a, b) => b[1] - a[1]);
  return entries[0] ?? ['?', 0];
};

export function summarizeTriage(answers: JevAnswers): TriageSummary {
  const acVerifiable = answers.ac_verifiable?.noul ?? NaN;
  const requirementsClear = answers.requirements_clear?.noul ?? NaN;
  const warnings: string[] = [];
  if (!(acVerifiable >= 0.5)) warnings.push('AC が検証できる形になっていない可能性があります（観測できる出力・テスト・コマンドで書く）');
  if (!(requirementsClear >= 0.5)) warnings.push('要件が曖昧な可能性があります（計画ゲートで人の判断待ちになりやすい）');
  return {
    type: top(answers.type?.probabilities),
    area: top(answers.area?.probabilities),
    priority: top(answers.priority?.probabilities),
    acVerifiable,
    requirementsClear,
    warnings,
  };
}

export function renderTriage(s: TriageSummary, heading = 'Jev による分類の提案です（シャドー運用。ラベルは付けません）。'): string {
  const pct = (p: number) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '-');
  return [
    heading,
    '',
    '| 項目 | 提案 | 確率 |',
    '| --- | --- | --- |',
    `| 種類 | ${s.type[0]} | ${pct(s.type[1])} |`,
    `| 領域 | ${s.area[0]} | ${pct(s.area[1])} |`,
    `| 優先度 | ${s.priority[0]} | ${pct(s.priority[1])} |`,
    `| AC は検証できる形か | ${s.acVerifiable >= 0.5 ? 'はい' : 'いいえ'} | ${pct(s.acVerifiable)} |`,
    `| 要件は明確か | ${s.requirementsClear >= 0.5 ? 'はい' : 'いいえ'} | ${pct(s.requirementsClear)} |`,
    ...(s.warnings.length ? ['', ...s.warnings.map((w) => `- ${w}`)] : []),
  ].join('\n');
}
