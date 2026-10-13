/**
 * 読み込みの記録：付き添いのセッションが始めたときに読み込んだハーネスのファイル（CLAUDE.md・規則・担当の定義・skill・settings）の版を、
 * セッションごとに記録し、今の origin の既定ブランチの版と比べて「このセッションの読み込みは古い」かを決める（Issue #199）。
 * 記録は SessionStart の hook（.claude/hooks/session-env.ts）が書き、agent.ts（harness-drift・claim・fleet-status・step）が読む。
 * 置き場所は git の共通ディレクトリの下の `agent-harness/loaded/<セッションの ID>.json`（段階のファイルと同じ流儀。worktree からも同じ場所で、commit されない）。
 * 比べ方は記録の版（L）・origin の版（O）・記録の HEAD と origin の merge-base の版（M）の3つ。ブランチが自分で変えたファイルは、origin もその後に変えたときだけ古いとする。
 * origin で違うファイルのうち、猶予を置かないファイル（NO_GRACE_PATHS）以外は、まだ読み込んでいない一番古い変更から猶予の時間（既定 6 時間）を過ぎるまで古いとしない（Issue #812）。
 * 書式は harness/docs/formats.md の「読み込みの記録」。GitHub は呼ばない（git だけ）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionFilePath, writeLocalFileOnce } from './local-state.ts';

/** 記録するハーネスのファイル。`/` で終わるものはその下の全部 */
export const HARNESS_PATHS: readonly string[] = ['CLAUDE.md', 'harness/CLAUDE.harness.md', '.claude/agents/', '.claude/skills/', '.claude/settings.json'];

/** パス（リポジトリの一番上からの `/` 区切り）が記録の対象か */
export function isHarnessPath(path: string): boolean {
  return HARNESS_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/** ファイルの版：改行コードを LF にそろえた中身の sha256（Windows の checkout の CRLF で古いと誤って出ないように） */
export function contentVersion(content: string | Uint8Array): string {
  const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
}

/** 読み込みの記録 */
export interface LoadedRecord {
  version: 1;
  session: string;
  /** 記録した時刻（ISO 8601） */
  at: string;
  /** SessionStart の source（startup・resume・clear・compact）。無ければ null */
  source: string | null;
  /** 記録したときの作業ツリーの HEAD の commit。読めなければ null */
  head: string | null;
  /** パス → 版 */
  files: Record<string, string>;
}

/** 読み込みの記録のパス。ID が記録のファイル名に使える形でなければ null（書かない・読まない） */
export function loadedRecordPath(gitCommonDir: string, session: string | null): string | null {
  return sessionFilePath(gitCommonDir, 'loaded', session);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 読み込みの記録を読む。無い・JSON として読めない・書式が違えば null（判断しない） */
export function readLoadedRecord(path: string): LoadedRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(v) || v.version !== 1 || typeof v.session !== 'string' || typeof v.at !== 'string') return null;
  if (v.source !== null && typeof v.source !== 'string') return null;
  if (v.head !== null && typeof v.head !== 'string') return null;
  if (!isObject(v.files) || !Object.values(v.files).every((x) => typeof x === 'string')) return null;
  return v as unknown as LoadedRecord;
}

/** 読み込みの記録を書く。同じパスが既にあれば書かず false（resume・compact で上書きして「新しい」に見せない） */
export function writeLoadedRecordOnce(path: string, record: LoadedRecord): boolean {
  try {
    return writeLocalFileOnce(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[], input?: string): { ok: boolean; stdout: Buffer } {
  const r = spawnSync('git', args, { cwd, input, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: (r.stdout as Buffer | null) ?? Buffer.alloc(0) };
}

/** 作業ツリーのディスクの中身の版（git が追跡している対象のファイルだけ）。git が失敗すれば null */
export function harnessVersionsOnDisk(cwd: string): Record<string, string> | null {
  const r = git(cwd, ['ls-files', '-z', '--', ...HARNESS_PATHS]);
  if (!r.ok) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const root = top.stdout.toString('utf8').trim();
  const out: Record<string, string> = {};
  for (const path of r.stdout.toString('utf8').split('\0').filter((p) => p !== '' && isHarnessPath(p))) {
    try {
      out[path] = contentVersion(readFileSync(join(root, path)));
    } catch {
      // 消したが索引に残るファイルは「無い」として扱う
    }
  }
  return out;
}

/** ref（origin/<既定ブランチ>・commit など）の中身の版。ref が無い・git が失敗すれば null */
export function harnessVersionsAt(cwd: string, ref: string): Record<string, string> | null {
  const ls = git(cwd, ['ls-tree', '-r', '-z', ref, '--', ...HARNESS_PATHS]);
  if (!ls.ok) return null;
  const entries: { path: string; oid: string }[] = [];
  for (const line of ls.stdout.toString('utf8').split('\0')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m && isHarnessPath(m[2]!)) entries.push({ oid: m[1]!, path: m[2]! });
  }
  if (entries.length === 0) return {};
  const cat = git(cwd, ['cat-file', '--batch'], entries.map((e) => `${e.oid}\n`).join(''));
  if (!cat.ok) return null;
  const out: Record<string, string> = {};
  const buf = cat.stdout;
  let pos = 0;
  for (const e of entries) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) return null;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isInteger(size)) return null;
    out[e.path] = contentVersion(buf.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return out;
}

/** 比べるときに飛ばすファイル：`.claude/skills/`・`.claude/agents/` の下の README.md（セッションが読み込まない。記録には残る） */
function ignoredInCompare(path: string): boolean {
  return (path.startsWith('.claude/skills/') || path.startsWith('.claude/agents/')) && path.split('/').pop() === 'README.md';
}

/**
 * 猶予を置かないファイル（`/` か `-` で終わるものは前方一致）：規則・settings と判定の担当（reviewer・risk-agent・review-* の agent、judge・review-panel の skill）。
 * 判定の担当を入れるのは、judge だけが止まって交代が起きない場面を作らないため（Issue #812）
 */
export const NO_GRACE_PATHS: readonly string[] = [
  'harness/CLAUDE.harness.md',
  '.claude/settings.json',
  '.claude/agents/reviewer.md',
  '.claude/agents/risk-agent.md',
  '.claude/agents/review-',
  '.claude/skills/judge/',
  '.claude/skills/review-panel/',
];

/** 猶予の時間の既定（harness.config.json の harnessDrift.graceHours が無いとき） */
export const DEFAULT_GRACE_HOURS = 6;

function noGrace(path: string): boolean {
  return NO_GRACE_PATHS.some((p) => (p.endsWith('/') || p.endsWith('-') ? path.startsWith(p) : path === p));
}

/** 比べた結果 */
export interface DriftResult {
  stale: boolean;
  /** 記録と origin の両方にあり、中身が違って古いもの */
  changed: string[];
  /** origin にだけあって古いもの */
  added: string[];
  /** 記録にだけあって古いもの */
  removed: string[];
}

/**
 * 記録の版（loaded）と origin の版を、merge-base の版（無ければ null）を基準に比べる。無いファイルは「無い」という版として比べる。
 * L と O が同じなら古くない。違うとき、M が無ければ古い。L と M が同じ（ブランチが変えていない）なら origin が変えたので古い。
 * L と M が違う（ブランチ・未 commit で自分で変えた）なら、O と M が違う（origin もその後に変えた）ときだけ古い。
 */
export function compareHarness(loaded: Record<string, string>, origin: Record<string, string>, mergeBase: Record<string, string> | null): DriftResult {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const paths = [...new Set([...Object.keys(loaded), ...Object.keys(origin)])].sort();
  for (const path of paths) {
    if (ignoredInCompare(path)) continue;
    const l = loaded[path];
    const o = origin[path];
    if (l === o) continue;
    if (mergeBase !== null) {
      const m = mergeBase[path];
      if (l !== m && o === m) continue;
    }
    if (l !== undefined && o !== undefined) changed.push(path);
    else if (o !== undefined) added.push(path);
    else removed.push(path);
  }
  return { stale: changed.length + added.length + removed.length > 0, changed, added, removed };
}

/**
 * from（記録の HEAD）から ref（origin の既定ブランチ）までの commit で、パスごとに最初に触れた commit の committer の時刻（Unix 秒）。
 * from が null・paths が空・git が失敗すれば null（時刻が分からない）。log に出ないパスは入らない
 */
export function firstChangeTimes(cwd: string, from: string | null, ref: string, paths: string[]): Record<string, number> | null {
  if (from === null || paths.length === 0) return null;
  const r = git(cwd, ['log', '--reverse', '--format=%x01%ct', '--name-only', `${from}..${ref}`, '--', ...paths]);
  if (!r.ok) return null;
  const wanted = new Set(paths);
  const out: Record<string, number> = {};
  let time: number | null = null;
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (line.startsWith('\x01')) {
      time = Number(line.slice(1));
      continue;
    }
    if (time !== null && Number.isFinite(time) && wanted.has(line) && !(line in out)) out[line] = time;
  }
  return out;
}

/** 猶予を置いて決め直した結果 */
export interface DriftAssessment extends DriftResult {
  /** 違うが猶予の内のファイル */
  pending: string[];
  graceHours: number;
  /** pending の一番古い変更 + 猶予の時刻（ISO 8601）。pending が空なら null */
  pendingUntil: string | null;
}

/**
 * compareHarness の結果の stale を、猶予を置いて決め直す（changed・added・removed はそのまま）。
 * 猶予を置かないファイルの違い、猶予を過ぎた違い、時刻が分からない違い（times が null か、times にパスが無い）があれば古い。
 * 猶予の内の違いだけなら古くなく、pending に並べる。graceHours が 0 なら違いがあれば古い（猶予なし）
 */
export function assessDrift(raw: DriftResult, times: Record<string, number> | null, nowMs: number, graceHours: number): DriftAssessment {
  const graceMs = graceHours * 3600 * 1000;
  const pending: string[] = [];
  let stale = false;
  let oldest: number | null = null;
  for (const path of [...raw.changed, ...raw.added, ...raw.removed]) {
    const t = times?.[path];
    if (noGrace(path) || t === undefined) {
      stale = true;
      continue;
    }
    const ms = t * 1000;
    if (nowMs - ms >= graceMs) {
      stale = true;
      continue;
    }
    pending.push(path);
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return { ...raw, stale, pending, graceHours, pendingUntil: oldest === null ? null : new Date(oldest + graceMs).toISOString() };
}

/** fleet-status の表の下・claim の標準エラーに足す1行。古いときは交代の文、猶予の内の違いだけなら知らせる文。判断しない（null）・違いが無いときは '' */
export function driftLine(result: (DriftResult & { pending?: string[]; pendingUntil?: string | null }) | null): string {
  if (result && !result.stale && result.pending && result.pending.length > 0) {
    const until = result.pendingUntil ? `${result.pendingUntil} を過ぎたら` : '猶予を過ぎたら';
    return `origin でハーネスのファイル ${result.pending.length} 件が変わったが猶予の内（${until}段階の切れ目で交代する）`;
  }
  if (!result?.stale) return '';
  const paths = [...result.changed, ...result.added, ...result.removed];
  const head = paths.slice(0, 3).join('、');
  const more = paths.length > 3 ? ` ほか ${paths.length - 3} 件` : '';
  return `このセッションの読み込みは古い（origin で ${paths.length} 件変わった：${head}${more}）。段階の切れ目で交代する（ship・fleet の SKILL.md の「ハーネスが更新されたときの交代」）`;
}

/** judge を古いセッションで始めないための止める文。段階が judge で古いときだけ。ほかは null */
export function judgeBlock(stage: string | undefined, result: DriftResult | null): string | null {
  if (stage !== 'judge' || !result?.stale) return null;
  const n = result.changed.length + result.added.length + result.removed.length;
  return `このセッションの読み込みが古い（ハーネスのファイル ${n} 件が origin で変わった）ので、judge を始めません。担当の定義が古いまま判定しないため。段階の切れ目で新しいセッションに交代してください（手順は ship・fleet の SKILL.md の「ハーネスが更新されたときの交代」）`;
}
