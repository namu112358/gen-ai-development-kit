import { claudeMark, extractBlock, hasClaudeMark, renderBlock } from './blocks.ts';
import { CHECKS, type HarnessConfig } from './config.ts';
import type { IssueComment } from './github.ts';
import { parseIssueBody } from './issue-form.ts';
import type { Parsed } from './plan.ts';
import { appRecords, isAppComment, isTrustedComment, latestPlanGate } from './state.ts';
import { parseVerdict, RISK_QUESTIONS, type BlockingFinding } from './verdict.ts';

/**
 * 有人セッションで判定（Reviewer）・批評（plan-critic）に渡す入力と、判定コメントの組み立て。
 * API から読んだそのままの配列を受け取り、選別もここで行う（API 呼び出しは agent.ts）。
 */

export interface CheckRun {
  id: number;
  name: string;
  /** queued / in_progress / completed。無ければ conclusion の有無で完了を判断する */
  status?: string;
  conclusion: string | null;
  app: { slug: string } | null;
  output?: { title?: string | null; summary?: string | null };
}

/** Epic の子課題の Issue の親（本文の子課題の目印から） */
export interface ParentEpic {
  number: number;
  title: string;
  body: string | null;
  /** 子課題の番号とタイトル */
  children: { number: number; title: string }[];
  /** 子課題の一覧の出どころ。record は App の epic-split の記録、sub-issues は Sub-issues の API（App 以外も登録できる） */
  childrenSource: 'record' | 'sub-issues';
}

/** PR のコミット（API の /pulls/{n}/commits の古い順） */
export interface PrCommit {
  sha: string;
  parents: { sha: string }[];
}

/** 過去の PR のレビュー（API の /pulls/{n}/reviews の形） */
export interface PastPrReview {
  id: number;
  body: string | null;
  state: string;
  submitted_at: string | null;
  html_url: string;
  author_association: string;
  user: IssueComment['user'];
}

/** 過去の PR のレビューコメント（API の /pulls/{n}/comments の形） */
export interface PastPrReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  original_line?: number | null;
  created_at: string;
  html_url: string;
  author_association: string;
  user: IssueComment['user'];
}

/** 変更ファイルの履歴から集めた過去の PR の候補。files はこの PR の変更ファイルのうち、その PR が触ったもの */
export interface PastPrCandidate {
  number: number;
  title: string;
  mergedAt: string;
  baseRefName: string;
  merged: boolean;
  files: string[];
}

/** 過去の PR とそのコメント・レビュー・レビューコメント（API から読んだそのまま） */
export interface PastPr {
  number: number;
  title: string;
  mergedAt: string;
  files: string[];
  comments: IssueComment[];
  reviews: PastPrReview[];
  reviewComments: PastPrReviewComment[];
}

/** changedFiles は PR の変更ファイルの総数、filesConsidered は履歴を調べた数 */
export interface PastPrs {
  changedFiles: number;
  filesConsidered: number;
  prs: PastPr[];
}

/** PR の状態（段階0の材料） */
export interface PrState {
  state: string;
  draft: boolean;
  merged?: boolean;
}

export const PAST_PR_FILE_LIMIT = 30;
export const PAST_PR_LIMIT = 10;
export const PAST_PR_ITEM_CHARS = 1500;
export const PAST_PR_SECTION_CHARS = 20000;

export interface JudgeFacts {
  pr: { number: number; headSha: string; body: string | null };
  /** PR が Closes する Issue。comments は Issue のコメント（App の計画ゲートの記録を含む）。epic は Epic の子課題なら親 */
  issues: { number: number; title: string; body: string | null; comments: IssueComment[]; epic?: ParentEpic }[];
  prComments: IssueComment[];
  /** head の check run */
  checkRuns: CheckRun[];
  /** PR のコミット（再レビューの範囲の判断に使う。無ければ判断しない） */
  commits?: PrCommit[];
  /** PR の状態（無ければ「(集めていません)」） */
  prState?: PrState;
  /** 変更ファイルを触った Merge 済みの過去の PR（無ければ「(集めていません)」） */
  pastPrs?: PastPrs;
}

/** コラボレーターのコメント（着手宣言を除く） */
export function collaboratorComments(comments: IssueComment[]): IssueComment[] {
  return comments.filter((c) => isTrustedComment(c) && !extractBlock(c.body, 'agent-claim').found);
}

function renderComments(comments: IssueComment[], transform: (body: string) => string = (b) => b): string[] {
  const list = collaboratorComments(comments);
  if (list.length === 0) return ['(なし)'];
  return list.flatMap((c) => [`--- ${c.user?.login ?? '?'} ${c.created_at}`, transform(c.body).trim()]);
}

const PLAN_FENCE = /^(`{3,})[ \t]*agent-plan[ \t]*\n[\s\S]*?\n\1[ \t]*$/gm;

/** Claude の計画コメントから agent-plan ブロックだけを省く（計画ゲートの記録と重複するため。説明文は残す） */
export function stripPlanBlock(body: string): string {
  if (!hasClaudeMark(body)) return body;
  return body.replace(/\r\n/g, '\n').replace(PLAN_FENCE, '(agent-plan ブロックは省略。計画ゲートの記録の計画を参照)');
}

/** PR のコメントのうち判定に渡すもの：コラボレーターのコメント（着手宣言を除く）から、判定コメント・合体版の記録と App のコメントを除く */
export function prCommentsForJudge(config: HarnessConfig, comments: IssueComment[]): IssueComment[] {
  return collaboratorComments(comments).filter(
    (c) => !isAppComment(config, c) && !extractBlock(c.body, 'agent-verdict').found && !extractBlock(c.body, 'agent-review-panel').found,
  );
}

export interface PreviousVerdict {
  /** 最新の正しい判定（無ければ null） */
  verdict: { headSha: string; blocking: BlockingFinding[] } | null;
  /** それより新しい、ブロックが壊れた判定コメントの URL */
  broken: string[];
}

/** 最新の信頼できる Claude の判定コメントの head とブロッキング指摘。ブロックが壊れたコメントは飛ばして前の正しい判定を探す */
export function previousVerdict(comments: IssueComment[]): PreviousVerdict {
  const broken: string[] = [];
  for (const c of [...comments].reverse()) {
    if (!isTrustedComment(c) || !hasClaudeMark(c.body)) continue;
    const b = extractBlock(c.body, 'agent-verdict');
    if (!b.found) continue;
    if (!b.ok) {
      broken.push(c.html_url);
      continue;
    }
    const v = b.value as { headSha?: unknown; review?: { blocking?: unknown } };
    return { verdict: { headSha: String(v.headSha ?? ''), blocking: Array.isArray(v.review?.blocking) ? (v.review.blocking as BlockingFinding[]) : [] }, broken };
  }
  return { verdict: null, broken };
}

/** 親 Epic の子課題の番号（App の epic-split の最新の記録から。記録が無ければ null） */
export function epicChildrenFromRecords(config: HarnessConfig, parentComments: IssueComment[]): number[] | null {
  const record = appRecords<{ children?: unknown }>(config, parentComments, 'epic-split').at(-1);
  if (!record || !Array.isArray(record.value.children)) return null;
  return record.value.children.filter((n): n is number => Number.isInteger(n));
}

function renderEpic(childNumber: number, epic: ParentEpic): string[] {
  const form = parseIssueBody(epic.body);
  const validation = form.ok ? form.contract.validation.trim() : '';
  const source = epic.childrenSource === 'record'
    ? '子課題（App の epic-split の記録）:'
    : '子課題（App の epic-split の記録が無いため Sub-issues の一覧。Sub-issues は App 以外も登録できる）:';
  return [
    '', `=== 親 Epic #${epic.number}（Issue #${childNumber} の親）`, epic.title,
    '', source, ...(epic.children.length > 0 ? epic.children.map((c) => `- #${c.number} ${c.title}`) : ['(なし)']),
    '', 'Validation Requirements:', validation || '(親の本文から読めません)',
  ];
}

/** agent/scope の結果：App の同じ名前の check run のうち id が最新のものを正とし、無い・未完了・結論を書き分ける */
export function describeScope(config: HarnessConfig, checkRuns: CheckRun[]): string {
  const scope = checkRuns.filter((c) => c.name === CHECKS.scope && c.app?.slug === config.appSlug).sort((a, b) => a.id - b.id).at(-1);
  if (!scope) return '(この head の結果がありません)：この head に check run がありません';
  const completed = scope.status === undefined ? scope.conclusion !== null : scope.status === 'completed';
  if (!completed) return `(この head の結果がありません)：check run はあるが未完了です（status: ${scope.status ?? '?'}）`;
  return [`結論: ${scope.conclusion ?? '(なし)'}`, scope.output?.title ?? '', (scope.output?.summary ?? '').trim()].join('\n');
}

export type MergeSince =
  | { kind: 'unknown'; reason: string }
  | { kind: 'none' }
  | { kind: 'merged'; merges: string[] };

/** 前回の head より後のコミットに、main の取り込み（親が2つ以上のコミット）があるか */
export function mergesSince(commits: PrCommit[], previousHead: string): MergeSince {
  const i = commits.findIndex((c) => c.sha === previousHead);
  if (i < 0) return { kind: 'unknown', reason: '前回の head が PR のコミット一覧にありません（履歴が書き換えられたか、一覧が上限を超えた）' };
  const merges = commits.slice(i + 1).filter((c) => c.parents.length > 1).map((c) => c.sha);
  return merges.length > 0 ? { kind: 'merged', merges } : { kind: 'none' };
}

function renderRange(commits: PrCommit[] | undefined, previousHead: string): string {
  if (!commits) return '(PR のコミット一覧がありません)';
  const m = mergesSince(commits, previousHead);
  if (m.kind === 'unknown') return `判断できません：${m.reason}`;
  if (m.kind === 'none') return '前回の head の後に main の取り込みはありません。';
  return [
    `前回の head の後に main の取り込みがあります（${m.merges.join(', ')}）。`,
    `\`git diff ${previousHead}...<headSha>\` には main から来た変更も入る。PR 自身の変更は、それぞれの head で \`git diff origin/main...<head>\` を取って比べると分かる。`,
  ].join('\n');
}

type HistoryPr = { number: number; title: string; merged: boolean; mergedAt: string | null; baseRefName: string };

/**
 * ファイルごとの履歴の PR から、既定のブランチへ Merge 済みの PR（この PR を除く）を番号でまとめ、
 * Merge の新しい順（同じなら番号の大きい順）に limit 件を返す。files は触ったファイルの和集合（入力の順）
 */
export function selectPastPrs(histories: { path: string; prs: HistoryPr[] }[], self: number, defaultBranch: string, limit = PAST_PR_LIMIT): PastPrCandidate[] {
  const byNumber = new Map<number, PastPrCandidate>();
  for (const h of histories) {
    for (const p of h.prs) {
      if (!p.merged || !p.mergedAt || p.baseRefName !== defaultBranch || p.number === self) continue;
      const found = byNumber.get(p.number);
      if (!found) byNumber.set(p.number, { number: p.number, title: p.title, mergedAt: p.mergedAt, baseRefName: p.baseRefName, merged: true, files: [h.path] });
      else if (!found.files.includes(h.path)) found.files.push(h.path);
    }
  }
  return [...byNumber.values()]
    .sort((a, b) => (a.mergedAt === b.mergedAt ? b.number - a.number : a.mergedAt < b.mergedAt ? 1 : -1))
    .slice(0, limit);
}

export interface PastPrItem {
  at: string;
  heading: string;
  body: string;
}

/**
 * 過去の PR のうち判定に渡すもの：コラボレーターの、App でも Claude の目印でもない、本文が空白だけでないコメント・レビュー・レビューコメント。
 * 過去の判定の指摘と App の変更要求はその PR の AC に対するもので、人が残した指摘に当たらないため外す。時刻順
 */
export function pastPrItemsForJudge(config: HarnessConfig, pr: PastPr): PastPrItem[] {
  const keep = (c: { body: string | null; author_association: string; user: IssueComment['user'] }): boolean =>
    isTrustedComment(c) && !isAppComment(config, c) && !hasClaudeMark(c.body ?? '') && (c.body ?? '').trim() !== '';
  const login = (c: { user: IssueComment['user'] }): string => c.user?.login ?? '?';
  const items: PastPrItem[] = [
    ...pr.comments.filter(keep).map((c) => ({ at: c.created_at, heading: `- コメント ${login(c)} ${c.created_at}`, body: c.body })),
    ...pr.reviews.filter(keep).map((r) => ({ at: r.submitted_at ?? '', heading: `- レビュー ${login(r)} ${r.state} ${r.submitted_at ?? '?'}`, body: r.body ?? '' })),
    ...pr.reviewComments.filter(keep).map((c) => ({
      at: c.created_at,
      heading: `- レビューコメント ${login(c)} ${c.path}:${c.line ?? c.original_line ?? '?'} ${c.created_at}`,
      body: c.body,
    })),
  ];
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function clip(body: string): string {
  const text = body.trim();
  if (text.length <= PAST_PR_ITEM_CHARS) return text;
  return `${text.slice(0, PAST_PR_ITEM_CHARS)}\n…（${PAST_PR_ITEM_CHARS} 字で切りました。元は ${text.length} 字）`;
}

/** 過去の PR のコメントの節。1件 1500 字、節全体 20000 字で切る（超える PR は古いものから PR 単位で省く） */
export function renderPastPrs(config: HarnessConfig, pastPrs: PastPrs | undefined): string[] {
  if (!pastPrs) return ['(集めていません)'];
  const header = `調べた変更ファイル: ${pastPrs.filesConsidered} / ${pastPrs.changedFiles}${pastPrs.filesConsidered < pastPrs.changedFiles ? `（先頭 ${PAST_PR_FILE_LIMIT} 件だけ調べました）` : ''}`;
  if (pastPrs.prs.length === 0) return [header, '(なし)'];
  const out = [header];
  let size = header.length;
  const omitted: number[] = [];
  for (const pr of pastPrs.prs) {
    if (omitted.length > 0) {
      omitted.push(pr.number);
      continue;
    }
    const items = pastPrItemsForJudge(config, pr);
    const lines = [
      `--- PR #${pr.number} ${pr.title}（Merge ${pr.mergedAt}）`,
      `触ったファイル（この PR の変更ファイルと重なるもの）: ${pr.files.join(', ')}`,
      ...(items.length > 0 ? items.flatMap((i) => [i.heading, clip(i.body)]) : ['(コラボレーターのコメントなし)']),
    ];
    // 行を \n でつなぐので、1行ごとに1字（改行）を足して数える
    const added = lines.reduce((n, l) => n + l.length + 1, 0);
    if (size + added > PAST_PR_SECTION_CHARS) {
      omitted.push(pr.number);
      continue;
    }
    out.push(...lines);
    size += added;
  }
  if (omitted.length > 0) out.push(`（節全体が ${PAST_PR_SECTION_CHARS} 字を超えるため、${omitted.map((n) => `PR #${n}`).join(', ')} を省きました）`);
  return out;
}

/** PR の状態の1行（段階0の材料） */
export function renderPrState(state: PrState | undefined): string {
  if (!state) return '(集めていません)';
  return `state: ${state.state} / draft: ${state.draft} / merged: ${state.merged ?? false}`;
}

/** 判定入力の先頭行 `headSha: <sha>` から判定する head を読む */
export function judgedHeadOf(text: string): string | null {
  return text.match(/^headSha: ([0-9a-f]{40})$/m)?.[1] ?? null;
}

export function renderJudgeInput(config: HarnessConfig, facts: JudgeFacts): string {
  const out = [`headSha: ${facts.pr.headSha}`, `PR #${facts.pr.number} issues=${facts.issues.map((i) => `#${i.number}`).join(',') || '(なし)'}`];
  for (const issue of facts.issues) {
    out.push('', `=== Issue #${issue.number}`, issue.title, '', (issue.body ?? '').trim());
    if (issue.epic) out.push(...renderEpic(issue.number, issue.epic));
    out.push('', `=== Issue #${issue.number} のコラボレーターのコメント`, ...renderComments(issue.comments, stripPlanBlock));
    const gate = latestPlanGate(config, issue.comments);
    const { pass, reasons, plan } = (gate?.value ?? {}) as { pass?: boolean; reasons?: string[]; plan?: unknown };
    out.push('', `=== 計画ゲートの記録の計画 (#${issue.number})`);
    out.push(gate ? JSON.stringify({ pass, reasons, plan: plan ?? null }, null, 2) : '(計画ゲートの記録がありません)');
  }
  out.push('', '=== PR 本文', (facts.pr.body ?? '').trim());
  const prComments = prCommentsForJudge(config, facts.prComments);
  out.push('', '=== PR のコメント（コラボレーター。判定コメントを除く）');
  out.push(...(prComments.length > 0 ? prComments.flatMap((c) => [`--- ${c.user?.login ?? '?'} ${c.created_at}`, c.body.trim()]) : ['(なし)']));
  out.push('', '=== PR の状態（参考。合体版の段階0の材料）', renderPrState(facts.prState));
  out.push('', '=== 過去の PR のコメント（参考。合体版の④の材料。変更ファイルを触った Merge 済みの PR のコラボレーターのコメント。App・Claude の目印のものを除く）');
  out.push(...renderPastPrs(config, facts.pastPrs));
  out.push('', `=== 範囲照合（${CHECKS.scope}）`, describeScope(config, facts.checkRuns));
  const { verdict: prev, broken } = previousVerdict(facts.prComments);
  out.push('', '=== 前回の判定');
  out.push(prev ? [`headSha: ${prev.headSha}`, 'blocking:', JSON.stringify(prev.blocking, null, 2)].join('\n') : '(なし)');
  if (broken.length > 0) out.push(`(注) これより新しい判定コメントのブロックが壊れていたため飛ばしました：${broken.join(', ')}`);
  if (prev) out.push('', '=== 再レビューの範囲（補足）', renderRange(facts.commits, prev.headSha));
  return `${out.join('\n')}\n`;
}

/** 判定入力の2行目 `PR #<n> ...` から PR 番号を読む */
export function judgedPrOf(text: string): number | null {
  const m = text.split('\n')[1]?.match(/^PR #(\d+)(?:\s|$)/);
  return m ? Number(m[1]) : null;
}

/** judge-input のファイルを読み、引数の PR と照らして判定する head を返す */
export function checkJudgeInput(text: string, pr: number): Parsed<string> {
  const head = judgedHeadOf(text);
  if (!head) return { ok: false, errors: ['judge-input のファイルに headSha の行がありません'] };
  const filePr = judgedPrOf(text);
  if (filePr === null) return { ok: false, errors: ['judge-input のファイルに PR の行がありません'] };
  if (filePr !== pr) return { ok: false, errors: [`judge-input のファイルは PR #${filePr} のものです（引数は #${pr}）`] };
  return { ok: true, value: head };
}

/** 位置引数と、値を取るオプション（`--name <value>`）を位置に関わらず分ける。未知のオプションと値の欠けは拒否する */
export function splitArgs(args: string[], valueOptions: string[]): Parsed<{ positional: string[]; options: Record<string, string> }> {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const errors: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    if (!valueOptions.includes(a)) {
      errors.push(`${a}: 未知のオプションです`);
      continue;
    }
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      errors.push(`${a}: 値がありません`);
      continue;
    }
    if (a in options) errors.push(`${a}: 2回指定されています`);
    options[a] = v;
    i++;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { positional, options } };
}

export interface ComposeArgs {
  pr: number;
  reviewerFile: string;
  riskFile: string;
  judgeInput: string;
  model?: string;
}

const COMPOSE_USAGE = 'compose-verdict <pr> <reviewer.json> <risk.json> --judge-input <file> [--model <m>]';

/** compose-verdict の引数を読む（--judge-input・--model の位置に関わらず） */
export function parseComposeArgs(args: string[]): Parsed<ComposeArgs> {
  const r = splitArgs(args, ['--judge-input', '--model']);
  if (!r.ok) return { ok: false, errors: [...r.errors, COMPOSE_USAGE] };
  const { positional, options } = r.value;
  const [pr, reviewerFile, riskFile] = positional;
  const judgeInput = options['--judge-input'];
  if (positional.length !== 3 || !pr || !reviewerFile || !riskFile || !judgeInput) return { ok: false, errors: [COMPOSE_USAGE] };
  if (!/^\d+$/.test(pr)) return { ok: false, errors: [`PR 番号「${pr}」が数ではありません`, COMPOSE_USAGE] };
  return { ok: true, value: { pr: Number(pr), reviewerFile, riskFile, judgeInput, ...(options['--model'] ? { model: options['--model'] } : {}) } };
}

export interface PreviousCritique {
  verdict: string | null;
  /** 必須（severity: must）の fixes の text */
  must: string[];
}

/** 前回の plan-critic の出力（JSON）から必須の fixes を取り出す。読めなければエラー */
export function parsePreviousCritique(text: string): Parsed<PreviousCritique> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`前回の批評を JSON として読めません: ${(e as Error).message}`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['前回の批評: オブジェクトではありません'] };
  const { verdict, fixes } = raw as { verdict?: unknown; fixes?: unknown };
  if (!Array.isArray(fixes)) return { ok: false, errors: ['前回の批評: fixes が配列ではありません'] };
  const errors: string[] = [];
  const must: string[] = [];
  fixes.forEach((f, i) => {
    const { severity, text: t } = (typeof f === 'object' && f !== null ? f : {}) as { severity?: unknown; text?: unknown };
    if ((severity !== 'must' && severity !== 'should') || typeof t !== 'string') {
      errors.push(`前回の批評: fixes[${i}] は {severity: "must" | "should", text} ではありません`);
      return;
    }
    if (severity === 'must') must.push(t);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { verdict: typeof verdict === 'string' ? verdict : null, must } };
}

export function renderCriticInput(issue: { number: number; title: string; body: string | null }, comments: IssueComment[], planText: string, previous?: PreviousCritique): string {
  const prev = previous
    ? ['', '=== 前回の批評', `verdict: ${previous.verdict ?? '(不明)'}`, ...(previous.must.length > 0 ? previous.must.map((m) => `- [must] ${m}`) : ['必須の指摘なし'])]
    : [];
  return [
    `=== Issue #${issue.number}`, issue.title, '', (issue.body ?? '').trim(),
    '', '=== コラボレーターのコメント', ...renderComments(comments),
    ...prev,
    '', '=== 計画', planText.trim(),
  ].join('\n') + '\n';
}

const REVIEWER_KEYS = { required: ['pass', 'blocking'], optional: ['nonBlocking', 'humanNotes'] };
const RISK_KEYS = { required: ['level', 'answers', 'rationale', 'facts'], optional: ['probabilities'] };
const BLOCKING_KEYS = { required: ['kind', 'detail'], optional: ['file'] };
const HUMAN_NOTES_KEYS = { required: [], optional: ['concerns', 'checkPoints'] };

/** キーの照合。未知のキー（綴りの誤り）と必須のキーの欠けを拒否する */
function checkKeys(raw: unknown, name: string, keys: { required: string[]; optional: string[] }): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [`${name}: オブジェクトではありません`];
  const known = new Set([...keys.required, ...keys.optional]);
  return [
    ...Object.keys(raw).filter((k) => !known.has(k)).map((k) => `${name}.${k}: 未知のキーです`),
    ...keys.required.filter((k) => !(k in raw)).map((k) => `${name}.${k}: 必須のキーがありません`),
  ];
}

export interface ComposeInput {
  /** 目印に入れるセッション ID（省略時は null） */
  session?: string | null;
  pr: number;
  /** 判定した head（判定入力の headSha） */
  judgedHead: string;
  /** 投稿直前に読んだ PR の head */
  currentHead: string;
  reviewer: unknown;
  risk: unknown;
  /** judgedBy は判定者の説明（「付き添いのセッション」やセッションの URL など） */
  meta: { model?: string; judgedBy: string };
}

/** Reviewer と Risk Agent の出力から判定コメントを作り、書式を検査する */
/** session は目印に入れるセッション ID（agent.ts が環境から渡す。既定は null で ID の無い目印） */
export function composeVerdict(input: ComposeInput, session: string | null = input.session ?? null): Parsed<string> {
  if (input.judgedHead !== input.currentHead) {
    return { ok: false, errors: [`判定した head（${input.judgedHead}）と現在の head（${input.currentHead}）が違う。判定し直す`] };
  }
  const keyErrors = [...checkKeys(input.reviewer, 'reviewer', REVIEWER_KEYS), ...checkKeys(input.risk, 'risk', RISK_KEYS)];
  if (keyErrors.length === 0) {
    const { blocking, humanNotes } = input.reviewer as { blocking: unknown; humanNotes?: unknown };
    if (Array.isArray(blocking)) blocking.forEach((b, i) => keyErrors.push(...checkKeys(b, `reviewer.blocking[${i}]`, BLOCKING_KEYS)));
    if (humanNotes !== undefined) keyErrors.push(...checkKeys(humanNotes, 'reviewer.humanNotes', HUMAN_NOTES_KEYS));
  }
  if (keyErrors.length > 0) return { ok: false, errors: keyErrors };
  const { facts, ...risk } = input.risk as Record<string, unknown>;
  const metrics: Record<string, string> = { ...(input.meta.model ? { model: input.meta.model } : {}), stage: 'judge', judgedBy: input.meta.judgedBy };
  const parsed = parseVerdict({ version: 1, pr: input.pr, headSha: input.judgedHead, review: input.reviewer, risk, facts, metrics });
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const unsafe = RISK_QUESTIONS.filter((q) => v.risk.answers[q.key] !== q.safe).map((q) => `- ${q.text}：${v.risk.answers[q.key]}`);
  const body = [
    claudeMark(session),
    '## 判定',
    '',
    `- Reviewer：${v.review.pass ? '合格' : '不合格'}（ブロッキング指摘 ${v.review.blocking.length} 件）`,
    `- Risk：${v.risk.level}${unsafe.length > 0 ? '。安全側でない答え：' : ''}`,
    ...unsafe.map((l) => `  ${l}`),
    '',
    renderBlock('agent-verdict', v),
  ].join('\n');
  return { ok: true, value: `${body}\n` };
}
