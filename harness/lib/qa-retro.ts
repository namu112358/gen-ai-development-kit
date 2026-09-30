import { appMarkKind } from './blocks.ts';
import { appLogin, projectChecks, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import type { Acceptance } from './merge-route.ts';
import { fixPrsFor, isFixPr, type MergedPr } from './report.ts';
import { appRecords, closingIssues, fixRequestCount, isAgentPr, isAppComment, isTrustedComment, type PullRequest } from './state.ts';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';
import { DELEGATED_MERGE_KIND } from '../gates/delegation.ts';

/**
 * Merge 済みの PR の振り返り（qa-retro の skill）の集計。決まるもの（数える・組にする）だけを行い、判断（見落としか、どの問いで拾えたか）は skill の手順でセッションが行う。
 * GitHub から事実を集める collectQaRetro と、集めた事実を読む・数える純粋関数に分ける。GitHub には書かない。
 * 後追いの修正は harness/lib/report.ts の fixPrsFor（Merge 後 7 日以内、変更ファイルが重なり、行か参照で元の PR に結び付く fix の PR。
 * 判定の集計の harness/scripts/report.ts と同じ材料：変更ファイルと patch・本文・Closes する Issue の番号）、revert は on-main-push.ts と同じ読み方。
 * 報告は判定の材料にしない（reviewer・risk-agent・Jev に渡さない）。
 */

const DAY = 86400_000;
const WEEK = 7 * DAY;
const MAX_PAGES = 10;

export type MergeRoute = 'auto' | 'delegated' | 'human';
export type RiskKey = 'low' | 'medium' | 'high' | 'critical' | 'none';
export const RISK_KEYS: readonly RiskKey[] = ['low', 'medium', 'high', 'critical', 'none'];

export interface TokenCounts { input: number; output: number; cacheWrite: number; cacheRead: number }

/** メトリクスの表の1行（render-metrics のコメントか、PR 本文の実行メトリクス表） */
export interface MetricRow {
  source: 'comment' | 'body';
  at: string;
  stage: string;
  model: string;
  minutes: number | null;
  /** 入力/出力/キャッシュ書込/キャッシュ読込の4つが読めたとき */
  tokens: TokenCounts | null;
  /** トークンの合計（数1つの書き方も含む） */
  totalTokens: number | null;
  usd: number | null;
}

export interface MetricsSummary {
  rows: MetricRow[];
  minutes: number;
  tokens: TokenCounts;
  totalTokens: number;
  usd: number;
  /** 読めなかった値の数（合計に入れていない） */
  unreadable: number;
}

export interface QaRetroPr {
  number: number;
  title: string;
  mergedAt: string;
  agentPr: boolean;
  /** 最後の受け付けの記録の riskLevel（無ければ null） */
  risk: string | null;
  autoEligible: boolean | null;
  mergeRoute: MergeRoute;
  /** 受け付けの記録の数 */
  verdicts: number;
  /** 受け付けられなかった判定コメント（App の verdict-rejected）の数 */
  rejectedVerdicts: number;
  /** App の修正要求レビューの数（fix の往復） */
  fixRequests: number;
  metrics: MetricsSummary;
  fixedBy: number[];
  reverted: boolean;
}

export interface QaRetroFollowup {
  pr: number;
  title: string;
  risk: string | null;
  mergeRoute: MergeRoute;
  /** 後追いの fix の PR と、元の PR と重なった変更ファイル */
  fixes: { number: number; title: string; files: string[] }[];
  reverted: boolean;
}

export interface RiskBucket { merged: number; fixed: number; reverted: number; fixedRate: number | null; revertedRate: number | null }
export type QaRetroByRisk = Record<RiskKey, RiskBucket & { auto: RiskBucket }>;

export interface FlakyCiRun {
  /** rerun：同じ実行の再試行で通った。separate-run：同じ head の別の実行で通った */
  kind: 'rerun' | 'separate-run';
  workflow: string;
  headSha: string;
  failed: { runId: number; attempt: number; url: string };
  passed: { runId: number; attempt: number; url: string };
  /** 失敗した対象のジョブ（projectChecks の context と名前が一致するもの）。testNames はログが読めなければ null */
  jobs: { name: string; id: number; testNames: string[] | null }[];
}

export interface QaRetroData {
  period: { since: string; until: string };
  prs: QaRetroPr[];
  followups: QaRetroFollowup[];
  byRisk: QaRetroByRisk;
  flakyCi: FlakyCiRun[];
  notes: { unreadableLogs: number; unreadableMetrics: number; truncated: string[] };
}

// --- 引数 ---

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(v: string | undefined, name: string, errors: string[]): Date | null {
  if (v === undefined || !DATE_RE.test(v)) {
    errors.push(`${name} は YYYY-MM-DD で書いてください`);
    return null;
  }
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    errors.push(`${name} の日付が正しくありません: ${v}`);
    return null;
  }
  return d;
}

/**
 * `--days <n>`・`--since <YYYY-MM-DD>`・`--until <YYYY-MM-DD>` を読む。既定は直近 14 日。
 * since はその日の 00:00Z から、until はその日を含む（翌日の 00:00Z の手前まで）。
 */
export function parseQaRetroArgs(args: string[], now: Date): { ok: true; value: { since: Date; until: Date } } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const opts: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--days' || a === '--since' || a === '--until') {
      if (a in opts) errors.push(`${a} が2回あります`);
      opts[a] = args[++i];
    } else {
      errors.push(`知らない引数です: ${a}`);
    }
  }
  if ('--days' in opts && '--since' in opts) errors.push('--days と --since は同時に渡せません');
  let until = now;
  if ('--until' in opts) {
    const d = parseDate(opts['--until'], '--until', errors);
    if (d) until = new Date(d.getTime() + DAY);
  }
  let days = 14;
  if ('--days' in opts) {
    const v = opts['--days'];
    if (v === undefined || !/^[1-9]\d*$/.test(v)) errors.push('--days は正の整数で書いてください');
    else days = Number(v);
  }
  let since = new Date(until.getTime() - days * DAY);
  if ('--since' in opts) {
    const d = parseDate(opts['--since'], '--since', errors);
    if (d) since = d;
  }
  if (errors.length === 0 && since.getTime() >= until.getTime()) errors.push('期間の始まりが終わりより後です');
  return errors.length ? { ok: false, errors } : { ok: true, value: { since, until } };
}

// --- 純粋関数 ---

/** merged_by が App なら自動 Merge（App の delegated-merge の記録があれば委任）、それ以外は人の Merge */
export function mergeRouteOf(config: HarnessConfig, mergedBy: { login: string } | null | undefined, comments: IssueComment[]): MergeRoute {
  if (mergedBy?.login !== appLogin(config)) return 'human';
  return appRecords(config, comments, DELEGATED_MERGE_KIND).length > 0 ? 'delegated' : 'auto';
}

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function parseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function parseTokens(v: string | undefined): { tokens: TokenCounts | null; totalTokens: number | null } {
  const parts = (v ?? '').split('/').map((p) => parseNumber(p));
  if (parts.length === 4 && parts.every((p) => p !== null)) {
    const [input, output, cacheWrite, cacheRead] = parts as number[];
    return { tokens: { input: input!, output: output!, cacheWrite: cacheWrite!, cacheRead: cacheRead! }, totalTokens: input! + output! + cacheWrite! + cacheRead! };
  }
  if (parts.length === 1 && parts[0] !== null) return { tokens: null, totalTokens: parts[0]! };
  return { tokens: null, totalTokens: null };
}

/**
 * メトリクスの表（見出しに「段階」と「所要時間（分）」がある Markdown の表）の行を読む。
 * 列は見出しの名前で探す（render-metrics のコメントは料金の列があり、PR 本文の表（appendFooter）は無い）。
 */
export function parseMetricsTables(text: string, source: 'comment' | 'body'): MetricRow[] {
  const rows: MetricRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = cells(lines[i]!);
    if (!lines[i]!.trim().startsWith('|') || !header.includes('段階') || !header.includes('所要時間（分）')) continue;
    const col = (pred: (h: string) => boolean): number => header.findIndex(pred);
    const at = col((h) => h === '時刻 (UTC)');
    const stage = col((h) => h === '段階');
    const model = col((h) => h === 'モデル');
    const minutes = col((h) => h === '所要時間（分）');
    const tokens = col((h) => h.startsWith('トークン'));
    const usd = col((h) => h === '推定料金（USD）');
    let j = i + 1;
    if (j < lines.length && /^\s*\|[\s|:-]+\|\s*$/.test(lines[j]!)) j++;
    for (; j < lines.length && lines[j]!.trim().startsWith('|'); j++) {
      const c = cells(lines[j]!);
      const get = (k: number): string | undefined => (k < 0 ? undefined : c[k]);
      const usdText = get(usd);
      const t = parseTokens(get(tokens));
      rows.push({
        source,
        at: get(at) ?? '',
        stage: get(stage) ?? '',
        model: get(model) ?? '',
        minutes: parseNumber(get(minutes)),
        tokens: t.tokens,
        totalTokens: t.totalTokens,
        usd: usdText !== undefined && /^\$\d+(\.\d+)?$/.test(usdText) ? Number(usdText.slice(1)) : null,
      });
    }
    i = j - 1;
  }
  return rows;
}

/** 読めた値だけを合計し、読めなかった値の数を unreadable に数える（本文の表は料金の列が無いので料金は数えない） */
export function sumMetrics(rows: MetricRow[]): MetricsSummary {
  const out: MetricsSummary = { rows, minutes: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, totalTokens: 0, usd: 0, unreadable: 0 };
  for (const r of rows) {
    if (r.minutes === null) out.unreadable++;
    else out.minutes += r.minutes;
    if (r.tokens) {
      out.tokens.input += r.tokens.input;
      out.tokens.output += r.tokens.output;
      out.tokens.cacheWrite += r.tokens.cacheWrite;
      out.tokens.cacheRead += r.tokens.cacheRead;
    }
    if (r.totalTokens !== null) out.totalTokens += r.totalTokens;
    else if (!r.tokens) out.unreadable++;
    if (r.usd !== null) out.usd += r.usd;
    else if (r.source === 'comment') out.unreadable++;
  }
  out.usd = Math.round(out.usd * 100) / 100;
  return out;
}

/** Actions のログから node:test の失敗したテスト名（TAP の `not ok N - 名前` と spec の `✖ 名前`）を出た順に読む */
export function parseFailedTestNames(log: string): string[] {
  const names = new Set<string>();
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/, '');
    const tap = line.match(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/);
    if (tap) {
      names.add(tap[1]!.trim());
      continue;
    }
    const spec = line.match(/^\s*✖ (.+?)(?:\s+\([\d.]+m?s\))?$/);
    if (spec && spec[1]!.trim() !== 'failing tests:') names.add(spec[1]!.trim());
  }
  return [...names];
}

function bucket(prs: QaRetroPr[]): RiskBucket {
  const merged = prs.length;
  const fixed = prs.filter((p) => p.fixedBy.length > 0).length;
  const reverted = prs.filter((p) => p.reverted).length;
  return { merged, fixed, reverted, fixedRate: merged ? fixed / merged : null, revertedRate: merged ? reverted / merged : null };
}

export function riskKey(risk: string | null): RiskKey {
  return risk !== null && (RISK_KEYS as readonly string[]).includes(risk) && risk !== 'none' ? (risk as RiskKey) : 'none';
}

/** risk ごとの Merge 数・後追いの修正・revert の数と割合。auto は自動 Merge（auto・delegated）の PR だけ */
export function summarizeQaRetro(prs: QaRetroPr[]): QaRetroByRisk {
  const out = {} as QaRetroByRisk;
  for (const k of RISK_KEYS) {
    const mine = prs.filter((p) => riskKey(p.risk) === k);
    out[k] = { ...bucket(mine), auto: bucket(mine.filter((p) => p.mergeRoute !== 'human')) };
  }
  return out;
}

// --- GitHub から集める ---

type ClosedPr = PullRequest & { author_association?: string };
type MergedBy = { merged_by: { login: string } | null };
/** Actions の実行（観測の harness/lib/test-health.ts も使う。event・pull_requests は一覧の応答にあるときだけ） */
export interface Run { id: number; name: string; workflow_id: number; head_sha: string; run_attempt: number; status: string; conclusion: string | null; html_url: string; created_at: string; event?: string; pull_requests?: { number: number }[] }
export interface Job { id: number; name: string; conclusion: string | null }

const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const within = (t: string | null | undefined, from: number, to: number): boolean => {
  if (!t) return false;
  const v = new Date(t).getTime();
  return v >= from && v < to;
};

/** 期間内に Merge された PR と、後追いの修正・revert・CI の再実行を集める（読むだけ） */
export async function collectQaRetro(gh: GitHub, config: HarnessConfig, period: { since: Date; until: Date }): Promise<QaRetroData> {
  const repository = `${gh.owner}/${gh.repo}`;
  const since = period.since.getTime();
  const until = period.until.getTime();
  const truncated: string[] = [];

  const closed = await gh.paginate<ClosedPr>('/pulls?state=closed&sort=updated&direction=desc', MAX_PAGES);
  if (closed.length >= MAX_PAGES * 100) truncated.push(`閉じた PR（${closed.length} 件で打ち切り）`);
  const merged = closed.filter((p) => within(p.merged_at, since, until)).sort((a, b) => a.number - b.number);

  // 結び付けの材料（harness/scripts/report.ts と同じ）：変更ファイルと patch（リネームは旧パスにも同じ patch）、Closes する Issue の番号。PR 番号でキャッシュする
  const filesOf = new Map<number, { files: string[]; patches: Record<string, string | undefined> }>();
  const prFiles = async (n: number) => {
    if (!filesOf.has(n)) {
      const list = await gh.paginate<{ filename: string; previous_filename?: string; patch?: string }>(`/pulls/${n}/files`, 30);
      const patches: Record<string, string | undefined> = {};
      for (const f of list) {
        patches[f.filename] = f.patch;
        if (f.previous_filename) patches[f.previous_filename] = f.patch;
      }
      filesOf.set(n, { files: list.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])), patches });
    }
    return filesOf.get(n)!;
  };
  const closesOf = new Map<number, number[]>();
  const closes = async (n: number): Promise<number[]> => {
    if (!closesOf.has(n)) closesOf.set(n, await closingIssues(gh, n).catch(() => []));
    return closesOf.get(n)!;
  };
  const material = async (p: ClosedPr): Promise<MergedPr> => ({
    number: p.number,
    title: p.title,
    headRef: p.head.ref,
    mergedAt: p.merged_at ?? null,
    body: p.body,
    ...(await prFiles(p.number)),
    closes: await closes(p.number),
  });

  // fix の候補：期間の終わりから 7 日後までに Merge された fix の PR（期間の終わりに Merge された PR の後追いを落とさない）
  const fixCandidates: MergedPr[] = [];
  for (const p of closed.filter((c) => within(c.merged_at, since, until + WEEK)).sort((a, b) => a.number - b.number)) {
    if (!isFixPr({ title: p.title, headRef: p.head.ref })) continue;
    fixCandidates.push(await material(p));
  }

  // revert：main のコミットメッセージから（on-main-push.ts と同じ読み方）
  const commits = await gh.paginate<{ sha: string; commit: { message: string } }>(`/commits?since=${isoSeconds(period.since)}&until=${isoSeconds(new Date(until + WEEK))}`, MAX_PAGES);
  if (commits.length >= MAX_PAGES * 100) truncated.push(`main のコミット（${commits.length} 件で打ち切り）`);
  const reverted = new Set<number>();
  for (const c of commits) {
    for (const n of revertedPrNumbers(c.commit.message)) reverted.add(n);
    for (const sha of revertedShas(c.commit.message)) {
      const prs = await gh.get<{ number: number }[]>(`/commits/${sha}/pulls`).catch(() => []);
      for (const p of prs) reverted.add(p.number);
    }
  }

  let unreadableMetrics = 0;
  const prs: QaRetroPr[] = [];
  const followups: QaRetroFollowup[] = [];
  for (const p of merged) {
    const detail = await gh.get<ClosedPr & MergedBy>(`/pulls/${p.number}`);
    const comments = await gh.listComments(p.number);
    const acceptances = appRecords<Acceptance>(config, comments, 'acceptance');
    const last = acceptances.at(-1)?.value ?? null;
    const original = await material(p);
    const mine = original.files;
    const fixedBy = fixPrsFor(original, fixCandidates);
    const metricRows = [
      ...comments.filter((c) => isTrustedComment(c)).flatMap((c) => parseMetricsTables(c.body ?? '', 'comment')),
      ...(isTrustedComment({ author_association: detail.author_association ?? p.author_association ?? '' }) ? parseMetricsTables(detail.body ?? '', 'body') : []),
    ];
    const metrics = sumMetrics(metricRows);
    unreadableMetrics += metrics.unreadable;
    const pr: QaRetroPr = {
      number: p.number,
      title: p.title,
      mergedAt: p.merged_at!,
      agentPr: isAgentPr(config, p, repository),
      risk: last?.riskLevel ?? null,
      autoEligible: last ? last.autoEligible : null,
      mergeRoute: mergeRouteOf(config, detail.merged_by, comments),
      verdicts: acceptances.length,
      rejectedVerdicts: comments.filter((c) => isAppComment(config, c) && appMarkKind(c.body) === 'verdict-rejected').length,
      fixRequests: await fixRequestCount(gh, config, p.number),
      metrics,
      fixedBy,
      reverted: reverted.has(p.number),
    };
    prs.push(pr);
    if (fixedBy.length > 0 || pr.reverted) {
      const set = new Set(mine);
      followups.push({
        pr: pr.number,
        title: pr.title,
        risk: pr.risk,
        mergeRoute: pr.mergeRoute,
        fixes: fixCandidates.filter((f) => fixedBy.includes(f.number)).map((f) => ({ number: f.number, title: f.title, files: f.files.filter((x) => set.has(x)) })),
        reverted: pr.reverted,
      });
    }
  }

  const { flaky, unreadableLogs, runsTruncated } = await collectFlakyCi(gh, config, period);
  truncated.push(...runsTruncated);

  return {
    period: { since: period.since.toISOString(), until: period.until.toISOString() },
    prs,
    followups,
    byRisk: summarizeQaRetro(prs),
    flakyCi: flaky,
    notes: { unreadableLogs, unreadableMetrics, truncated },
  };
}

/**
 * 期間内の実行をワークフローごとに読む（リポジトリ全体の一覧は絞り込みで 1000 件までしか返らず、
 * 実行の多いワークフロー（gate など）に CI の実行が埋もれるため）。打ち切ったワークフローは truncated に書く
 */
export async function workflowRuns(gh: GitHub, period: { since: Date; until: Date }): Promise<{ runs: Run[]; truncated: string[] }> {
  const runs: Run[] = [];
  const truncated: string[] = [];
  const workflows = (await gh.get<{ workflows?: { id: number; name: string }[] }>('/actions/workflows?per_page=100'))?.workflows ?? [];
  for (const wf of workflows) {
    const base = `/actions/workflows/${wf.id}/runs?created=${isoSeconds(period.since)}..${isoSeconds(period.until)}`;
    let done = false;
    let count = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await gh.get<{ workflow_runs?: Run[] }>(`${base}&per_page=100&page=${page}`);
      const list = res?.workflow_runs ?? [];
      runs.push(...list);
      count += list.length;
      if (list.length < 100) {
        done = true;
        break;
      }
    }
    if (!done) truncated.push(`CI の実行（${wf.name}: ${count} 件で打ち切り）`);
  }
  return { runs, truncated };
}

export async function jobsOf(gh: GitHub, path: string): Promise<Job[]> {
  const res = await gh.get<{ jobs?: Job[] }>(path);
  return res?.jobs ?? [];
}

/**
 * 同じ head で失敗の後に成功した CI の実行（再試行・別の実行）。対象のジョブは projectChecks の context と名前が一致するもの。
 * listed に workflowRuns の結果を渡すと、実行の一覧を取り直さない（観測の harness/lib/test-health.ts が一覧を1回だけ取るため）。渡さなければ自分で取る
 */
export async function collectFlakyCi(
  gh: GitHub,
  config: HarnessConfig,
  period: { since: Date; until: Date },
  listed?: { runs: Run[]; truncated: string[] },
): Promise<{ flaky: FlakyCiRun[]; unreadableLogs: number; runsTruncated: string[] }> {
  const contexts = new Set(projectChecks(config).map((c) => c.context));
  const { runs, truncated } = listed ?? (await workflowRuns(gh, period));
  const flaky: FlakyCiRun[] = [];
  let unreadableLogs = 0;

  const failedJobs = async (jobs: Job[]): Promise<FlakyCiRun['jobs']> => {
    const out: FlakyCiRun['jobs'] = [];
    for (const j of jobs.filter((x) => x.conclusion === 'failure' && contexts.has(x.name))) {
      let testNames: string[] | null = null;
      try {
        testNames = parseFailedTestNames(await gh.get<string>(`/actions/jobs/${j.id}/logs`, { raw: true }));
      } catch {
        unreadableLogs++;
      }
      out.push({ name: j.name, id: j.id, testNames });
    }
    return out;
  };

  // (1) 再試行で通った実行：前の試行が失敗
  for (const r of runs) {
    if (r.conclusion !== 'success' || r.run_attempt < 2) continue;
    const prev = r.run_attempt - 1;
    const before = await gh.get<Run>(`/actions/runs/${r.id}/attempts/${prev}`).catch(() => null);
    if (before?.conclusion !== 'failure') continue;
    const jobs = await failedJobs(await jobsOf(gh, `/actions/runs/${r.id}/attempts/${prev}/jobs`));
    if (jobs.length === 0) continue;
    flaky.push({ kind: 'rerun', workflow: r.name, headSha: r.head_sha, failed: { runId: r.id, attempt: prev, url: before.html_url ?? r.html_url }, passed: { runId: r.id, attempt: r.run_attempt, url: r.html_url }, jobs });
  }

  // (2) 同じワークフロー・同じ head の別の実行が、失敗の後に成功
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const key = `${r.workflow_id}:${r.head_sha}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i]!;
      if (f.conclusion !== 'failure') continue;
      const passed = sorted.slice(i + 1).find((x) => x.conclusion === 'success');
      if (!passed) continue;
      const jobs = await failedJobs(await jobsOf(gh, `/actions/runs/${f.id}/jobs`));
      if (jobs.length === 0) continue;
      flaky.push({ kind: 'separate-run', workflow: f.name, headSha: f.head_sha, failed: { runId: f.id, attempt: f.run_attempt, url: f.html_url }, passed: { runId: passed.id, attempt: passed.run_attempt, url: passed.html_url }, jobs });
    }
  }
  return { flaky, unreadableLogs, runsTruncated: truncated };
}
