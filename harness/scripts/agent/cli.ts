import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type ApiCounter, CountingTransport } from '../../lib/api-count.ts';
import { type AssigneeIo, checkAssignee } from '../../lib/assignee.ts';
import { type BlockKind, claudeMark, extractBlock, renderBlock, withClaudeMark } from '../../lib/blocks.ts';
import { ensureOwnClaim as ownClaimError } from '../../lib/claim.ts';
import { LABELS, loadConfig, REASON_CODES, type ReasonCode, reasonMark, riskLabel } from '../../lib/config.ts';
import { parseDecision } from '../../lib/decision.ts';
import { parseHandoff } from '../../lib/handoff.ts';
import { GitHub, transportFromEnv } from '../../lib/github.ts';
import { judgedHeadError, samePrPatch } from '../../lib/patch-id.ts';
import { compareHarness, type DriftResult, harnessVersionsAt, loadedRecordPath, readLoadedRecord } from '../../lib/harness-drift.ts';
import { expectedPlanGate, parsePlan, type Plan, plannerRequestsHuman } from '../../lib/plan.ts';
import { type Claim, CLAIM_STAGES, type ClaimStage } from '../../lib/queue.ts';
import { transcriptSessionId } from '../../lib/session.ts';
import { linkedIssues, type PullRequest, withStack } from '../../lib/state.ts';
import { countCalls, estimateCost, findSessionTranscriptsWithNote, summarizeUsage, totalTokens } from '../../lib/usage.ts';
import { parseVerdict } from '../../lib/verdict.ts';

/**
 * harness/scripts/agent.ts のサブコマンドが共有する補助（設定・GitHub・着手宣言・書式の検査・一時ファイル）と、コマンドの型・読み込み。
 * 各コマンドは harness/scripts/agent/commands/ の下にある（Issue #313）。
 */

export const config = loadConfig();

export function repository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = spawnGit(['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ?? url.match(/\/git\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin から owner/repo を判別できません: ${url}`);
  return m[1]!;
}

export function spawnGit(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

/**
 * 今のセッションの ID。Routine（CLAUDE_CODE_REMOTE_SESSION_ID）ならセッションの URL、
 * 付き添いのセッションなら SessionStart の hook（.claude/hooks/session-env.ts）が書いた AGENT_HARNESS_SESSION。どちらも無ければ null
 */
export function currentSession(): string | null {
  return sessionUrl() ?? (process.env.AGENT_HARNESS_SESSION || null);
}

/** このセッションの読み込みを origin と比べた結果（harness-drift のコマンドと claim・fleet-status・step が使う。Issue #199） */
export interface HarnessDrift extends DriftResult {
  judged: true;
  /** 比べた origin の ref と commit */
  base: string;
  /** 記録の HEAD と origin の merge-base（求まらなければ null） */
  mergeBase: string | null;
  recordedAt: string;
  note: string | null;
}

/**
 * このセッション（AGENT_HARNESS_SESSION。Routine では判断しない）の読み込みの記録を、origin の既定ブランチと比べる。記録が無ければ null（fetch もしない）。
 * fetch に失敗しても止めず、手元の origin の ref で比べたことを note に書く。merge-base が求まらなければ M 無しで比べる（安全側）
 */
export function harnessDrift(): HarnessDrift | null {
  const session = transcriptSessionId(process.env);
  const commonDir = spawnGit(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const path = commonDir ? loadedRecordPath(commonDir, session) : null;
  const record = path ? readLoadedRecord(path) : null;
  if (!record) return null;
  const notes: string[] = [];
  const ref = `origin/${config.defaultBranch}`;
  if (spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', config.defaultBranch], { encoding: 'utf8' }).status !== 0) notes.push(`git fetch に失敗したため、手元の ${ref} で比べた`);
  const origin = harnessVersionsAt(process.cwd(), ref);
  if (origin === null) return null;
  let mergeBase: string | null = null;
  let base: Record<string, string> | null = null;
  if (record.head) {
    const r = spawnSync('git', ['merge-base', record.head, ref], { encoding: 'utf8' });
    mergeBase = r.status === 0 ? (r.stdout ?? '').trim() || null : null;
    base = mergeBase ? harnessVersionsAt(process.cwd(), mergeBase) : null;
    if (base === null) {
      mergeBase = null;
      notes.push('記録の HEAD と origin の merge-base が求まらないため、記録と origin だけで比べた');
    }
  } else notes.push('記録に HEAD が無いため、記録と origin だけで比べた');
  const result = compareHarness(record.files, origin, base);
  return { judged: true, ...result, base: `${ref} (${spawnGit(['rev-parse', ref])})`, mergeBase, recordedAt: record.at, note: notes.length > 0 ? notes.join('。') : null };
}

export function parseStage(args: string[]): ClaimStage | undefined {
  const i = args.indexOf('--stage');
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || !(CLAIM_STAGES as readonly string[]).includes(v)) fail([`--stage は ${CLAIM_STAGES.join(' / ')} のいずれか`]);
  return v as ClaimStage;
}

export function sessionUrl(): string | null {
  const id = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  return id ? `https://claude.ai/code/${id.replace(/^cse_/, 'session_')}` : null;
}


/** このセッションの手動の宣言の値 */
export function manualClaim(stage?: ClaimStage): Extract<Claim, { by: 'manual' }> {
  const session = currentSession();
  return { by: 'manual', at: new Date().toISOString(), ...(session ? { session } : {}), ...(stage ? { stage } : {}) };
}

export function claimBody(manual: boolean, release = false, stage?: ClaimStage): string {
  const url = sessionUrl();
  // Routine の宣言にも段階を書く（計画ゲートが、計画より前の段階 plan-critique の宣言を確かめるため）
  const base: Claim = manual || !url ? manualClaim(stage) : { by: 'routine', session: url, at: new Date().toISOString(), ...(stage ? { stage } : {}) };
  return renderClaim(release ? { ...base, released: true } : base);
}

export function renderClaim(value: Claim): string {
  const who = value.by === 'routine' ? `Routine: ${value.session}` : '手動';
  const what = value.released ? `着手を解除しました（${who}）。` : `着手しました（${who}${value.stage ? `、段階 ${value.stage}` : ''}）。`;
  return [claudeMark(currentSession()), what, '', renderBlock('agent-claim', value)].join('\n');
}

export function blockBody(code: string, text: string): string {
  if (!(code in REASON_CODES)) fail([`理由コードは ${Object.keys(REASON_CODES).join(' / ')} のいずれか`]);
  return [claudeMark(currentSession()), reasonMark(code as ReasonCode), `\`agent:blocked\` にしました（${REASON_CODES[code as ReasonCode]}）。人の対応が必要です。`, '', text].join('\n');
}

/** Issue #172 の Assignee の確かめに使う GitHub の読み出し（PR が Close する Issue は、領域の上限の数え方と同じ linkedIssues。スタックの層は本文の Refs／Closes） */
export function assigneeIo(gh: GitHub): AssigneeIo {
  return {
    me: async () => (await gh.get<{ login: string }>('/user')).login,
    issue: async (i) => {
      const item = await gh.get<{ assignees?: { login: string }[] | null; pull_request?: unknown }>(`/issues/${i}`);
      return { assignees: (item.assignees ?? []).map((a) => a.login), pullRequest: Boolean(item.pull_request) };
    },
    closingIssues: async (pr) => linkedIssues(gh, config, await withStack(gh, config, await gh.get<PullRequest>(`/pulls/${pr}`))),
  };
}

/** critic-input・post-plan・worktree・ensure-claim の前に、このセッションの着手宣言（持ち主）を確かめる */
export async function ensureOwnClaim(gh: GitHub, n: number): Promise<void> {
  const r = await ownClaimError(gh, n, currentSession(), () => checkAssignee(assigneeIo(gh), config, n));
  if (r.error) fail([r.error]);
}

/** 計画コメントを検査し、投稿する本文と付け外しするラベルを返す（表示用の risk:* と、必要なら plan-review） */
export function renderPlan(n: number, file: string, critiqueClaimed: boolean | null = null): { body: string; addLabels: string[]; removeLabels: string[]; expectedGate: { pass: boolean; reasons: string[] } } {
  const checked = checkFile(file);
  if (checked.kind !== 'plan' || checked.errors.length > 0) fail(checked.errors);
  const plan = checked.value as Plan;
  // 批評の関所を含む見込み。critiqueClaimed が null（render-plan）なら、段階 plan-critique の宣言は確かめない
  const gate = expectedPlanGate(plan, n, config, critiqueClaimed);
  const risks = (['low', 'medium', 'high', 'critical'] as const).map(riskLabel);
  return {
    body: readBlockFile(file),
    addLabels: [riskLabel(plan.risk), ...(plannerRequestsHuman(plan) ? [LABELS.planReview] : [])],
    removeLabels: risks.filter((r) => r !== riskLabel(plan.risk)),
    expectedGate: gate,
  };
}

/**
 * 判定コメントを検査し、投稿する本文を返す。headSha は投稿直前に確かめた PR の head。
 * samePatch を渡すと、head が違っても samePatch(判定した head) が true（PR 自身の差分の patch-id が同じ）なら通す。
 * 渡さなければ完全一致を求める（render-verdict）
 */
export function renderVerdict(n: number, headSha: string, file: string, samePatch?: (judgedHead: string) => boolean): string {
  const checked = checkFile(file);
  if (checked.kind !== 'verdict' || checked.errors.length > 0) fail(checked.errors);
  const v = checked.value as { pr: number; headSha: string };
  if (v.pr !== n) fail([`verdict.pr（${v.pr}）が #${n} と一致しません`]);
  if (samePatch === undefined) {
    if (v.headSha !== headSha) fail([`verdict.headSha が現在の head（${headSha}）と一致しません。判定し直してください`]);
  } else {
    const error = judgedHeadError(v.headSha, headSha, () => samePatch(v.headSha));
    if (error !== null) fail([error]);
  }
  return readBlockFile(file);
}

/** 判定した head と今の head で PR 自身の差分（origin/<base>...<head>）の patch-id が同じか。git fetch の後に比べる */
export function samePatchAsCurrent(pr: PullRequest, judgedHead: string): boolean {
  spawnSync('git', ['fetch', '-q', 'origin'], { encoding: 'utf8' });
  return samePrPatch(`origin/${pr.base.ref}`, judgedHead, pr.head.sha);
}

export function readBlockFile(file: string): string {
  const body = readFileSync(file, 'utf8');
  return withClaudeMark(body, currentSession());
}

export function checkFile(file: string): { kind: 'plan' | 'verdict' | 'decision' | 'handoff'; errors: string[]; value?: unknown } {
  const body = readFileSync(file, 'utf8');
  for (const kind of ['plan', 'verdict', 'decision', 'handoff'] as const) {
    const b = extractBlock(body, `agent-${kind}` as BlockKind);
    if (!b.found) continue;
    if (!b.ok) return { kind, errors: [b.error] };
    const parsed = kind === 'plan' ? parsePlan(b.value) : kind === 'verdict' ? parseVerdict(b.value) : kind === 'decision' ? parseDecision(b.value) : parseHandoff(b.value);
    return parsed.ok ? { kind, errors: [], value: parsed.value } : { kind, errors: parsed.errors };
  }
  throw new Error('agent-plan / agent-verdict / agent-decision / agent-handoff ブロックがありません');
}

/** 一時ディレクトリにファイルを書き、パスを返す */
export function writeTemp(name: string, text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-harness-')), name);
  writeFileSync(path, text);
  return path;
}

export type IssueItem = { number: number; title: string; body: string | null };

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail([`${file}: JSON として読めません: ${(e as Error).message}`]);
  }
}

/** セッション記録の集計。記録が無ければ null（処理は止めない） */
export function usageReport(explicit?: string) {
  const { files, bySession } = findSessionTranscriptsWithNote(process.cwd(), explicit, transcriptSessionId(process.env));
  const lines: string[] = [];
  for (const f of files) {
    try {
      lines.push(...readFileSync(f, 'utf8').split('\n'));
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  const summary = summarizeUsage(lines);
  if (Object.keys(summary).length === 0) return null;
  const cost = estimateCost(summary, config.pricing ?? {});
  const total = totalTokens(summary);
  const calls = countCalls(lines);
  return {
    files,
    bySession,
    perModel: Object.fromEntries(Object.entries(summary).map(([m, tokens]) => [m, { tokens, estimatedUsd: cost.perModel[m] ?? null }])),
    total,
    calls,
    cacheReadPerCall: calls === 0 ? null : Math.round(total.cacheRead / calls),
    estimatedUsd: cost.totalUsd,
    note: [
      'API で動かした場合の推定料金（USD）。サブスク利用ではトークン単位の請求はない',
      ...(bySession ? [] : ['今のセッションの記録が見つからないため、最も新しい記録を集計した（ほかのセッションのものかもしれない）']),
    ].join('。'),
  };
}

export function fail(errors: string[]): never {
  console.error(['書式エラー:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(2);
}

/** GitHub を作る。counter があれば呼び出しを数え、応答の上限のヘッダーを覚える */
export function newGitHub(counter: ApiCounter | null): GitHub {
  if (!counter) return new GitHub(transportFromEnv(), repository());
  return new GitHub(new CountingTransport(transportFromEnv({ onResponse: counter.observe }), counter), repository());
}

/** コマンドに渡す文脈。gh は初めて呼んだときに作る（GitHub を使わないコマンドは作らず、gh・origin が無くても動く） */
export interface CommandContext {
  counter: ApiCounter | null;
  gh(): GitHub;
}

/** サブコマンド1つ。commands/ の各ファイルが `export const commands: AgentCommand[]` で出す */
export interface AgentCommand {
  name: string;
  run(args: string[], ctx: CommandContext): Promise<void> | void;
}

/** サブコマンドを置くディレクトリ */
export const COMMANDS_DIR: string = fileURLToPath(new URL('./commands/', import.meta.url));

/**
 * dir の直下の .ts を名前の順に読み込み、名前からコマンドを引く表を返す。README.md など .ts 以外は読まない。
 * 同じ名前のコマンドが2つあれば止める（どちらを呼ぶか決められないため）
 */
export async function loadCommands(dir: string): Promise<Map<string, AgentCommand>> {
  const out = new Map<string, AgentCommand>();
  const from = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { commands?: AgentCommand[] };
    for (const c of mod.commands ?? []) {
      const prev = from.get(c.name);
      if (prev !== undefined) throw new Error(`コマンドの名前が重複しています: ${c.name}（${prev} と ${file}）`);
      out.set(c.name, c);
      from.set(c.name, file);
    }
  }
  return out;
}
