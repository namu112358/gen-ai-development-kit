/**
 * arch-review（Merge 済みの PR をまとめて読み、Issue をまたぐ設計のずれを直す Issue の下書きを人に示す skill）の決まる部分。
 * 記録（ダッシュボード Issue へのコメントの ```arch-review）の読み書き・採用の書き戻しと集計、対象の PR の割り出し、Issue の下書きの検査（/loop の回の上限を含む）。
 * 記録は Claude の目印付きのコメントで、App の記録（agent-*）ではなく、判定の材料にもしない。
 */
import { claudeMark, claudeMarkSession, extractBlock, hasClaudeMark, renderBlock } from './blocks.ts';
import { appLogin, LABELS, TRUSTED_ASSOCIATIONS, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import { parseIssueBody } from './issue-form.ts';
import { findDashboard } from './state.ts';
import { parseTitle } from './title.ts';

const SHA_RE = /^[0-9a-f]{40}$/;
const isSha = (v: unknown): v is string => typeof v === 'string' && SHA_RE.test(v);

/** 前回の記録が無いか --last のときに見る、Merge 済みの PR の本数の既定 */
export const ARCH_REVIEW_DEFAULT_LAST = 10;

/** /loop の1回に出す下書きの上限（Issue #328） */
export const ARCH_REVIEW_LOOP_MAX_DRAFTS = 3;

/** GitHub のコメントの本文の上限（文字数）。超える記録は投稿・編集しない */
export const ARCH_REVIEW_COMMENT_MAX = 65536;

export interface ArchReviewDraftRecord {
  title: string;
  /** 人が選んで作った Issue の番号（作らなかったものは null） */
  created: number | null;
  /** 下書きの本文（/loop の記録では必須。人が後で選んで作るため） */
  body?: string;
  /** 同じものがある開いた Issue（コメントの案の宛先） */
  duplicateOf?: number;
  /** 人が選んでコメントを投稿した Issue の番号（まだなら null） */
  commented?: number | null;
}

export interface ArchReviewRecord {
  /** 書式の版（今は 1） */
  version: number;
  /** loop：/loop の1回分、manual：人が呼んだ（無ければ manual） */
  trigger?: 'loop' | 'manual';
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
  if (!(v.trigger === undefined || v.trigger === 'loop' || v.trigger === 'manual')) errors.push('trigger は "loop" か "manual"（無ければ manual）');
  const issueNo = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;
  const draftOk = (d: unknown): boolean => {
    const x = d as Record<string, unknown> | null;
    return typeof x === 'object' && x !== null && typeof x.title === 'string' && (x.created === null || issueNo(x.created))
      && (x.body === undefined || typeof x.body === 'string')
      && (x.duplicateOf === undefined || issueNo(x.duplicateOf))
      && (x.commented === undefined || x.commented === null || issueNo(x.commented));
  };
  if (!Array.isArray(v.drafts) || !v.drafts.every(draftOk)) {
    errors.push('drafts は {title, created（Issue 番号か null）, body?, duplicateOf?（Issue 番号）, commented?（Issue 番号か null）} の配列');
  } else if (v.trigger === 'loop') {
    if (v.drafts.length > ARCH_REVIEW_LOOP_MAX_DRAFTS) errors.push(`trigger が loop の記録の drafts は ${ARCH_REVIEW_LOOP_MAX_DRAFTS} 件まで（${v.drafts.length} 件）`);
    if (!v.drafts.every((d: Record<string, unknown>) => typeof d.body === 'string')) errors.push('trigger が loop の記録の drafts には body（下書きの本文）が要る');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, record: v as unknown as ArchReviewRecord };
}

/**
 * ダッシュボード Issue のコメントから前回の記録を選ぶ。
 * コラボレーター（App を除く）が書いた Claude の目印付きで、```arch-review が1つだけあり正しいものの、作成の新しいもの
 */
export function latestArchReviewRecord(comments: IssueComment[], config: HarnessConfig): { comment: IssueComment; record: ArchReviewRecord } | null {
  let latest: { comment: IssueComment; record: ArchReviewRecord } | null = null;
  for (const c of comments) {
    const r = trustedRecord(c, config);
    if (!r.ok) continue;
    if (latest === null || c.created_at >= latest.comment.created_at) latest = { comment: c, record: r.record };
  }
  return latest;
}

/** 採用された下書き（Issue を作ったか、コメントを投稿した） */
const isAdopted = (d: ArchReviewDraftRecord): boolean => d.created !== null || (d.commented ?? null) !== null;

/** 記録のコメント本文（目印・人が読む要約・```arch-review のフェンス）。下書きの本文は JSON の中にだけ持つ */
export function renderArchReviewRecord(record: ArchReviewRecord, session: string | null): string {
  const created = record.drafts.filter((d) => d.created !== null);
  const commented = record.drafts.filter((d) => (d.commented ?? null) !== null);
  const adopted = record.drafts.filter(isAdopted).length;
  const pending = record.drafts.flatMap((d, i) => (isAdopted(d) ? [] : [`${i + 1}. ${d.title}`]));
  return [
    claudeMark(session),
    `arch-review の記録です（${record.baseSha ? `${record.baseSha.slice(0, 7)}..` : ''}${record.headSha.slice(0, 7)}、PR ${record.prs.length} 本${record.trigger === 'loop' ? '、/loop の回' : ''}）。次の arch-review はここから読みます。`,
    `下書き ${record.drafts.length} 件・採用 ${adopted} 件`,
    '',
    '見つけたずれ：',
    ...(record.summary.length > 0 ? record.summary.map((s) => `- ${s}`) : ['- なし']),
    '',
    '作った Issue：',
    ...(created.length > 0 ? created.map((d) => `- #${d.created} ${d.title}`) : ['- なし']),
    ...(commented.length > 0 ? ['', 'コメントした Issue：', ...commented.map((d) => `- #${d.commented} ${d.title}`)] : []),
    ...(pending.length > 0 ? ['', '未採用の下書き（「arch-review の下書きを選ぶ」と頼むと選べます）：', ...pending] : []),
    '',
    renderBlock('arch-review', record),
  ].join('\n');
}

/** 記録のコメント本文の長さの誤り（GitHub のコメントの上限を超える）。誤りが無ければ空 */
export function archReviewBodyErrors(body: string): string[] {
  return body.length > ARCH_REVIEW_COMMENT_MAX
    ? [`記録の本文が ${body.length} 文字で、コメントの上限（${ARCH_REVIEW_COMMENT_MAX} 文字）を超えます。下書きの本文を短くしてください`]
    : [];
}

/** コラボレーター（App を除く）が書いた Claude の目印付きのコメントの記録。当たらなければ誤りの理由 */
function trustedRecord(c: IssueComment, config: HarnessConfig): ArchReviewRecordResult {
  if (c.user?.login === appLogin(config)) return { ok: false, errors: ['App の名義のコメントは arch-review の記録ではありません'] };
  if (!TRUSTED_ASSOCIATIONS.has(c.author_association)) return { ok: false, errors: [`コラボレーター以外（${c.author_association}）のコメントは使いません`] };
  if (!hasClaudeMark(c.body)) return { ok: false, errors: ['Claude の目印の無いコメントは arch-review の記録ではありません'] };
  return parseArchReviewRecord(c.body);
}

export type AdoptResult = { ok: true; record: ArchReviewRecord; body: string } | { ok: false; errors: string[] };

/**
 * 記録のコメントの下書き（1始まりの番号）に、人が選んで作った Issue（opts.comment なら投稿したコメントの宛先）を書き戻した本文を作る。
 * 元のコメントの目印のセッションは残す。コメントの作成日時は変わらないので、前回の位置（latestArchReviewRecord）は動かない
 */
export function adoptArchReviewDraft(comment: IssueComment, index: number, issue: number, opts: { comment?: boolean }, config: HarnessConfig): AdoptResult {
  const r = trustedRecord(comment, config);
  if (!r.ok) return r;
  const drafts = r.record.drafts;
  if (!Number.isInteger(index) || index < 1 || index > drafts.length) return { ok: false, errors: [`下書きの番号は 1〜${drafts.length}（${index}）`] };
  if (!Number.isInteger(issue) || issue < 1) return { ok: false, errors: ['Issue 番号は1以上の整数'] };
  const draft = drafts[index - 1]!;
  if (isAdopted(draft)) return { ok: false, errors: [`${index} 件目は採用済みです（${draft.created !== null ? `#${draft.created} を作成` : `#${draft.commented} にコメント`}）`] };
  if (opts.comment && draft.duplicateOf !== issue) {
    return {
      ok: false,
      errors: [draft.duplicateOf === undefined ? `${index} 件目はコメントの案ではありません（duplicateOf が無い）` : `${index} 件目のコメントの宛先は #${draft.duplicateOf}（#${issue} ではない）`],
    };
  }
  const next: ArchReviewDraftRecord = opts.comment ? { ...draft, commented: issue } : { ...draft, created: issue };
  const record: ArchReviewRecord = { ...r.record, drafts: drafts.map((d, i) => (i === index - 1 ? next : d)) };
  const body = renderArchReviewRecord(record, claudeMarkSession(comment.body));
  const errors = archReviewBodyErrors(body);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, record, body };
}

export interface ArchReviewPendingDraft {
  /** 記録のコメントの ID（arch-review-adopt に渡す） */
  commentId: number;
  /** 記録の中の下書きの番号（1始まり） */
  index: number;
  title: string;
  body?: string;
  duplicateOf?: number;
}

export interface ArchReviewAdoption {
  /** 数えた記録の数 */
  records: number;
  /** 下書きの数 */
  drafts: number;
  /** 採用された下書きの数（Issue を作ったか、コメントを投稿した） */
  adopted: number;
  /** 未採用の下書き（古い記録から順） */
  pending: ArchReviewPendingDraft[];
}

/** ダッシュボード Issue の記録すべてから、下書きの数・採用の数・未採用の下書きを数える（latestArchReviewRecord と同じ条件の記録だけ） */
export function archReviewAdoption(comments: IssueComment[], config: HarnessConfig): ArchReviewAdoption {
  const out: ArchReviewAdoption = { records: 0, drafts: 0, adopted: 0, pending: [] };
  for (const c of [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const r = trustedRecord(c, config);
    if (!r.ok) continue;
    out.records++;
    r.record.drafts.forEach((d, i) => {
      out.drafts++;
      if (isAdopted(d)) {
        out.adopted++;
        return;
      }
      out.pending.push({
        commentId: c.id,
        index: i + 1,
        title: d.title,
        ...(d.body !== undefined ? { body: d.body } : {}),
        ...(d.duplicateOf !== undefined ? { duplicateOf: d.duplicateOf } : {}),
      });
    });
  }
  return out;
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

/** Issue の下書きの配列を検査し、人に示す一覧の Markdown を作る。max を渡すと、件数がそれを超えたら誤り（省けば上限なし） */
export function checkIssueDrafts(value: unknown, max?: number): IssueDraftsResult {
  if (!Array.isArray(value)) return { ok: false, errors: ['下書きは配列'] };
  const errors: string[] = [];
  if (max !== undefined && value.length > max) errors.push(`下書きは ${max} 件まで（${value.length} 件）。直す価値の高い順に絞り、残りは要約にだけ書く`);
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

/** arch-review-range の引数の誤り（--since・--until は40桁の SHA、--last は1以上の整数）。誤りが無ければ空 */
export function archReviewRangeArgErrors(opts: { since?: string; until?: string; last?: string }): string[] {
  const sha = /^[0-9a-f]{40}$/;
  return [
    ...(opts.since !== undefined && !sha.test(opts.since) ? ['--since は40桁の SHA'] : []),
    ...(opts.until !== undefined && !sha.test(opts.until) ? ['--until は40桁の SHA'] : []),
    ...(opts.last !== undefined && !/^[1-9]\d*$/.test(opts.last) ? ['--last は1以上の整数'] : []),
  ];
}
