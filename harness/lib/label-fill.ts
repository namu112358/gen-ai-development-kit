import { claudeMark, hasClaudeMark } from './blocks.ts';
import { PRIORITY_LABELS, type HarnessConfig } from './config.ts';
import { AREA_PREFIX } from './classify.ts';
import type { GitHub, IssueComment } from './github.ts';
import { appRecords } from './state.ts';

/**
 * 付き添いのセッションが、Jev の提案のラベルを付ける（agent.ts label-fill、Issue #538）。
 * 付けてよいのは、App の最新の label-triage の記録の notApplied にある priority:*・area:* だけ。
 * 同じ種類のラベルが Issue に既にあれば付けない。判断は decideLabelFill（純粋な関数）、API の読み書きは fillLabels。
 */

const PRIORITIES: string[] = Object.values(PRIORITY_LABELS);

/** このコマンドのコメントの見出し（Claude の目印と合わせて、書いたコメントを見分ける） */
export const LABEL_FILL_HEADING = '## ラベルを付けました（Jev の提案）';

export interface LabelFillInput {
  labels: string[];
  comments: IssueComment[];
  requested: string[];
  reason: string;
}

export type LabelFillDecision =
  | { kind: 'no-record' }
  | { kind: 'rejected'; errors: string[] }
  | { kind: 'fill'; add: { label: string; choice: string; probability: number; reason: string }[]; skipped: string[]; triageUrl: string };

interface NotApplied {
  label: string;
  choice: string;
  probability: number;
  reason: string;
}

function readNotApplied(record: unknown): NotApplied[] {
  const list = (record as { notApplied?: unknown } | null | undefined)?.notApplied;
  if (!Array.isArray(list)) return [];
  const out: NotApplied[] = [];
  for (const item of list as { label?: unknown; choice?: unknown; probability?: unknown; reason?: unknown }[]) {
    if (typeof item?.label !== 'string' || typeof item.probability !== 'number' || !Number.isFinite(item.probability)) continue;
    out.push({
      label: item.label,
      choice: typeof item.choice === 'string' ? item.choice : item.label,
      probability: item.probability,
      reason: typeof item.reason === 'string' ? item.reason : '',
    });
  }
  return out;
}

export function decideLabelFill(config: HarnessConfig, input: LabelFillInput): LabelFillDecision {
  const triage = appRecords(config, input.comments, 'label-triage').at(-1);
  if (!triage) return { kind: 'no-record' };
  const errors: string[] = [];
  if (input.reason.trim() === '') errors.push('--reason（決めた根拠）が要ります');
  const requested = [...new Set(input.requested)];
  if (requested.length === 0) errors.push('--label が要ります');
  const notApplied = readNotApplied(triage.value);
  const areas = Object.keys(config.classification.areas).map((a) => `${AREA_PREFIX}${a}`);
  const add: { label: string; choice: string; probability: number; reason: string }[] = [];
  const skipped: string[] = [];
  for (const label of requested) {
    const isPriority = PRIORITIES.includes(label);
    const isArea = areas.includes(label);
    if (!isPriority && !isArea) {
      errors.push(`${label} は付けられません（priority:* と、設定の領域の area:* だけ）`);
      continue;
    }
    const entry = notApplied.find((x) => x.label === label);
    if (!entry) {
      errors.push(`${label} は label-triage の記録の notApplied にありません（Jev の提案と違うラベルは付けられません）`);
      continue;
    }
    if (input.labels.includes(label)) {
      skipped.push(label);
      continue;
    }
    const same = input.labels.filter((l) => (isPriority ? PRIORITIES.includes(l) : l.startsWith(AREA_PREFIX)));
    if (same.length > 0) {
      errors.push(`${label} は付けられません（同じ種類のラベルが既にあります: ${same.join(', ')}）`);
      continue;
    }
    if (isPriority && add.some((x) => PRIORITIES.includes(x.label))) {
      errors.push(`${label} は付けられません（優先度を2つ付けることになります）`);
      continue;
    }
    add.push(entry);
  }
  if (errors.length > 0) return { kind: 'rejected', errors };
  return { kind: 'fill', add, skipped, triageUrl: triage.comment.html_url };
}

const pct = (p: number): string => `${Math.round(p * 100)}%`;

export function renderLabelFillComment(d: Extract<LabelFillDecision, { kind: 'fill' }>, reason: string, session: string | null): string {
  const lines = d.add.map((x) => `- \`${x.label}\`：Jev の提案 \`${x.choice}\`（確率 ${pct(x.probability)}）と同じ。Jev が付けなかった理由：${x.reason || '（記録に無し）'}`);
  const kept = d.skipped.map((l) => `- \`${l}\`：既に付いていました`);
  return [claudeMark(session), LABEL_FILL_HEADING, '', ...lines, ...kept, '', `決めた根拠：${reason.trim()}`, '', `[Jev の分類の記録](${d.triageUrl})`].join('\n');
}

export type LabelFillResult =
  | { kind: 'no-record' }
  | { kind: 'rejected'; errors: string[] }
  | { kind: 'filled'; added: string[]; skipped: string[]; comment: string | null };

export async function fillLabels(gh: GitHub, config: HarnessConfig, n: number, requested: string[], reason: string, session: string | null): Promise<LabelFillResult> {
  const issue = await gh.get<{ labels: ({ name: string } | string)[]; pull_request?: unknown }>(`/issues/${n}`);
  if (issue.pull_request) return { kind: 'rejected', errors: [`#${n} は PR です（Issue だけに付けられます）`] };
  const comments = await gh.listComments(n);
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  const d = decideLabelFill(config, { labels, comments, requested, reason });
  if (d.kind !== 'fill') return d;
  const added = d.add.map((x) => x.label);
  if (added.length === 0) {
    // 全部付いている。このコマンドのコメントがまだ無ければ（前回コメントの投稿に失敗したとき）、コメントだけ書く
    const written = comments.some((c) => hasClaudeMark(c.body) && (c.body ?? '').includes(LABEL_FILL_HEADING));
    if (written || d.skipped.length === 0) return { kind: 'filled', added, skipped: d.skipped, comment: null };
  } else {
    await gh.addLabels(n, added);
  }
  try {
    const posted = await gh.comment(n, renderLabelFillComment(d, reason, session));
    return { kind: 'filled', added, skipped: d.skipped, comment: posted.html_url };
  } catch (e) {
    throw new Error(`ラベル ${added.join(', ')} は付きましたが、理由のコメントの投稿に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}
