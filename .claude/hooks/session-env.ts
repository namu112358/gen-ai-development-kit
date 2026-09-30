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
 */
import { accessSync, appendFileSync, constants } from 'node:fs';

/** ID の形（harness/lib/session.ts）。lib が欠けていても exit 0 で終わるよう、try の中で読む */
let idShape: RegExp | null = null;
try {
  ({ TRANSCRIPT_SESSION_ID: idShape } = await import('../../harness/lib/session.ts'));
} catch {
  idShape = null;
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
  windows: 'Windows で Orca の CLI（PATH の orca）が見つかりません。',
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

/** isExecutable に渡すパス。Windows は PATH の各ディレクトリの orca に PATHEXT の拡張子を付けたもの、ほかは各ディレクトリの orca-ide */
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

/** 実行できるファイルがあるか（実行はしない） */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
  try {
    const notice = orcaNotice(raw, process.env, executable);
    if (notice) process.stdout.write(`${JSON.stringify(notice)}\n`);
  } catch {
    // 知らせに失敗しても開始を止めない
  }
  process.exit(0);
}

if (import.meta.main) await main();
