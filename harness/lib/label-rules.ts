import { LABELS, PRIORITY_LABELS, typeLabel, type HarnessConfig } from './config.ts';
import { isAgentPr, type PullRequest } from './state.ts';
import { parseTitle, TITLE_TYPES } from './title.ts';

/**
 * 必須ラベルの検査（docs/operations.md の「必須ラベルの規則」）。
 *   Issue：type:*・area:*・priority:*
 *   子を持つ Issue（Epic）：epic・area:*・priority:*（type:* は付けない）
 *   PR：type:*・area:*・size:*
 * ダッシュボード（harness/gates/stale.ts）と `agent.ts label-audit` が同じ関数を使う。
 */

export interface LabelAuditItem {
  kind: 'issue' | 'pr';
  title: string;
  labels: string[];
  /** 子（Sub-issues）の数。Issue のみ */
  subIssues?: number;
}

export interface LabelAuditResult {
  /** 足りないラベル（type はタイトルから決まれば `type:feat` のように、決まらなければ `type:*`） */
  missing: string[];
  violations: string[];
}

export interface LabelAuditRow extends LabelAuditResult {
  number: number;
  title: string;
  html_url: string;
}

const PRIORITIES: string[] = Object.values(PRIORITY_LABELS);
const TYPES: string[] = TITLE_TYPES.map(typeLabel);

export function auditLabels(config: HarnessConfig, item: LabelAuditItem): LabelAuditResult {
  const areas = Object.keys(config.classification.areas).map((a) => `area:${a}`);
  const sizes = [...config.classification.sizes.map(([name]) => name), 'XXL'].map((s) => `size:${s}`);
  const types = item.labels.filter((l) => TYPES.includes(l));
  const priorities = item.labels.filter((l) => PRIORITIES.includes(l));
  const hasEpic = item.labels.includes(LABELS.epic);
  const hasChildren = (item.subIssues ?? 0) > 0;
  // epic が付いていれば、子が 0 でも Epic（App が子課題を作る途中）
  const isEpic = item.kind === 'issue' && (hasChildren || hasEpic);
  const title = parseTitle(item.title);

  const missing: string[] = [];
  const violations: string[] = [];
  if (!title.ok) violations.push(`タイトルの形式違い（${title.error}）`);
  if (!isEpic && types.length === 0) missing.push(title.ok ? typeLabel(title.type) : 'type:*');
  if (!item.labels.some((l) => areas.includes(l))) missing.push('area:*');
  if (item.kind === 'issue' && priorities.length === 0) missing.push('priority:*');
  if (item.kind === 'pr' && !item.labels.some((l) => sizes.includes(l))) missing.push('size:*');

  if (priorities.length >= 2) violations.push(`優先度が2つ以上（${priorities.join(', ')}）`);
  if (item.kind === 'issue' && hasChildren && !hasEpic) violations.push(`子課題があるのに \`${LABELS.epic}\` が無い`);
  if (isEpic && types.length > 0) violations.push(`Epic に type:* がある（${types.join(', ')}）`);
  if (!isEpic && title.ok && types.length > 0 && (types.length >= 2 || types[0] !== typeLabel(title.type))) {
    violations.push(`type:* がタイトルと食い違う（タイトルは ${title.type}、ラベルは ${types.join(', ')}）`);
  }
  return { missing, violations };
}

/** 問題のあるものだけを、番号・タイトル・足りないもの・違反の1行にする */
export function renderAuditLines(rows: LabelAuditRow[]): string[] {
  return rows
    .filter((r) => r.missing.length > 0 || r.violations.length > 0)
    .map((r) => {
      const parts = [
        ...(r.missing.length > 0 ? [`不足: ${r.missing.map((m) => `\`${m}\``).join(', ')}`] : []),
        ...(r.violations.length > 0 ? [`違反: ${r.violations.join('、')}`] : []),
      ];
      return `- [#${r.number}](${r.html_url}) ${r.title} — ${parts.join(' ／ ')}`;
    });
}

export interface AuditIssue {
  number: number;
  title: string;
  html_url: string;
  labels: { name: string }[];
  pull_request?: unknown;
  sub_issues_summary?: { total?: number } | null;
}

export const issueRow = (config: HarnessConfig, i: AuditIssue): LabelAuditRow => ({
  number: i.number, title: i.title, html_url: i.html_url,
  ...auditLabels(config, { kind: 'issue', title: i.title, labels: i.labels.map((l) => l.name), subIssues: i.sub_issues_summary?.total ?? 0 }),
});

export const prRow = (config: HarnessConfig, p: Pick<PullRequest, 'number' | 'title' | 'html_url' | 'labels'>): LabelAuditRow => ({
  number: p.number, title: p.title, html_url: p.html_url,
  ...auditLabels(config, { kind: 'pr', title: p.title, labels: p.labels.map((l) => l.name) }),
});

/**
 * ダッシュボードの検査の範囲：開いた Issue のうち agent:* か epic の付いたもの（ダッシュボード自身を除く）と、Agent PR。
 * 人がまだ整えていない Issue や bot の PR はノイズになるので見ない。/issues に混ざる PR は Issue の規則で見ない。
 */
export function labelAuditRows(config: HarnessConfig, repository: string, issues: AuditIssue[], prs: PullRequest[]): LabelAuditRow[] {
  const inScope = (i: AuditIssue) => !i.pull_request && i.title !== config.dashboardIssueTitle
    && i.labels.some((l) => l.name.startsWith('agent:') || l.name === LABELS.epic);
  return [
    ...issues.filter(inScope).map((i) => issueRow(config, i)),
    ...prs.filter((p) => isAgentPr(config, p, repository)).map((p) => prRow(config, p)),
  ];
}
