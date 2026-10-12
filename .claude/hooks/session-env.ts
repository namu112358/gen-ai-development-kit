/**
 * 付き添いのセッションの SessionStart の hook。.claude/settings.json で matcher なしに登録し、startup・resume・clear・compact のすべてで動く。
 *
 * stdin の JSON の session_id を、CLAUDE_ENV_FILE に `export AGENT_HARNESS_SESSION=<id>` として書く。
 * 以降の Bash で harness/scripts/agent.ts がこの値を読み、着手宣言とコメントの目印に今のセッションの ID を入れる（Issue #157）。
 * /clear などで ID が変わると、自分の古い着手宣言はほかのセッションのものに見える（人に確かめて claim --takeover）。
 * session_id が無い・CLAUDE_ENV_FILE が無い・JSON が読めない・ID に英数字と - _ 以外が入るときは何も書かない。どの場合も exit 0。
 * ID の形の規則は harness/lib/session.ts の TRANSCRIPT_SESSION_ID だけにある（記録の選択と同じもの）。読めなければ何も書かない。
 *
 * startup のとき、Orca の CLI が無ければ、JSON の systemMessage と additionalContext で一言知らせる（Issue #195。docs/setup.md の節11）。
 * 探し方と文面は環境で変える（Issue #311）。Windows ネイティブは `;` 区切りの PATH の orca（PATHEXT の拡張子付き）、WSL・Linux は
 * ORCA_CLI_COMMAND か `:` 区切りの PATH の orca-ide を探す。CLI は実行せず、ファイルがあるかだけを見る。素の orca は Linux で
 * 読み上げソフトを起動しうるので、Windows のほかでは探さない。Routine（CLAUDE_CODE_REMOTE_SESSION_ID がある）では知らせない。
 * bypass permissions で始まったことは知らせない（SessionStart の入力に permission_mode が渡る保証が無い。bypass は
 * .claude/settings.json の permissions.disableBypassPermissionsMode で拒む）。
 *
 * 読み込みの記録（Issue #199）：CLAUDE_PROJECT_DIR があるときだけ、セッションが読み込んだハーネスのファイル（CLAUDE.md・規則・担当の定義・skill・settings）の
 * ディスクの中身の版と HEAD を、git の共通ディレクトリの下の agent-harness/loaded/<セッションの ID>.json に書く（harness/lib/harness-drift.ts）。
 * 版と HEAD は入力の cwd の作業ツリーの一番上から読む（Issue #843。desktop アプリの worktree のセッションでは CLAUDE_PROJECT_DIR が本体の checkout を指す）。
 * cwd が無い・git の外・共通ディレクトリが CLAUDE_PROJECT_DIR と違うときは CLAUDE_PROJECT_DIR から読む。記録の置き場所は CLAUDE_PROJECT_DIR の共通ディレクトリ。
 * 同じ ID の記録が既にあれば書かない（resume・compact で上書きしない。/clear は ID が変わるので新しい記録）。CLAUDE_PROJECT_DIR が無い・
 * ID が不正・git が失敗するときは書かない。どの場合もセッションの開始を止めない。agent.ts harness-drift・fleet-status・claim・step がこれを origin と比べる。
 *
 * 片付け（Issue #654）：読み込みの記録の後に、手元の状態のファイル（git の共通ディレクトリの下の agent-harness/）の古いものを消す。
 * loaded・watch・stage の <ID>.json のうち、最後に書かれてから30日より前のものを消す（Claude Code は既定（cleanupPeriodDays）で30日より前の
 * セッションの記録を消し resume できなくなるので、30日より前に最後に書かれたセッションのファイルはもう使われないとみなす）。
 * 自分の ID のファイルと、stage か watch が30日以内に書かれている ID の loaded は残す。loaded・watch・stage・hq の直下で、60分より前の *.tmp も消す
 * （書き込み途中の残り。hq の .json と hq/pending/ の中は消さない）。CLAUDE_PROJECT_DIR が無い・session_id が形に合わない・
 * 共通ディレクトリが取れない・lib が読めないときは何も消さない。消し損ねたファイルは飛ばす。どの場合もセッションの開始を止めない。
 *
 * 前提の確かめの知らせ（Issue #834。docs/setup.md の節11）：source が startup で、CLAUDE_PROJECT_DIR があり、Routine（CLAUDE_CODE_REMOTE_SESSION_ID）でなく、
 * AGENT_HARNESS_SESSION_DOCTOR=0 で止められていないときだけ、harness/scripts/session-doctor.ts を読み込んで足りないものを1行ずつ知らせる。
 * 行は Orca の知らせと1つの JSON にまとめ（Orca の知らせを出したときは確かめの Orca の行を重ねない）、直すのは人だと添える。env と作業場所は
 * CLAUDE_PROJECT_DIR に合わせる。読み込み・確かめの失敗は行が無いだけで、どの場合も exit 0。設定は変えず、fetch もしない。
 */
import { spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** ID の形（harness/lib/session.ts）。lib が欠けていても exit 0 で終わるよう、try の中で読む */
let idShape: RegExp | null = null;
try {
  ({ TRANSCRIPT_SESSION_ID: idShape } = await import('../../harness/lib/session.ts'));
} catch {
  idShape = null;
}

/** 読み込みの記録（harness/lib/harness-drift.ts）。lib が欠けていても exit 0 で終わるよう、try の中で読む */
let drift: typeof import('../../harness/lib/harness-drift.ts') | null = null;
try {
  drift = await import('../../harness/lib/harness-drift.ts');
} catch {
  drift = null;
}

/** 手元の状態のファイルの場所（harness/lib/local-state.ts）。lib が欠けていても exit 0 で終わるよう、try の中で読む */
let localState: typeof import('../../harness/lib/local-state.ts') | null = null;
try {
  localState = await import('../../harness/lib/local-state.ts');
} catch {
  localState = null;
}

/** CLAUDE_ENV_FILE に書く行（書かないなら null）。シェルに渡すので、ID は英数字と - _ だけを受け付ける */
export function envLine(raw: string): string | null {
  if (!idShape) return null;
  let id: unknown;
  try {
    id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
  } catch {
    return null;
  }
  return typeof id === 'string' && idShape.test(id) ? `export AGENT_HARNESS_SESSION=${id}\n` : null;
}

export interface OrcaNotice {
  systemMessage: string;
  hookSpecificOutput: { hookEventName: 'SessionStart'; additionalContext: string };
}

/** Orca の CLI を探す環境。other（macOS など）は Linux と同じ探し方で、文面に環境の名前を入れない */
export type OrcaEnvironment = 'windows' | 'wsl' | 'linux' | 'other';

/** 環境の判定。WSL は Linux のうち、WSL が入れる環境変数（WSL_DISTRO_NAME・WSL_INTEROP）があるもの */
export function orcaEnvironment(platform: string, env: Record<string, string | undefined>): OrcaEnvironment {
  if (platform === 'win32') return 'windows';
  if (platform !== 'linux') return 'other';
  return env.WSL_DISTRO_NAME || env.WSL_INTEROP ? 'wsl' : 'linux';
}

/** 環境ごとの「見つからない」の一文（systemMessage と additionalContext の頭） */
const ORCA_MISSING: Record<OrcaEnvironment, string> = {
  windows: 'Windows で Orca の CLI（ORCA_CLI_COMMAND・PATH の orca）が見つかりません。ORCA_CLI_COMMAND で CLI を指定できます。',
  wsl: 'WSL で Orca の CLI（ORCA_CLI_COMMAND・PATH の orca-ide）が見つかりません。Orca が管理する WSL の端末では ORCA_CLI_COMMAND が入ります。',
  linux: 'Linux で Orca の CLI（ORCA_CLI_COMMAND・PATH の orca-ide）が見つかりません。',
  other: 'Orca の CLI（ORCA_CLI_COMMAND・orca-ide）が見つかりません。',
};
const ORCA_REF = '導入は docs/setup.md の節11';
const ORCA_FALLBACK =
  'Orca の skill（orca-cli・orchestration）は使わず、今の手順（ship・1セッションの fleet・node harness/scripts/agent.ts worktree）で進めてください。';
/** Windows のほかでは、素の orca は読み上げソフトなどの別のものになりうる */
const ORCA_NO_BARE = '素の orca は実行しないでください。';

/** Windows で PATHEXT が無い・空のときの拡張子 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * isExecutable に渡すパス。Windows は PATH の各ディレクトリの orca に PATHEXT の拡張子を付けたもの、ほかは各ディレクトリの orca-ide。
 * Windows の PATH の要素は前後の `"` だけを外す。要素の途中の `"` と、`%VAR%` の展開は扱わない。
 */
function orcaCandidates(where: OrcaEnvironment, env: Record<string, string | undefined>): string[] {
  if (where !== 'windows') {
    return (env.PATH ?? '')
      .split(':')
      .filter((dir) => dir !== '')
      .map((dir) => `${dir.replace(/\/+$/, '')}/orca-ide`);
  }
  const exts = (env.PATHEXT || DEFAULT_PATHEXT).split(';').filter((ext) => ext !== '');
  const out: string[] = [];
  for (const entry of (env.PATH ?? '').split(';')) {
    const dir = entry.replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
    if (dir === '') continue;
    for (const ext of exts) out.push(`${dir}\\orca${ext}`);
  }
  return out;
}

/**
 * Orca の CLI が無いときの知らせ（知らせないなら null）。raw は stdin の JSON。platform は process.platform の形（テストで差し替える）。
 * env.PATH・env.PATHEXT は大文字のキーで読む（Windows の process.env は大文字小文字を区別しないので Path でも読める）。
 * isExecutable には、Windows では orca に PATHEXT の拡張子を付けたパス、ほかでは orca-ide のパスだけを渡す。
 */
export function orcaNotice(
  raw: string,
  env: Record<string, string | undefined>,
  isExecutable: (path: string) => boolean,
  platform: string = process.platform,
): OrcaNotice | null {
  if (env.CLAUDE_CODE_REMOTE_SESSION_ID) return null;
  let source: unknown;
  try {
    source = (JSON.parse(raw) as { source?: unknown }).source;
  } catch {
    return null;
  }
  if (source !== 'startup') return null;
  if (env.ORCA_CLI_COMMAND) return null;
  const where = orcaEnvironment(platform, env);
  for (const path of orcaCandidates(where, env)) {
    if (isExecutable(path)) return null;
  }
  const missing = ORCA_MISSING[where];
  const noBare = where === 'windows' ? '' : ORCA_NO_BARE;
  return {
    systemMessage: `${missing}今の手順（ship・1セッションの fleet）で進めます。${ORCA_REF}`,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${missing}${ORCA_FALLBACK}${noBare}${ORCA_REF}` },
  };
}

/** 共通ディレクトリを比べる形（区切りをそろえ、Windows では大文字小文字もそろえる） */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/**
 * 読み込みの記録の版と HEAD を読むディレクトリ（Issue #843）。cwd（SessionStart の入力）が空でない文字列で、その作業ツリーの一番上と
 * 共通ディレクトリが取れ、共通ディレクトリが commonDir と同じならその一番上。ほかは projectDir。例外を投げない
 */
export function recordSource(cwd: unknown, projectDir: string, commonDir: string): string {
  try {
    if (typeof cwd !== 'string' || cwd === '') return projectDir;
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    if (top.status !== 0) return projectDir;
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
    if (common.status !== 0) return projectDir;
    const root = (top.stdout ?? '').trim();
    if (root === '' || !samePath((common.stdout ?? '').trim(), commonDir)) return projectDir;
    return root;
  } catch {
    return projectDir;
  }
}

/**
 * 読み込みの記録を書く（Issue #199）。書いたパスを返す。版と HEAD は recordSource の読み先から読む（Issue #843）。CLAUDE_PROJECT_DIR が無い・session_id が形に合わない・git が失敗する・
 * 同じ ID の記録が既にある・lib が読み込めないときは null。例外を投げない
 */
export function recordLoaded(raw: string, env: Record<string, string | undefined>, now: Date = new Date()): string | null {
  try {
    const dir = env.CLAUDE_PROJECT_DIR;
    if (!dir) return null;
    const input = JSON.parse(raw) as { session_id?: unknown; source?: unknown; cwd?: unknown };
    const session = typeof input.session_id === 'string' ? input.session_id : null;
    if (!drift) return null;
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8' });
    if (common.status !== 0) return null;
    const commonDir = (common.stdout ?? '').trim();
    const path = drift.loadedRecordPath(commonDir, session);
    if (!path || !session) return null;
    const readFrom = recordSource(input.cwd, dir, commonDir);
    const files = drift.harnessVersionsOnDisk(readFrom);
    if (files === null) return null;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: readFrom, encoding: 'utf8' });
    const record = {
      version: 1 as const,
      session,
      at: now.toISOString(),
      source: typeof input.source === 'string' ? input.source : null,
      head: head.status === 0 ? (head.stdout ?? '').trim() || null : null,
      files,
    };
    return drift.writeLoadedRecordOnce(path, record) ? path : null;
  } catch {
    return null;
  }
}

/** セッションのファイルを消す、最後に書かれてからの日数（Claude Code の cleanupPeriodDays の既定） */
export const SESSION_FILE_MAX_AGE_DAYS = 30;
/** 一時ファイルを消す、最後に書かれてからの分数 */
export const STALE_TMP_MINUTES = 60;

export interface PruneIo {
  readdirSync(path: string): string[];
  statSync(path: string): { mtimeMs: number; isFile(): boolean };
  rmSync(path: string, opts: { force: boolean }): void;
}

const defaultPruneIo: PruneIo = {
  readdirSync: (path) => readdirSync(path),
  statSync: (path) => statSync(path),
  rmSync: (path, opts) => rmSync(path, opts),
};

/**
 * commonDir（git の共通ディレクトリ）の下の agent-harness/ の古いファイルを消し、消したパスを返す。
 * 消し損ねた・調べ損ねたファイルとディレクトリは飛ばす。例外を投げない
 */
export function pruneSessionFiles(commonDir: string, opts: { now: Date; keepSession: string; io?: Partial<PruneIo> }): string[] {
  const io: PruneIo = { ...defaultPruneIo, ...opts.io };
  const base = localState ? localState.harnessStateDir(commonDir) : join(commonDir, 'agent-harness');
  const now = opts.now.getTime();
  const maxAge = SESSION_FILE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const tmpAge = STALE_TMP_MINUTES * 60 * 1000;
  const removed: string[] = [];

  const list = (dir: string): string[] => {
    try {
      return io.readdirSync(dir);
    } catch {
      return [];
    }
  };
  const mtime = (path: string): number | null => {
    try {
      return io.statSync(path).mtimeMs;
    } catch {
      return null;
    }
  };
  const remove = (path: string): void => {
    try {
      io.rmSync(path, { force: true });
      removed.push(path);
    } catch {
      // 消し損ねは飛ばす
    }
  };
  const isStaleTmp = (path: string): boolean => {
    try {
      const st = io.statSync(path);
      return st.isFile() && now - st.mtimeMs > tmpAge;
    } catch {
      return false;
    }
  };

  // loaded の判定に使う stage・watch の更新時刻は、消す前に読む
  const entries = new Map<string, { id: string; path: string }[]>();
  const fresh = new Set<string>();
  for (const kind of ['loaded', 'watch', 'stage']) {
    const dir = join(base, kind);
    const items: { id: string; path: string }[] = [];
    for (const name of list(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      const id = name.slice(0, -'.json'.length);
      items.push({ id, path });
      if (kind !== 'loaded') {
        const at = mtime(path);
        if (at !== null && now - at <= maxAge) fresh.add(id);
      }
    }
    entries.set(kind, items);
  }
  for (const kind of ['watch', 'stage', 'loaded']) {
    for (const { id, path } of entries.get(kind) ?? []) {
      if (id === opts.keepSession) continue;
      if (kind === 'loaded' && fresh.has(id)) continue;
      const at = mtime(path);
      if (at !== null && now - at > maxAge) remove(path);
    }
  }
  for (const kind of ['loaded', 'watch', 'stage', 'hq']) {
    const dir = join(base, kind);
    for (const name of list(dir)) {
      if (!name.endsWith('.tmp')) continue;
      const path = join(dir, name);
      if (isStaleTmp(path)) remove(path);
    }
  }
  return removed;
}

/**
 * 手元の状態のファイルを片付ける（Issue #654）。消したパスを返す。CLAUDE_PROJECT_DIR が無い・session_id が形に合わない・
 * 共通ディレクトリが取れない・lib が読み込めないときは null で、何も消さない。例外を投げない
 */
export function pruneLocalState(raw: string, env: Record<string, string | undefined>, now: Date = new Date()): string[] | null {
  try {
    const dir = env.CLAUDE_PROJECT_DIR;
    if (!dir || !idShape || !localState) return null;
    const session = (JSON.parse(raw) as { session_id?: unknown }).session_id;
    if (typeof session !== 'string' || !idShape.test(session)) return null;
    const common = localState.gitCommonDir(dir);
    if (!common) return null;
    return pruneSessionFiles(common, { now, keepSession: session });
  } catch {
    return null;
  }
}

/** 実行できるファイルがあるか（実行はしない） */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const DOCTOR_FOOTER = '直すのは人（セッションは設定を変えない）。止めるには AGENT_HARNESS_SESSION_DOCTOR=0。docs/setup.md の節11';

/**
 * 前提の確かめの行（Issue #834）。startup・CLAUDE_PROJECT_DIR あり・Routine でない・止められていないときだけ、
 * session-doctor を読み込んで呼ぶ。止める条件では load を呼ばない。load や確かめが投げたら空。
 */
export async function doctorLines(
  raw: string,
  env: Record<string, string | undefined>,
  orcaNoticeShown: boolean,
  load: () => Promise<typeof import('../../harness/scripts/session-doctor.ts')> = () => import('../../harness/scripts/session-doctor.ts'),
): Promise<string[]> {
  try {
    if (env.CLAUDE_CODE_REMOTE_SESSION_ID || !env.CLAUDE_PROJECT_DIR || env.AGENT_HARNESS_SESSION_DOCTOR === '0') return [];
    if ((JSON.parse(raw) as { source?: unknown }).source !== 'startup') return [];
    const mod = await load();
    if (mod.sessionDoctorDisabled(env)) return [];
    return await mod.sessionDoctor({ orcaNoticeShown }, mod.defaultSessionDoctorDeps({ cwd: env.CLAUDE_PROJECT_DIR, env }));
  } catch {
    return [];
  }
}

/** Orca の知らせと確かめの行を1つにまとめる。行が空なら知らせのまま（両方無ければ null）。行の後ろに添え書きを1回だけ付ける */
export function mergeNotice(notice: OrcaNotice | null, lines: string[]): OrcaNotice | null {
  if (lines.length === 0) return notice;
  const extra = `${lines.join('\n')}\n${DOCTOR_FOOTER}`;
  const join = (head: string | undefined): string => (head ? `${head}\n${extra}` : extra);
  return {
    systemMessage: join(notice?.systemMessage),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: join(notice?.hookSpecificOutput.additionalContext) },
  };
}

/** hook の本体。直接起動したとき（import.meta.main）と、入口（run.mjs）から呼ばれたときに動く */
export async function main(): Promise<void> {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += String(chunk);
    const file = process.env.CLAUDE_ENV_FILE;
    const line = envLine(raw);
    if (file && line) appendFileSync(file, line);
  } catch {
    // セッションの開始を止めない
  }
  // 読み込みの記録（失敗しても開始を止めない。recordLoaded は例外を投げない）
  recordLoaded(raw, process.env);
  // 古い状態のファイルの片付け（pruneLocalState は例外を投げない）
  pruneLocalState(raw, process.env);
  let notice: OrcaNotice | null = null;
  try {
    notice = orcaNotice(raw, process.env, executable);
  } catch {
    // 知らせに失敗しても開始を止めない
  }
  try {
    const merged = mergeNotice(notice, await doctorLines(raw, process.env, notice !== null));
    if (merged) process.stdout.write(`${JSON.stringify(merged)}\n`);
  } catch {
    // 知らせに失敗しても開始を止めない
  }
  process.exit(0);
}

if (import.meta.main) await main();
