/**
 * Issue Forms（.github/ISSUE_TEMPLATE/agent-task.yml）が出力する本文の読み取り。
 * フォームは各項目を `### <label>` 見出しで出力し、未入力は `_No response_` になる。
 * フォームの label を変えたらここの SECTIONS も変え、harness/test/issue-form.test.ts を通すこと。
 */

export const SECTIONS = [
  { key: 'goal', label: 'Goal', required: true },
  { key: 'background', label: 'Background', required: false },
  { key: 'requirements', label: 'Requirements', required: true },
  { key: 'nonGoals', label: 'Non-goals', required: false },
  { key: 'acceptanceCriteria', label: 'Acceptance Criteria', required: true },
  { key: 'dependencies', label: 'Dependencies', required: false },
  { key: 'validation', label: 'Validation Requirements', required: false },
] as const;

export type SectionKey = (typeof SECTIONS)[number]['key'];
export type IssueContract = Record<SectionKey, string>;

export type ParseResult =
  | { ok: true; contract: IssueContract }
  | { ok: false; errors: string[] };

const NO_RESPONSE = '_No response_';

export function parseIssueBody(body: string | null | undefined): ParseResult {
  const text = (body ?? '').replace(/\r\n/g, '\n');
  const found = new Map<string, string>();
  const heading = /^###[ \t]+(.+?)[ \t]*$/gm;
  const marks: { label: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(heading)) {
    marks.push({ label: m[1]!.trim(), start: m.index, end: m.index + m[0].length });
  }
  marks.forEach((mark, i) => {
    const next = marks[i + 1];
    const content = text.slice(mark.end, next ? next.start : text.length).trim();
    if (!found.has(mark.label)) found.set(mark.label, content === NO_RESPONSE ? '' : content);
  });

  const errors: string[] = [];
  const contract = {} as IssueContract;
  for (const section of SECTIONS) {
    const value = found.get(section.label);
    if (value === undefined) {
      if (section.required) errors.push(`見出し「### ${section.label}」がありません`);
      contract[section.key] = '';
      continue;
    }
    if (section.required && value === '') errors.push(`「${section.label}」が空です`);
    contract[section.key] = value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, contract };
}

/** Acceptance Criteria を箇条書き（`- [ ]`、`-`、`1.`）から項目の配列にする */
export function acceptanceItems(contract: IssueContract): string[] {
  return contract.acceptanceCriteria
    .split('\n')
    .map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)$/)?.[1]?.trim())
    .filter((item): item is string => Boolean(item));
}
