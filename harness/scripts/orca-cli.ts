/**
 * Orca の CLI を env・printenv を使わずに決める関数（orcaCliInfo・onPath）の置き場所（Issue #757）。
 * hq・fleet は許可済みの `node harness/scripts/agent.ts orca-cli`（Issue #773）から使う。
 *
 *   node harness/scripts/orca-cli.ts
 *
 * - `harness/lib/worktree.ts` の orcaCliCommand の結果を `command`、その CLI が PATH に見つかるかを `found` に入れた1行の JSON を標準出力に出す。
 *   出すのは `command`・`found` だけ（`ORCA_CLI_COMMAND` 以外の環境変数の値・PATH・見つかったパスは出さない）。
 * - CLI は実行しない（探すだけ）。見つからなくても終了コード 0（`found: false` で伝える）。引数を渡されたら使い方を標準エラーに出して終了コード 2。
 * - CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { accessSync, constants, statSync } from 'node:fs';
import { orcaCliCommand } from '../lib/worktree.ts';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** command が実行できるファイルとして見つかるか。区切りのある command はそのパスを、無ければ PATH の各ディレクトリを見る */
export function onPath(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  isExecutable: (path: string) => boolean,
): boolean {
  const win = platform === 'win32';
  const check = (path: string): boolean => {
    try {
      return isExecutable(path);
    } catch {
      return false;
    }
  };
  const variants = (base: string): string[] => {
    if (!win || /\.[^\\/.]+$/.test(base)) return [base];
    const exts = (env.PATHEXT || DEFAULT_PATHEXT).split(';').filter((e) => e !== '');
    return exts.map((e) => `${base}${e}`);
  };
  if (command.includes('/') || (win && command.includes('\\'))) return variants(command).some(check);
  for (const entry of (env.PATH ?? '').split(win ? ';' : ':')) {
    const dir = win ? entry.replace(/^"|"$/g, '').replace(/[\\/]+$/, '') : entry.replace(/\/+$/, '');
    if (dir === '') continue;
    if (variants(`${dir}${win ? '\\' : '/'}${command}`).some(check)) return true;
  }
  return false;
}

function defaultIsExecutable(platform: NodeJS.Platform): (path: string) => boolean {
  return (path) => {
    try {
      if (!statSync(path).isFile()) return false;
      if (platform !== 'win32') accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

export function orcaCliInfo(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  isExecutable: (path: string) => boolean = defaultIsExecutable(platform),
): { command: string; found: boolean } {
  const command = orcaCliCommand(platform, env);
  return { command, found: onPath(command, platform, env, isExecutable) };
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error('使い方: node harness/scripts/orca-cli.ts（引数は取らない）');
    process.exit(2);
  }
  console.log(JSON.stringify(orcaCliInfo(process.platform, process.env)));
}
