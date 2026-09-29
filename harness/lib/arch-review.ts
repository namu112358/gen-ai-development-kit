/**
 * arch-review（Merge 済みの PR をまとめて読み、Issue をまたぐ設計のずれを直す Issue の下書きを人に示す skill）の決まる部分。
 * 記録（ダッシュボード Issue へのコメントの ```arch-review）の読み書き、対象の PR の割り出し、Issue の下書きの検査。
 * 記録は Claude の目印付きのコメントで、App の記録（agent-*）ではなく、判定の材料にもしない。
 */
import { claudeMark, extractBlock, hasClaudeMark, renderBlock } from './blocks.ts';
import { appLogin, LABELS, TRUSTED_ASSOCIATIONS, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import { parseIssueBody } from './issue-form.ts';
import { findDashboard } from './state.ts';
import { parseTitle } from './title.ts';

const SHA_RE = /^[0-9a-f]{40}$/;
const isSha = (v: unknown): v is string => typeof v === 'string' && SHA_RE.test(v);

/** 前回の記録が無いか --last のときに見る、Merge 済みの PR の本数の既定 */
export const ARCH_REVIEW_DEFAULT_LAST = 10;

export interface ArchReviewDraftRecord {
  title: string;
  /** 人が選んで作った Issue の番号（作らなかったものは null） */
  created: number | null;
}

export interface ArchReviewRecord {
  /** 書式の版（今は 1） */
  version: number;
  /** 前回の headSha（無ければ null） */
  baseSha: string | null;
  /** 今回見た既定ブランチの SHA */
  headSha: string;
  prs: number[];
  summary: string[];
  drafts: ArchReviewDraftRecord[];
}

export type ArchReviewRecordResult = { ok: true; record: ArchReviewRecord } | { ok: false; errors: string[] };

/** 本文の ```arch-review の JSON を読んで検査する */
export function parseArchReviewRecord(body: string | null | undefined): ArchReviewRecordResult {
  const block = extractBlock(body, 'arch-review');
  if (!block.found) return { ok: false, errors: ['arch-review ブロックがありません'] };
  if (!block.ok) return { ok: false, errors: [block.error] };
  return checkArchReviewRecord(block.value);
}

/** 記録の JSON の形を検査する（arch-review-record に渡すファイルにも使う） */
export function checkArchReviewRecord(value: unknown): ArchReviewRecordResult {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, errors: ['記録は JSON のオブジェクト'] };
  const errors: string[] = [];
  if (v.version !== 1) errors.push('version は 1');
  if (!isSha(v.headSha)) errors.push('headSha は40桁の SHA');
  if (!(v.baseSha === null || isSha(v.baseSha))) errors.push('baseSha は40桁の SHA か null');
  if (!Array.isArray(v.prs) || !v.prs.every((n) => Number.isInteger(n) && n > 0)) errors.push('prs は PR 番号の配列');
  if (!Array.isArray(v.summary) || !v.summary.every((s) => typeof s === 'string')) errors.push('summary は文字列の配列');
  const draftOk = (d: unknown): boolean => {
    const x = d as Record<string, unknown> | null;
    return typeof x === 'object' && x !== null && typeof x.title === 'string' && (x.created === null || (Number.isInteger(x.created) && (x.created as number) > 0));
  };
  if (!Array.isArray(v.drafts) || !v.drafts.every(draftOk)) errors.push('drafts は {title, created（Issue 番号か null）} の配列');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, record: v as unknown as ArchReviewRecord };
}

/**
 * ダッシュボード Issue のコメントから前回の記録を選ぶ。
 * コラボレーター（App を除く）が書いた Claude の目印付きで、```arch-review が1つだけあり正しいものの、作成の新しいもの
 */
export function latestArchReviewRecord(comments: IssueComment[], config: HarnessConfig): { comment: IssueComment; record: ArchReviewRecord } | null {
  const app = appLogin(config);
  let latest: { comment: IssueComment; record: ArchReviewRecord } | null = null;
  for (const c of comments) {
    if (c.user?.login === app || !TRUSTED_ASSOCIATIONS.has(c.author_association) || !hasClaudeMark(c.body)) continue;
    const r = parseArchReviewRecord(c.body);
    if (!r.ok) continue;
    if (latest === null || c.created_at >= latest.comment.created_at) latest = { comment: c, record: r.record };
  }
  return latest;
}

/** 記録のコメント本文（目印・人が読む要約・```arch-review のフェンス） */
export function renderArchReviewRecord(record: ArchReviewRecord, session: string | null): string {
  const created = record.drafts.filter((d) => d.created !== null);
  return [
    claudeMark(session),
    `arch-review の記録です（${record.baseSha ? `${record.baseSha.slice(0, 7)}..` : ''}${record.headSha.slice(0, 7)}、PR ${record.prs.length} 本）。次の arch-review はここから読みます。`,
    '',
    '見つけたずれ：',
    ...(record.summary.length > 0 ? record.summary.map((s) => `- ${s}`) : ['- なし']),
    '',
    '作った Issue：',
    ...(created.length > 0 ? created.map((d) => `- #${d.created} ${d.title}`) : ['- なし']),
    '',
    renderBlock('arch-review', record),
  ].join('\n');
}

export interface ArchReviewPr {
  number: number;
  title: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
}

export interface ArchReviewRange {
  /** since：--since から、previous：前回の記録から、last：Merge 済みの直近 N 本 */
  source: 'since' | 'previous' | 'last';
  previous: ArchReviewRecord | null;
  baseSha: string | null;
  headSha: string;
  /** since・previous は compare のコミットの順（古い順）、last は Merge の新しい順 */
  prs: ArchReviewPr[];
  /** compare の上限（250 件）に当たり、範囲の全部を読めていない */
  truncated: boolean;
  note?: string;
}

export interface ArchReviewRangeOptions {
  since?: string;
  until?: string;
  last?: number;
}

interface PullLike {
  number: number;
  title: string;
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  base?: { ref?: string };
}

const toPr = (p: PullLike): ArchReviewPr => ({ number: p.number, title: p.title, mergeCommitSha: p.merge_commit_sha ?? null, mergedAt: p.merged_at ?? null });

/** 対象の Merge 済みの PR を割り出す（読むだけ） */
export async function archReviewRange(gh: GitHub, config: HarnessConfig, opts: ArchReviewRangeOptions = {}): Promise<ArchReviewRange> {
  const dashboard = await findDashboard(gh, config);
  const previous = dashboard ? (latestArchReviewRecord(await gh.listComments(dashboard.number), config)?.record ?? null) : null;
  const note = dashboard ? undefined : `ダッシュボード Issue（${config.dashboardIssueTitle}）が無いため、前回の記録は無いものとして扱いました`;
  const headSha = opts.until ?? (await gh.get<{ commit: { sha: string } }>(`/branches/${encodeURIComponent(config.defaultBranch)}`)).commit.sha;
  const base = opts.last !== undefined ? null : (opts.since ?? previous?.headSha ?? null);

  if (base === null) {
    const n = opts.last ?? ARCH_REVIEW_DEFAULT_LAST;
    const closed = await gh.paginate<PullLike>(`/pulls?state=closed&base=${encodeURIComponent(config.defaultBranch)}&sort=updated&direction=desc`, 3);
    const prs = closed
      .filter((p) => Boolean(p.merged_at) && p.base?.ref === config.defaultBranch)
      .sort((a, b) => b.merged_at!.localeCompare(a.merged_at!))
      .slice(0, n)
      .map(toPr);
    return { source: 'last', previous, baseSha: null, headSha, prs, truncated: false, ...(note ? { note } : {}) };
  }

  const cmp = await gh.get<{ total_commits: number; commits: { sha: string; commit: { message: string } }[] }>(`/compare/${base}...${headSha}`);
  const prs: ArchReviewPr[] = [];
  const seen = new Set<number>();
  for (const c of cmp.commits) {
    // squash の件名の末尾の (#番号)。無ければコミットから PR を探す（PR の無い直接の push は飛ばす）
    const num = c.commit.message.split('\n')[0]!.match(/\(#(\d+)\)\s*$/)?.[1];
    const pr = num
      ? await gh.get<PullLike>(`/pulls/${num}`)
      : (await gh.get<PullLike[]>(`/commits/${c.sha}/pulls`)).find((p) => Boolean(p.merged_at));
    if (!pr || !pr.merged_at || seen.has(pr.number)) continue;
    seen.add(pr.number);
    prs.push(toPr(pr));
  }
  return {
    source: opts.since ? 'since' : 'previous',
    previous, baseSha: base, headSha, prs,
    truncated: cmp.total_commits > cmp.commits.length,
    ...(note ? { note } : {}),
  };
}

export interface IssueDraft {
  title: string;
  body: string;
  /** 同じものがある開いた Issue（あれば新しく立てず、その Issue へのコメントの案にする） */
  duplicateOf?: number;
  labels?: string[];
}

export type IssueDraftsResult = { ok: true; drafts: IssueDraft[]; markdown: string } | { ok: false; errors: string[] };

/** Issue の下書きの配列を検査し、人に示す一覧の Markdown を作る */
export function checkIssueDrafts(value: unknown): IssueDraftsResult {
  if (!Array.isArray(value)) return { ok: false, errors: ['下書きは配列'] };
  const errors: string[] = [];
  value.forEach((d: unknown, i) => {
    const at = `${i + 1}件目`;
    const x = d as Record<string, unknown> | null;
    if (typeof x !== 'object' || x === null || typeof x.title !== 'string' || typeof x.body !== 'string') {
      errors.push(`${at}：title と body は文字列`);
      return;
    }
    const title = parseTitle(x.title);
    if (!title.ok) errors.push(`${at}：${title.error}`);
    const body = parseIssueBody(x.body);
    if (!body.ok) errors.push(...body.errors.map((e) => `${at}：${e}`));
    if (x.duplicateOf !== undefined && !(Number.isInteger(x.duplicateOf) && (x.duplicateOf as number) > 0)) errors.push(`${at}：duplicateOf は Issue 番号`);
    if (x.labels !== undefined && !(Array.isArray(x.labels) && x.labels.every((l) => typeof l === 'string'))) errors.push(`${at}：labels は文字列の配列`);
    else if (Array.isArray(x.labels) && x.labels.includes(LABELS.ready)) errors.push(`${at}：${LABELS.ready} は付けない（着手の許可は人が出す）`);
  });
  if (errors.length > 0) return { ok: false, errors };
  const drafts = value as IssueDraft[];
  const markdown = drafts
    .map((d, i) => `${i + 1}. ${d.title}${d.duplicateOf ? `（開いた #${d.duplicateOf} と同じ。新しく立てずコメントの案にする）` : ''}`)
    .join('\n');
  return { ok: true, drafts, markdown };
}
