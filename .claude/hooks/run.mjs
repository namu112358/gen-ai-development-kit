/**
 * hook の入口。.claude/settings.json の PreToolUse と SessionStart は、hook のファイルのパスを引数にしてこれを起動する（Issue #257）。
 *
 * ハーネスの hook（guard.ts・session-env.ts）は Node 24 の型注釈の剥がしで動く。Node 24 未満では、.ts が読めずに失敗するか、
 * 本体が動かないまま終わり、どちらも Claude Code には「通す」に見える（guard が何も止めない）。そこで、型注釈の無いこの入口が
 * Node の版を確かめ、24 以上なら hook を import して main() を呼ぶ。24 未満のとき、または import・main() が例外で失敗したときは、
 * hook ごとの「動けないときの出力」を出す：guard は Bash・MCP のツールを理由付きで止め（deny）、session-env はセッションを止めずに知らせる。
 *
 * - 読み込むのはこのファイルと同じディレクトリの、許可の一覧（guard.ts・session-env.ts）のファイルだけ。引数のディレクトリは使わない。
 *   一覧に無い引数は設定の誤りとして stderr に書いて exit 2（PreToolUse では止まる）。
 * - stdin は読まない（hook の main() が読み切る）。main() が返った後は何も出さない（session-env の main() は process.exit(0) で終わる）。
 * - 判定の規則（保護ラベル・push の判定など）は持たない。hook の中身はそれぞれのファイルにある。
 * - このファイル自身が読めない・壊れたときは今までと同じく fail-open になる（残る守りは permissions.deny と GitHub の Ruleset）。
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Node 24 以上か。先頭の v は許す。読めない版は false */
export function nodeMajorOk(version) {
  const m = /^v?(\d+)\./.exec(String(version));
  return m !== null && Number(m[1]) >= 24;
}

/** 引数の basename から hook の名前（許可の一覧のほかは null） */
export function hookFor(arg) {
  const base = String(arg).split(/[\\/]/).pop();
  if (base === 'guard.ts') return 'guard';
  if (base === 'session-env.ts') return 'session-env';
  return null;
}

/** 動けないときの出力（JSON の文字列）。guard は PreToolUse の deny、session-env は人とセッションへの知らせ */
export function failOutput(hook, reason) {
  if (hook === 'guard') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  }
  return JSON.stringify({ systemMessage: reason, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reason } });
}

function versionReason(hook, version) {
  if (hook === 'guard') {
    return `Node ${version} ではハーネスの見張りの hook（.claude/hooks/guard.ts）が動かないため、Bash と MCP のツールを止めています（Node 24 以上が要ります）。Node 24 で Claude Code を起動し直してください。`;
  }
  return `Node ${version} ではハーネスの SessionStart の hook（.claude/hooks/session-env.ts）が動かず、AGENT_HARNESS_SESSION は書かれていません（Node 24 以上が要ります）。見張りの hook も Bash と MCP のツールを止めます。Node 24 で Claude Code を起動し直してください。`;
}

function errorReason(hook, error) {
  const message = error instanceof Error ? error.message : String(error);
  const what = hook === 'guard' ? '見張りの hook（.claude/hooks/guard.ts）が動けなかったため、Bash と MCP のツールを止めています' : 'SessionStart の hook（.claude/hooks/session-env.ts）が動けず、AGENT_HARNESS_SESSION は書かれていません';
  return `ハーネスの${what}：${message}`;
}

/**
 * 版を確かめて hook を動かす。load は hook のモジュール（main() を持つ）を返す関数。
 * 版が足りなければ load を呼ばない。output は stdout に書くもの（正常なら空。出力は hook の main() が自分で書く）
 */
export async function run({ version, hook, load }) {
  if (!nodeMajorOk(version)) return { output: failOutput(hook, versionReason(hook, version)), loaded: false };
  try {
    const mod = await load();
    await mod.main();
    return { output: '', loaded: true };
  } catch (e) {
    return { output: failOutput(hook, errorReason(hook, e)), loaded: true };
  }
}

/**
 * 直接起動されたか（import.meta.main は Node 24 より前に無いので、起動したパスと比べる）。
 * Node はメインのモジュールを実体のパスで読むので、シンボリックリンク・ジャンクションを通した起動でも合うよう、argv[1] も実体のパスにしてから比べる
 * パスの書き方の違い（UNC パスなど）で合わなくても黙って fail-open にならないよう、起動したファイルの名前が run.mjs なら入口と見なす（テストが import したときは argv[1] がテストのファイルなので動かない）
 */
function isEntryPath(argv1) {
  if (typeof argv1 !== 'string') return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
}
const isEntry = isEntryPath(process.argv[1]) || (typeof process.argv[1] === 'string' && /(^|[\\/])run\.mjs$/.test(process.argv[1]));
if (isEntry) {
  const hook = hookFor(process.argv[2] ?? '');
  if (hook === null) {
    process.stderr.write(`hook の入口（.claude/hooks/run.mjs）：許可の一覧に無い引数です（${process.argv[2] ?? ''}）。.claude/settings.json の command を確かめてください\n`);
    process.exit(2);
  }
  const { output } = await run({ version: process.versions.node, hook, load: () => import(new URL(`./${hook}.ts`, import.meta.url).href) });
  if (output) process.stdout.write(`${output}\n`);
}
