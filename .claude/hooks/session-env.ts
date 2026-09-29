/**
 * 付き添いのセッションの SessionStart の hook。.claude/settings.json で matcher なしに登録し、startup・resume・clear・compact のすべてで動く。
 *
 * stdin の JSON の session_id を、CLAUDE_ENV_FILE に `export AGENT_HARNESS_SESSION=<id>` として書く。
 * 以降の Bash で harness/scripts/agent.ts がこの値を読み、着手宣言とコメントの目印に今のセッションの ID を入れる（Issue #157）。
 * /clear などで ID が変わると、自分の古い着手宣言はほかのセッションのものに見える（人に確かめて claim --takeover）。
 * session_id が無い・CLAUDE_ENV_FILE が無い・JSON が読めない・ID に英数字と - _ 以外が入るときは何も書かない。どの場合も exit 0。
 * ID の形の規則は harness/lib/session.ts の TRANSCRIPT_SESSION_ID だけにある（記録の選択と同じもの）。読めなければ何も書かない。
 *
 * startup のとき、Orca の CLI（ORCA_CLI_COMMAND か PATH の orca-ide）が無ければ、JSON の systemMessage と additionalContext で
 * 一言知らせる（Issue #195。docs/setup.md の節11）。CLI は実行せず、ファイルがあるかだけを見る。素の orca は Linux で読み上げソフトを
 * 起動しうるので探さない。Routine（CLAUDE_CODE_REMOTE_SESSION_ID がある）では知らせない。
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

const ORCA_SYSTEM_MESSAGE =
  'Orca の CLI（ORCA_CLI_COMMAND・orca-ide）が見つかりません。今の手順（ship・1セッションの fleet）で進めます。導入は docs/setup.md の節11';
const ORCA_CONTEXT =
  'Orca の CLI（ORCA_CLI_COMMAND・orca-ide）が見つかりません。Orca の skill（orca-cli・orchestration）は使わず、今の手順（ship・1セッションの fleet・node harness/scripts/agent.ts worktree）で進めてください。素の orca は実行しないでください。導入は docs/setup.md の節11';

/**
 * Orca の CLI が無いときの知らせ（知らせないなら null）。raw は stdin の JSON。
 * PATH は `:` 区切り（Linux・WSL・macOS）だけを扱い、Windows ネイティブの PATHEXT は扱わない。isExecutable には orca-ide のパスだけを渡す。
 */
export function orcaNotice(
  raw: string,
  env: Record<string, string | undefined>,
  isExecutable: (path: string) => boolean,
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
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const path = `${dir.replace(/\/+$/, '')}/orca-ide`;
    if (isExecutable(path)) return null;
  }
  return {
    systemMessage: ORCA_SYSTEM_MESSAGE,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ORCA_CONTEXT },
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
