// 過去の PR のローカルの判定（コラボレーターの agent-verdict のうちブロッキング指摘のある最初の判定）を選び、その head を replayReview で流し直して、
// ローカルの判定と並べた行・Markdown の表（summary.md）と PR ごとの JSON を書く。同じ問題かの最終判断は人が表と JSON を読んで行う。
// GitHub の読み取り・Claude のクライアント・fs・時計・ログ・秘密は注入で受け取る。ログと書く文字列は redact を通す。
// import は review-api/src の中だけで（harness/lib・@anthropic-ai/sdk・cloudflare:workers・node: は import しない）、harness/test から読める。
import type { MessagesClient } from './claude.ts';
import type { ReviewConfig } from './config.ts';
import type { IssueComment } from './github.ts';
import { redact } from './redact.ts';
import { replayReview, type ReplayDeps, type ReplayResult } from './replay.ts';
import { NOUL, RISK_LEVELS, RISK_QUESTIONS, type Noul, type RiskLevel, type RiskQuestionKey } from './verdict.ts';

export interface Finding {
  kind: string;
  file?: string;
  detail: string;
}

export interface LocalVerdict {
  commentId: number;
  pr: number;
  headSha: string;
  pass: boolean;
  blocking: Finding[];
  riskLevel: RiskLevel | null;
  riskAnswers: Partial<Record<RiskQuestionKey, Noul>>;
}

// harness/lib/config.ts の TRUSTED_ASSOCIATIONS と harness/lib/blocks.ts の extractBlock と同じ条件（harness/lib は import しないので写す）
const TRUSTED_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const VERDICT_FENCE = /^(`{3,})[ \t]*agent-verdict[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readFindings(raw: unknown[]): Finding[] {
  const out: Finding[] = [];
  for (const f of raw) {
    if (!isObject(f)) continue;
    const finding: Finding = { kind: typeof f.kind === 'string' ? f.kind : '', detail: typeof f.detail === 'string' ? f.detail : '' };
    if (typeof f.file === 'string') finding.file = f.file;
    out.push(finding);
  }
  return out;
}

function readVerdict(c: IssueComment, pr: number): LocalVerdict | null {
  if (!TRUSTED_ASSOCIATIONS.includes(c.author_association)) return null;
  const fences = [...c.body.replace(/\r\n/g, '\n').matchAll(VERDICT_FENCE)];
  if (fences.length !== 1) return null;
  let v: unknown;
  try {
    v = JSON.parse(fences[0]![2]!);
  } catch {
    return null;
  }
  if (!isObject(v) || v.pr !== pr || typeof v.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(v.headSha)) return null;
  const review = isObject(v.review) ? v.review : {};
  if (!Array.isArray(review.blocking) || review.blocking.length === 0) return null;
  const risk = isObject(v.risk) ? v.risk : {};
  const level = RISK_LEVELS.find((l) => l === risk.level) ?? null;
  const answers: Partial<Record<RiskQuestionKey, Noul>> = {};
  const rawAnswers = isObject(risk.answers) ? risk.answers : {};
  for (const q of RISK_QUESTIONS) {
    const a = NOUL.find((n) => n === rawAnswers[q.key]);
    if (a !== undefined) answers[q.key] = a;
  }
  return { commentId: c.id, pr, headSha: v.headSha, pass: review.pass === true, blocking: readFindings(review.blocking), riskLevel: level, riskAnswers: answers };
}

/** コラボレーターの agent-verdict のうち、ブロッキング指摘が1件以上のものを古い順（コメントの id の小さい順）に返す */
export function selectBlockingVerdicts(comments: IssueComment[], pr: number): LocalVerdict[] {
  return [...comments]
    .sort((a, b) => a.id - b.id)
    .map((c) => readVerdict(c, pr))
    .filter((v): v is LocalVerdict => v !== null);
}

export type MarkedFinding = Finding & { candidate: boolean };

export type CompareRow = { pr: number } & (
  | {
      status: 'compared';
      headSha: string;
      passMatch: boolean;
      local: { pass: boolean; blocking: MarkedFinding[]; riskLevel: RiskLevel | null };
      api: { pass: boolean; blocking: MarkedFinding[]; riskLevel: RiskLevel };
      riskLevelMatch: boolean;
      riskAgree: number;
      usd: number | null;
    }
  | { status: 'invalid' | 'error'; headSha: string; detail: string; usd: number | null }
  | { status: 'not-run'; headSha: string; reason: 'budget' | 'exists' }
  | { status: 'excluded'; reason: string }
);

const sameSpot = (a: Finding, b: Finding): boolean => a.kind === b.kind && a.file === b.file;

function mark(own: Finding[], other: Finding[]): MarkedFinding[] {
  return own.map((f) => ({ ...f, candidate: other.some((o) => sameSpot(f, o)) }));
}

/** ローカルの判定と流し直しの結果を1行にまとめる。candidate は kind と file が同じ指摘が反対側にあるという印だけ */
export function compareRow(local: LocalVerdict, result: Exclude<ReplayResult, { outcome: 'over-budget' }>): CompareRow {
  if (result.outcome !== 'reviewed') {
    return { pr: local.pr, status: result.outcome, headSha: local.headSha, detail: result.detail, usd: result.usd };
  }
  const verdict = result.record.verdict;
  const apiBlocking = readFindings(verdict.review.blocking);
  const riskLevelMatch = local.riskLevel === verdict.risk.level;
  // 8 問＝level ＋ q2〜q8。ローカル側に答えが無い問いは不一致
  const riskAgree = (riskLevelMatch ? 1 : 0) + RISK_QUESTIONS.filter((q) => local.riskAnswers[q.key] === verdict.risk.answers[q.key]).length;
  return {
    pr: local.pr,
    status: 'compared',
    headSha: local.headSha,
    passMatch: local.pass === verdict.review.pass,
    local: { pass: local.pass, blocking: mark(local.blocking, apiBlocking), riskLevel: local.riskLevel },
    api: { pass: verdict.review.pass, blocking: mark(apiBlocking, local.blocking), riskLevel: verdict.risk.level },
    riskLevelMatch,
    riskAgree,
    usd: result.record.usd,
  };
}

const cell = (text: string): string => text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

function findingsCell(list: MarkedFinding[]): string {
  if (list.length === 0) return '—';
  return list.map((f) => cell(`${f.candidate ? '〔候補〕' : ''}\`${f.kind}\`${f.file === undefined ? '' : ` \`${f.file}\``}：${f.detail}`)).join('<br>');
}

const usdText = (usd: number | null): string => (usd === null ? '—' : `$${usd.toFixed(4)}`);

const NOT_RUN_REASON: Record<'budget' | 'exists', string> = { budget: '上限', exists: '既にファイルがある' };

export interface SummaryMeta {
  repository: string;
  maxUsd: number;
  models: { review: string; risk: string };
  generatedAt: string;
}

/** 表と末尾の合計の Markdown */
export function renderSummary(rows: CompareRow[], meta: SummaryMeta): string {
  const lines = [
    '# API のレビューの流し直し',
    '',
    `- リポジトリ：${meta.repository}`,
    `- 上限：$${meta.maxUsd}`,
    `- モデル：review=${meta.models.review} risk=${meta.models.risk}`,
    `- 日時：${meta.generatedAt}`,
    '',
    '| PR | head | 状態 | pass（ローカル / API） | ローカルのブロッキング | API のブロッキング | Risk level（ローカル / API） | 8 問の一致 | USD |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  let usdTotal = 0;
  const count = { compared: 0, invalid: 0, error: 0, notRun: 0, excluded: 0, passMatch: 0, riskMatch: 0, localBlocking: 0, candidates: 0 };
  for (const r of rows) {
    const head = 'headSha' in r ? `\`${r.headSha.slice(0, 7)}\`` : '—';
    if (r.status === 'compared') {
      count.compared++;
      if (r.passMatch) count.passMatch++;
      if (r.riskLevelMatch) count.riskMatch++;
      count.localBlocking += r.local.blocking.length;
      count.candidates += r.local.blocking.filter((f) => f.candidate).length;
      usdTotal += r.usd ?? 0;
      lines.push(
        `| #${r.pr} | ${head} | 比べた | ${r.local.pass} / ${r.api.pass} | ${findingsCell(r.local.blocking)} | ${findingsCell(r.api.blocking)} | ${r.local.riskLevel ?? '—'} / ${r.api.riskLevel} | ${r.riskAgree}/8 | ${usdText(r.usd)} |`,
      );
    } else if (r.status === 'invalid' || r.status === 'error') {
      if (r.status === 'invalid') count.invalid++;
      else count.error++;
      usdTotal += r.usd ?? 0;
      lines.push(`| #${r.pr} | ${head} | ${r.status}：${cell(r.detail)} | — | — | — | — | — | ${usdText(r.usd)} |`);
    } else if (r.status === 'not-run') {
      count.notRun++;
      lines.push(`| #${r.pr} | ${head} | 未実行（${NOT_RUN_REASON[r.reason]}） | — | — | — | — | — | — |`);
    } else if (r.status === 'excluded') {
      count.excluded++;
      lines.push(`| #${r.pr} | ${head} | 対象外：${cell(r.reason)} | — | — | — | — | — | — |`);
    }
  }
  lines.push(
    '',
    '〔候補〕は kind と file が同じという印だけで、同じ問題かは本文を読んで人が決める。',
    '',
    '## 合計',
    '',
    `- 件数：${rows.length}（比べた ${count.compared}・invalid ${count.invalid}・error ${count.error}・未実行 ${count.notRun}・対象外 ${count.excluded}）`,
    `- pass の一致：${count.passMatch}/${count.compared}`,
    `- ローカルのブロッキング指摘：${count.localBlocking} 件（〔候補〕${count.candidates} 件）`,
    `- Risk level の一致：${count.riskMatch}/${count.compared}`,
    `- USD 合計：$${usdTotal.toFixed(4)}`,
    '',
  );
  return lines.join('\n');
}

export interface ReplayFs {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** 既にあれば失敗する */
  writeNew(path: string, text: string): Promise<void>;
}

export interface ReplayCompareDeps extends ReplayDeps {
  fs: ReplayFs;
}

export interface ReplayCompareParams {
  owner: string;
  repo: string;
  prs: number[];
  maxUsd: number;
  outDir: string;
  gateAppLogin: string;
  config: ReviewConfig;
}

type Target = { pr: number; local: LocalVerdict } | { pr: number; excluded: string };

async function pickTarget(deps: Omit<ReplayDeps, 'claude'>, pr: number): Promise<Target> {
  try {
    const gh = await deps.github.reader();
    const local = selectBlockingVerdicts(await gh.listComments(pr), pr)[0];
    return local === undefined ? { pr, excluded: 'ブロッキング指摘のある agent-verdict が無い' } : { pr, local };
  } catch (e) {
    return { pr, excluded: `コメントを読めない：${redact(e instanceof Error ? e.message : String(e), deps.secrets ?? [])}` };
  }
}

/** PR を順に流し直し、PR ごとの JSON と summary.md を outDir に書く。summary.md が既にあれば何もしない */
export async function runReplayCompare(
  deps: ReplayCompareDeps,
  params: ReplayCompareParams,
): Promise<{ outcome: 'exists'; path: string } | { outcome: 'done'; rows: CompareRow[]; spentUsd: number }> {
  const secrets = deps.secrets ?? [];
  const log = (line: string): void => deps.log(redact(line, secrets));
  const write = (path: string, text: string): Promise<void> => deps.fs.writeNew(path, redact(text, secrets));
  const out = params.outDir.replace(/\/+$/, '');
  const summaryPath = `${out}/summary.md`;
  if (await deps.fs.exists(summaryPath)) {
    log(`replay-compare summary exists`);
    return { outcome: 'exists', path: summaryPath };
  }
  await deps.fs.mkdir(out);

  const rows: CompareRow[] = [];
  let spent = 0;
  let stopped = false;
  for (const pr of params.prs) {
    const target = await pickTarget(deps, pr);
    if ('excluded' in target) {
      rows.push({ pr, status: 'excluded', reason: target.excluded });
      log(`replay-compare pr=${pr} excluded`);
      continue;
    }
    const { local } = target;
    const jsonPath = `${out}/pr-${pr}.json`;
    if (await deps.fs.exists(jsonPath)) {
      rows.push({ pr, status: 'not-run', headSha: local.headSha, reason: 'exists' });
      log(`replay-compare pr=${pr} not-run exists`);
      continue;
    }
    if (stopped) {
      rows.push({ pr, status: 'not-run', headSha: local.headSha, reason: 'budget' });
      log(`replay-compare pr=${pr} not-run budget`);
      continue;
    }
    const result = await replayReview(deps, {
      owner: params.owner,
      repo: params.repo,
      pr,
      headSha: local.headSha,
      gateAppLogin: params.gateAppLogin,
      config: params.config,
      remainingUsd: params.maxUsd - spent,
    });
    if (result.outcome === 'over-budget') {
      stopped = true;
      rows.push({ pr, status: 'not-run', headSha: local.headSha, reason: 'budget' });
      log(`replay-compare pr=${pr} not-run budget`);
      continue;
    }
    const row = compareRow(local, result);
    const usd = (result.outcome === 'reviewed' ? result.record.usd : result.usd) ?? result.estimatedUsd;
    // 費用が分からなければ、以降は上限を守れないので流さない
    if (usd === null) stopped = true;
    else spent += usd;
    await write(jsonPath, JSON.stringify({ version: 1, pr, local, result, row }, null, 2) + '\n');
    rows.push(row);
    log(`replay-compare pr=${pr} ${row.status}`);
  }

  const summary = renderSummary(rows, {
    repository: `${params.owner}/${params.repo}`,
    maxUsd: params.maxUsd,
    models: { review: params.config.claude.reviewModel, risk: params.config.claude.riskModel },
    generatedAt: new Date(deps.now()).toISOString(),
  });
  await write(summaryPath, summary);
  log(`replay-compare done spent=${spent}`);
  return { outcome: 'done', rows, spentUsd: spent };
}

export type ListRow = { pr: number; headSha: string; estimatedUsd: number | null } | { pr: number; reason: string };

// --list では Claude を呼ばない（remainingUsd: 0 で見込みだけを取る）。呼ばれたら投げる保険
const NO_CLAUDE: MessagesClient = {
  async create() {
    throw new Error('--list では Claude を呼ばない');
  },
};

/** 対象と見込みの USD だけを返す（Claude を呼ばず、書かない）。見込みが1件でも出せなければ合計は null */
export async function listReplayTargets(
  deps: Omit<ReplayDeps, 'claude'>,
  params: Omit<ReplayCompareParams, 'maxUsd' | 'outDir'>,
): Promise<{ rows: ListRow[]; totalUsd: number | null }> {
  const rows: ListRow[] = [];
  let total: number | null = 0;
  for (const pr of params.prs) {
    const target = await pickTarget(deps, pr);
    if ('excluded' in target) {
      rows.push({ pr, reason: target.excluded });
      continue;
    }
    const result = await replayReview(
      { ...deps, claude: NO_CLAUDE },
      { owner: params.owner, repo: params.repo, pr, headSha: target.local.headSha, gateAppLogin: params.gateAppLogin, config: params.config, remainingUsd: 0 },
    );
    const estimatedUsd = result.estimatedUsd;
    rows.push({ pr, headSha: target.local.headSha, estimatedUsd });
    total = total === null || estimatedUsd === null ? null : total + estimatedUsd;
  }
  return { rows, totalUsd: total };
}
