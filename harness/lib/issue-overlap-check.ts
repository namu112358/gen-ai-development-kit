/**
 * Issue の下書きの重なりをセッションから Jev に問い、セッションの判断と並べて <セッションID>.overlap.jsonl に残す shadow（Issue #631）。
 * 問いの材料・候補の絞り方・判定は issue-overlap.ts（#499）のもの。ここは Jev を呼ぶ道・記録の読み書き・集計・出力の文だけを持つ。
 * 材料は下書きと候補のタイトル・Goal だけで、送る前に本文・タイトルへ maskSecrets をかける。答えはゲートの判断に使わない。
 * 鍵（JEV_API_KEY）が無い・jev.mode=off・jev.issueOverlap=off・候補なし・大きすぎるときは問わずに skipped で残す。
 * 開いた Issue と環境の値は呼び出し側が渡す（GitHub を呼ばない・process.env を直接読まない）。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from './config.ts';
import { incidentDir, isValidSession, maskSecrets } from './incident.ts';
import { askJev, measureRequest } from './jev.ts';
import { isHarnessIssueTitle } from './state.ts';
import {
  buildIssueOverlapRequest,
  decideOverlap,
  type IssueOverlapMode,
  issueOverlapRecord,
  issueOverlapSettings,
  type IssueOverlapRecord,
  type OpenIssue,
  type OverlapDraft,
  overlapProbabilities,
  selectOverlapCandidates,
} from './issue-overlap.ts';

type Env = Record<string, string | undefined>;

/** 記録の1行 */
export interface OverlapLogLine {
  version: 1;
  at: string;
  status: 'ok' | 'skipped' | 'error';
  detail: string | null;
  record: IssueOverlapRecord | null;
}

/** 出力の提案：duplicateOf があればその Issue へのコメントの案、null なら新しい Issue の下書き */
export interface OverlapSuggestion {
  duplicateOf: number | null;
  source: 'session' | 'jev';
}

export interface OverlapCheckResult {
  line: OverlapLogLine;
  suggestion: OverlapSuggestion;
  sessionDuplicateOf: number | null;
  mode: IssueOverlapMode;
}

/**
 * 1件を Jev に問い、記録に1行足して、提案を返す。ask は差し替えられる（ask を呼ぶのは ok の道だけ）。
 * 提案は enforce で Jev が下限以上と答えたときだけ Jev のもの。ほかはセッションの判断（重なる Issue を作らない側に倒す）。
 */
export async function checkIssueOverlap(
  config: HarnessConfig,
  apiKey: string | undefined,
  session: string,
  draft: OverlapDraft,
  openIssues: OpenIssue[],
  sessionDuplicateOf: number | null,
  env: Env,
  ask: typeof askJev = askJev,
  now: Date = new Date(),
): Promise<OverlapCheckResult> {
  const settings = issueOverlapSettings(config);
  const mode = settings.mode;
  const settle = (status: OverlapLogLine['status'], detail: string | null, record: IssueOverlapRecord | null): OverlapCheckResult => {
    const line: OverlapLogLine = { version: 1, at: now.toISOString(), status, detail, record };
    appendOverlapLog(session, line, env);
    const jevDup = mode === 'enforce' && status === 'ok' ? record?.decision.duplicateOf : null;
    const suggestion: OverlapSuggestion = typeof jevDup === 'number' ? { duplicateOf: jevDup, source: 'jev' } : { duplicateOf: sessionDuplicateOf, source: 'session' };
    return { line, suggestion, sessionDuplicateOf, mode };
  };
  if (config.jev.mode === 'off') return settle('skipped', 'jev.mode=off', null);
  if (settings.mode === 'off') return settle('skipped', 'jev.issueOverlap=off', null);
  if (!apiKey) return settle('skipped', 'JEV_API_KEY が未設定', null);
  const maskedDraft: OverlapDraft = { title: maskSecrets(draft.title), body: draft.body === null ? null : maskSecrets(draft.body) };
  const masked = openIssues.map((i) => ({ ...i, title: maskSecrets(i.title), body: i.body === null ? null : maskSecrets(i.body) }));
  const candidates = selectOverlapCandidates(maskedDraft, masked, (t) => isHarnessIssueTitle(config, t), settings.maxCandidates);
  const built = buildIssueOverlapRequest(config, maskedDraft, candidates);
  if (!built.ask) return settle('skipped', built.reason, null);
  try {
    const res = await ask(apiKey, built.request);
    if (res.status === 'error') return settle('error', maskSecrets(res.detail).slice(0, 300), null);
    const probabilities = overlapProbabilities(res.answers);
    const decision = decideOverlap(settings, probabilities);
    const record = issueOverlapRecord({
      mode,
      model: res.model,
      draftTitle: maskedDraft.title,
      issues: built.issues,
      probabilities,
      decision,
      sessionDuplicateOf,
      size: { ...measureRequest(built.request), inputTokens: res.inputTokens ?? null },
    });
    return settle('ok', null, record);
  } catch (e) {
    return settle('error', maskSecrets(String(e)).slice(0, 300), null);
  }
}

/** 重なりの記録のファイル。セッション ID がファイル名に使えない形なら Error */
export function overlapLogFile(session: string, env: Env): string {
  if (!isValidSession(session)) throw new Error(`セッション ID は英数字と - _ だけ使えます: ${session}`);
  return join(incidentDir(env), `${session}.overlap.jsonl`);
}

/** 1行足す。ディレクトリは 0700、ファイルは 0600 */
export function appendOverlapLog(session: string, line: OverlapLogLine, env: Env): void {
  const file = overlapLogFile(session, env);
  const dir = incidentDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  chmodSync(file, 0o600);
}

/** 記録を読む。ファイルが無ければ空。壊れた行・形の違う行は飛ばす */
export function readOverlapLog(session: string, env: Env): OverlapLogLine[] {
  const file = overlapLogFile(session, env);
  if (!existsSync(file)) return [];
  const out: OverlapLogLine[] = [];
  for (const text of readFileSync(file, 'utf8').split('\n')) {
    if (text.trim() === '') continue;
    try {
      const v = JSON.parse(text) as Partial<OverlapLogLine>;
      if (typeof v.at === 'string' && typeof v.status === 'string' && ['ok', 'skipped', 'error'].includes(v.status)) out.push(v as OverlapLogLine);
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out;
}

/** 重なりの記録があるセッション ID を、更新の新しい順に（*.overlap.jsonl だけ） */
export function listOverlapSessions(env: Env): string[] {
  const dir = incidentDir(env);
  if (!existsSync(dir)) return [];
  const suffix = '.overlap.jsonl';
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix) && isValidSession(f.slice(0, -suffix.length)))
    .map((f) => ({ id: f.slice(0, -suffix.length), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

export interface OverlapStats {
  total: number;
  ok: number;
  agree: number;
  disagree: number;
  skipped: number;
  error: number;
}

/** 集計。ok の行のうち record.agree が true なら agree、それ以外は disagree */
export function overlapStats(lines: OverlapLogLine[]): OverlapStats {
  const out: OverlapStats = { total: lines.length, ok: 0, agree: 0, disagree: 0, skipped: 0, error: 0 };
  for (const l of lines) {
    if (l.status === 'ok') {
      out.ok++;
      if (l.record?.agree === true) out.agree++;
      else out.disagree++;
    } else out[l.status]++;
  }
  return out;
}

/** 出力の文：1行目に セッション・Jev・一致、2行目に提案 */
export function renderOverlapResult(r: OverlapCheckResult): string {
  const { line, suggestion } = r;
  const pct = (p: number): string => `${Math.round(p * 100)}%`;
  const session = r.sessionDuplicateOf === null ? 'なし' : `#${r.sessionDuplicateOf}`;
  let jev: string;
  let agree = '-';
  if (line.status === 'ok' && line.record) {
    const d = line.record.decision;
    if (d.duplicateOf !== null) jev = `#${d.duplicateOf}（${pct(d.probability ?? 0)}）`;
    else {
      const top = line.record.pairs
        .filter((p): p is { issue: number; probability: number } => p.probability !== null)
        .sort((a, b) => b.probability - a.probability)[0];
      jev = top ? `同じ件なし（最高 #${top.issue} ${pct(top.probability)}）` : '同じ件なし';
    }
    agree = line.record.agree === true ? '一致' : line.record.agree === false ? '不一致' : '-';
  } else jev = `${line.status}（${line.detail ?? ''}）`;
  const head = `セッション: ${session} / Jev: ${jev}、${agree}（${r.mode}）`;
  const tail =
    suggestion.duplicateOf === null
      ? '提案: 新しい Issue の下書きにする'
      : `提案: #${suggestion.duplicateOf} へのコメントの案にする（根拠: ${suggestion.source}）`;
  return `${head}\n${tail}`;
}
