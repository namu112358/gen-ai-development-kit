/**
 * hq の控え（hq-fleets.json）と、hq がいない間の fleet の質問の控えを、git の共通ディレクトリの下に置く（Issue #409）。
 *
 *   node harness/scripts/hq-state.ts path [--common-dir <dir>]
 *   node harness/scripts/hq-state.ts ledger [--common-dir <dir>]
 *   node harness/scripts/hq-state.ts ledger-save <file> [--common-dir <dir>]
 *   node harness/scripts/hq-state.ts pending (--session <ID> | --all) [--common-dir <dir>]
 *   node harness/scripts/hq-state.ts pending-add --session <ID> --issue <n> --stage <段階> --question <質問> --option <おすすめ> [--option <ほか>...] [--message-id <id>]
 *   node harness/scripts/hq-state.ts pending-answer --session <ID> --issue <n> --answer <人の答え>
 *   node harness/scripts/hq-state.ts pending-remove --session <ID> --issue <n>
 *   node harness/scripts/hq-state.ts heartbeat-save --theme <テーマ> --note <一言>（fleet の heartbeat の一言。ログのペインが読む。#438）
 *   node harness/scripts/hq-state.ts start-failure-save --dispatch <ID> --theme <テーマ> --stage <Orca の stage> --screen-file <worker-read の JSON> [--resent accepted|unobserved|none]（起動の失敗の画面。#551）
 *   node harness/scripts/hq-state.ts start-failures
 *
 * - 置き場所は `git rev-parse --path-format=absolute --git-common-dir` の下の agent-harness/hq/（本体・fleet のワークスペース・
 *   Issue の worktree から同じ場所。作業ツリーの外で commit されない）。hq の控えは hq-fleets.json、fleet の控えは pending/<セッション ID>.json。
 * - 書き換えの場所の見張りの hook は .git の中への Write を止めるので、hq・fleet は Write で直接書かずにこのスクリプトで書く。
 * - 書くときは一時ファイルに書いてから名前を変える。CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TRANSCRIPT_SESSION_ID } from '../lib/session.ts';

export const HQ_STATE_COMMANDS: readonly string[] = ['path', 'ledger', 'ledger-save', 'pending', 'pending-add', 'pending-answer', 'pending-remove', 'heartbeat-save', 'start-failure-save', 'start-failures'];

export function hqStateDir(commonDir: string): string {
  return join(commonDir, 'agent-harness', 'hq');
}

export function ledgerPath(commonDir: string): string {
  return join(hqStateDir(commonDir), 'hq-fleets.json');
}

export const HEARTBEAT_FILE = 'hq-heartbeat.json';

export function heartbeatPath(commonDir: string): string {
  return join(hqStateDir(commonDir), HEARTBEAT_FILE);
}

export const START_FAILURES_FILE = 'hq-start-failures.json';

export function startFailuresPath(commonDir: string): string {
  return join(hqStateDir(commonDir), START_FAILURES_FILE);
}

export function pendingDir(commonDir: string): string {
  return join(hqStateDir(commonDir), 'pending');
}

/** fleet の控えの置き場所。セッション ID はファイル名に使える形だけを受け付ける */
export function pendingPath(commonDir: string, session: string): string {
  if (!TRANSCRIPT_SESSION_ID.test(session)) throw new Error(`セッション ID の形が違います：${session}`);
  return join(pendingDir(commonDir), `${session}.json`);
}

/** hq の控え。手順8の見回しで聞いたもの・Epic の子の一覧など、ほかのキーもそのまま残す */
export interface HqLedger {
  version: 1;
  runId: string | null;
  hqHandle: string | null;
  hqSession: string | null;
  paneHandles: string[];
  fleets: Record<string, unknown>[];
  updatedAt: string | null;
  [key: string]: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** 控えを読む。形が違えば null */
export function parseLedger(v: unknown): HqLedger | null {
  if (!isObj(v) || v.version !== 1) return null;
  if (!strOrNull(v.runId) || !strOrNull(v.hqHandle) || !strOrNull(v.hqSession)) return null;
  if (!Array.isArray(v.paneHandles) || !v.paneHandles.every((h) => typeof h === 'string')) return null;
  if (!Array.isArray(v.fleets) || !v.fleets.every(isObj)) return null;
  const updatedAt = v.updatedAt === undefined ? null : v.updatedAt;
  if (!strOrNull(updatedAt)) return null;
  return { ...v, version: 1, runId: v.runId, hqHandle: v.hqHandle, hqSession: v.hqSession, paneHandles: v.paneHandles as string[], fleets: v.fleets as Record<string, unknown>[], updatedAt };
}

/** hq がいない間に fleet が控えた質問1つ */
export interface PendingQuestion {
  issue: number;
  stage: string;
  question: string;
  options: string[];
  /** hq に ask したときの message_id（hq が戻ったら --resume で待ち直す）。ask していなければ null */
  messageId: string | null;
  askedAt: string;
  /** 人が fleet のタブで答えたもの（人の言葉のまま）。まだなら null */
  answer: string | null;
  answeredAt: string | null;
}

export interface PendingFile {
  version: 1;
  session: string;
  questions: PendingQuestion[];
}

function parseQuestion(v: unknown): PendingQuestion | null {
  if (!isObj(v)) return null;
  const { issue, stage, question, options, messageId, askedAt, answer, answeredAt } = v;
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue <= 0) return null;
  if (typeof stage !== 'string' || typeof question !== 'string' || typeof askedAt !== 'string') return null;
  if (!Array.isArray(options) || !options.every((o) => typeof o === 'string')) return null;
  if (!strOrNull(messageId) || !strOrNull(answer) || !strOrNull(answeredAt)) return null;
  return { issue, stage, question, options: options as string[], messageId, askedAt, answer, answeredAt };
}

/** fleet の控えを読む。形が違えば null */
export function parsePending(v: unknown): PendingFile | null {
  if (!isObj(v) || v.version !== 1 || typeof v.session !== 'string' || !Array.isArray(v.questions)) return null;
  const questions = v.questions.map(parseQuestion);
  if (questions.some((q) => q === null)) return null;
  return { version: 1, session: v.session, questions: questions as PendingQuestion[] };
}

const empty = (session: string): PendingFile => ({ version: 1, session, questions: [] });

/** 質問を足す。同じ Issue の質問は置き換える（答えは消える） */
export function addPending(
  file: PendingFile | null,
  session: string,
  q: { issue: number; stage: string; question: string; options: string[]; messageId: string | null },
  now: string,
): PendingFile {
  const base = file ?? empty(session);
  const next: PendingQuestion = { issue: q.issue, stage: q.stage, question: q.question, options: [...q.options], messageId: q.messageId, askedAt: now, answer: null, answeredAt: null };
  return { version: 1, session: base.session, questions: [...base.questions.filter((x) => x.issue !== q.issue), next] };
}

/** 人の答えを書く。その Issue の質問が無ければ投げる */
export function answerPending(file: PendingFile | null, issue: number, answer: string, now: string): PendingFile {
  if (!file || !file.questions.some((q) => q.issue === issue)) throw new Error(`#${issue} の質問は控えにありません`);
  return { ...file, questions: file.questions.map((q) => (q.issue === issue ? { ...q, answer, answeredAt: now } : { ...q })) };
}

/** 質問を外す（hq に上げ直した・続きを進めた）。無ければそのまま */
export function removePending(file: PendingFile | null, session: string, issue: number): PendingFile {
  const base = file ?? empty(session);
  return { ...base, questions: base.questions.filter((q) => q.issue !== issue) };
}

export const PENDING_HEADING = 'hq がいない間の質問（fleet のタブで答える）';

/** 「あなたがすること」のペインの先頭に出す行。答えの無い質問が無ければ空 */
export function renderPending(file: PendingFile | null): string[] {
  const open = (file?.questions ?? []).filter((q) => q.answer === null);
  if (open.length === 0) return [];
  const out = [PENDING_HEADING];
  for (const q of open) {
    out.push(`- #${q.issue}（${q.stage}）：${q.question}`);
    if (q.options.length > 0) out.push(`  選択肢：${q.options.map((o, i) => (i === 0 ? `${o}（おすすめ）` : o)).join(' / ')}`);
  }
  return out;
}

/** fleet の heartbeat の一言1つ（テーマごとに最新の1件） */
export interface HeartbeatNote {
  theme: string;
  note: string;
  at: string;
}

export interface HeartbeatFile {
  version: 1;
  notes: HeartbeatNote[];
}

/** heartbeat の控えを読む。形が違えば null */
export function parseHeartbeat(v: unknown): HeartbeatFile | null {
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.notes)) return null;
  const notes: HeartbeatNote[] = [];
  for (const n of v.notes) {
    if (!isObj(n) || typeof n.theme !== 'string' || typeof n.note !== 'string' || typeof n.at !== 'string') return null;
    notes.push({ theme: n.theme, note: n.note, at: n.at });
  }
  return { version: 1, notes };
}

/** 一言を控える。同じテーマの前の一言は置き換える。改行・連続する空白は1つの空白にする */
export function recordHeartbeat(file: HeartbeatFile | null, theme: string, note: string, now: string): HeartbeatFile {
  const kept = (file?.notes ?? []).filter((n) => n.theme !== theme);
  return { version: 1, notes: [...kept, { theme, note: note.replace(/\s+/g, ' ').trim(), at: now }] };
}

/** 今の控えのテーマにあり、staleMinutes 分以内の一言だけを、新しい順に返す */
export function freshHeartbeats(file: HeartbeatFile | null, themes: readonly string[], now: number, staleMinutes: number): HeartbeatNote[] {
  if (!file) return [];
  return file.notes
    .map((n) => ({ n, t: Date.parse(n.at) }))
    .filter(({ n, t }) => themes.includes(n.theme) && !Number.isNaN(t) && now - t <= staleMinutes * 60000)
    .sort((a, b) => b.t - a.t)
    .map(({ n }) => n);
}

/** 起動の失敗1件（Dispatch ごとに最新の1件）。画面は worker-read の末尾 */
export interface StartFailure {
  dispatch: string;
  theme: string;
  stage: string;
  screen: string[];
  hasDraft: boolean;
  resent: 'accepted' | 'unobserved' | 'none' | null;
  at: string;
}

export interface StartFailuresFile {
  version: 1;
  failures: StartFailure[];
}

const SCREEN_LINES = 50;
const MAX_START_FAILURES = 20;
const RESENT_VALUES: readonly string[] = ['accepted', 'unobserved', 'none'];

/** 起動の失敗の控えを読む。形が違えば null */
export function parseStartFailures(v: unknown): StartFailuresFile | null {
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.failures)) return null;
  const failures: StartFailure[] = [];
  for (const f of v.failures) {
    if (!isObj(f) || typeof f.dispatch !== 'string' || typeof f.theme !== 'string' || typeof f.stage !== 'string' || typeof f.at !== 'string') return null;
    if (!Array.isArray(f.screen) || !f.screen.every((l) => typeof l === 'string') || typeof f.hasDraft !== 'boolean') return null;
    if (f.resent !== null && !(typeof f.resent === 'string' && RESENT_VALUES.includes(f.resent))) return null;
    failures.push({ dispatch: f.dispatch, theme: f.theme, stage: f.stage, screen: f.screen as string[], hasDraft: f.hasDraft, resent: f.resent as StartFailure['resent'], at: f.at });
  }
  return { version: 1, failures };
}

/** worker-read --json の中身（または生の画面）から、画面の末尾 50 行と、入力欄に文が残っているかを取り出す */
export function parseScreen(raw: string): { screen: string[]; hasDraft: boolean } {
  try {
    const term = (JSON.parse(raw) as { result?: { terminal?: { tail?: unknown; draft?: unknown } } } | null)?.result?.terminal;
    if (term && Array.isArray(term.tail) && term.tail.every((l) => typeof l === 'string')) {
      return { screen: (term.tail as string[]).slice(-SCREEN_LINES), hasDraft: typeof term.draft === 'string' && term.draft !== '' };
    }
  } catch {
    // JSON でなければ生の画面として扱う
  }
  return { screen: raw.replace(/\r\n/g, '\n').split('\n').slice(-SCREEN_LINES), hasDraft: false };
}

/** 起動の失敗を控える。同じ Dispatch の前の件は置き換え、新しい 20 件まで */
export function recordStartFailure(file: StartFailuresFile | null, entry: Omit<StartFailure, 'at'>, now: string): StartFailuresFile {
  const kept = (file?.failures ?? []).filter((f) => f.dispatch !== entry.dispatch);
  return { version: 1, failures: [...kept, { ...entry, at: now }].slice(-MAX_START_FAILURES) };
}

// ---- ファイル（CLI と panes.ts が使う） ----

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 一時ファイルに書いてから名前を変える（読む側が書きかけを読まない） */
function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  renameSync(tmp, path);
}

export const readLedgerFile = (commonDir: string): HqLedger | null => parseLedger(readJson(ledgerPath(commonDir)));
export const readHeartbeatAt = (path: string): HeartbeatFile | null => parseHeartbeat(readJson(path));
export const readStartFailuresAt = (path: string): StartFailuresFile | null => parseStartFailures(readJson(path));
export const readPendingFile = (commonDir: string, session: string): PendingFile | null => parsePending(readJson(pendingPath(commonDir, session)));

/** git の共通ディレクトリ。取れなければ null */
export function gitCommonDir(cwd: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  const out = r.status === 0 ? (r.stdout ?? '').trim() : '';
  return out ? out : null;
}

// ---- CLI（import.meta.main の中だけで動く） ----

interface CliArgs {
  positional: string[];
  commonDir: string | null;
  session: string | null;
  all: boolean;
  issue: number | null;
  stage: string | null;
  question: string | null;
  options: string[];
  messageId: string | null;
  answer: string | null;
  theme: string | null;
  note: string | null;
  dispatch: string | null;
  screenFile: string | null;
  resent: StartFailure['resent'];
}

class UsageError extends Error {}

function parseCli(args: string[]): CliArgs {
  const out: CliArgs = { positional: [], commonDir: null, session: null, all: false, issue: null, stage: null, question: null, options: [], messageId: null, answer: null, theme: null, note: null, dispatch: null, screenFile: null, resent: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${a} に値がありません`);
      return v;
    };
    if (a === '--common-dir') out.commonDir = value();
    else if (a === '--session') out.session = value();
    else if (a === '--all') out.all = true;
    else if (a === '--issue') {
      const v = value();
      if (!/^\d+$/.test(v) || Number(v) <= 0) throw new UsageError(`--issue は正の整数です：${v}`);
      out.issue = Number(v);
    } else if (a === '--stage') out.stage = value();
    else if (a === '--question') out.question = value();
    else if (a === '--option') out.options.push(value());
    else if (a === '--message-id') out.messageId = value();
    else if (a === '--answer') out.answer = value();
    else if (a === '--theme') out.theme = value();
    else if (a === '--note') out.note = value();
    else if (a === '--dispatch') out.dispatch = value();
    else if (a === '--screen-file') out.screenFile = value();
    else if (a === '--resent') {
      const v = value();
      if (!RESENT_VALUES.includes(v)) throw new UsageError(`--resent は accepted・unobserved・none のどれかです：${v}`);
      out.resent = v as StartFailure['resent'];
    }
    else if (a.startsWith('--')) throw new UsageError(`知らない引数：${a}`);
    else out.positional.push(a);
  }
  return out;
}

const USAGE = `hq-state.ts ${HQ_STATE_COMMANDS.join('|')} [--common-dir <dir>]（使い方はファイルの先頭のコメント）`;

function main(argv: string[]): void {
  const [mode, ...rest] = argv;
  if (!mode || !HQ_STATE_COMMANDS.includes(mode)) throw new UsageError(USAGE);
  const args = parseCli(rest);
  const commonDir = args.commonDir ?? gitCommonDir(process.cwd());
  if (!commonDir) throw new Error('git の共通ディレクトリが分かりません（git の作業ツリーの中で走らせるか、--common-dir を渡してください）');
  const print = (v: unknown): void => console.log(JSON.stringify(v, null, 2));
  const need = <T>(v: T | null, name: string): T => {
    if (v === null) throw new UsageError(`${name} を渡してください（${USAGE}）`);
    return v;
  };

  if (mode === 'path') return print({ dir: hqStateDir(commonDir), ledger: ledgerPath(commonDir), pendingDir: pendingDir(commonDir) });
  if (mode === 'ledger') return print(readLedgerFile(commonDir));
  if (mode === 'ledger-save') {
    const file = need(args.positional[0] ?? null, '控えの JSON のファイル');
    const ledger = parseLedger(readJson(file));
    if (!ledger) throw new UsageError(`控えの形が違います（version 1・runId・hqHandle・hqSession・paneHandles・fleets）：${file}`);
    const saved: HqLedger = { ...ledger, updatedAt: new Date().toISOString() };
    writeJson(ledgerPath(commonDir), saved);
    return print(saved);
  }
  if (mode === 'heartbeat-save') {
    const theme = need(args.theme, '--theme').trim();
    const note = need(args.note, '--note').trim();
    if (!theme || !note) throw new UsageError('--theme と --note は空にできません');
    const path = heartbeatPath(commonDir);
    const saved = recordHeartbeat(readHeartbeatAt(path), theme, note, new Date().toISOString());
    writeJson(path, saved);
    return print(saved);
  }
  if (mode === 'start-failure-save') {
    const dispatch = need(args.dispatch, '--dispatch').trim();
    const theme = need(args.theme, '--theme').trim();
    const stage = need(args.stage, '--stage').trim();
    const screenFile = need(args.screenFile, '--screen-file');
    if (!dispatch || !theme || !stage) throw new UsageError('--dispatch・--theme・--stage は空にできません');
    const { screen, hasDraft } = parseScreen(readFileSync(screenFile, 'utf8'));
    const path = startFailuresPath(commonDir);
    const saved = recordStartFailure(readStartFailuresAt(path), { dispatch, theme, stage, screen, hasDraft, resent: args.resent }, new Date().toISOString());
    writeJson(path, saved);
    return print(saved);
  }
  if (mode === 'start-failures') return print(readStartFailuresAt(startFailuresPath(commonDir)));
  if (mode === 'pending') {
    if (args.all) {
      const dir = pendingDir(commonDir);
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
      return print(files.map((f) => parsePending(readJson(join(dir, f)))).filter((p): p is PendingFile => p !== null));
    }
    return print(readPendingFile(commonDir, need(args.session, '--session か --all')));
  }
  const session = need(args.session, '--session');
  const issue = need(args.issue, '--issue');
  const path = pendingPath(commonDir, session);
  const current = readPendingFile(commonDir, session);
  const now = new Date().toISOString();
  let next: PendingFile;
  if (mode === 'pending-add') {
    if (args.options.length === 0) throw new UsageError('--option を1つ以上渡してください（おすすめを先頭）');
    next = addPending(current, session, { issue, stage: need(args.stage, '--stage'), question: need(args.question, '--question'), options: args.options, messageId: args.messageId }, now);
  } else if (mode === 'pending-answer') {
    try {
      next = answerPending(current, issue, need(args.answer, '--answer'), now);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  } else next = removePending(current, session, issue);
  writeJson(path, next);
  print(next);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(e instanceof UsageError ? 1 : 2);
  }
}
