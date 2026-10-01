import { writeSync } from 'node:fs';
import { apiCountFromEnv } from '../lib/api-count.ts';
import type { GitHub } from '../lib/github.ts';
import { COMMANDS_DIR, loadCommands, newGitHub, type CommandContext } from './agent/cli.ts';

/**
 * Routine と人のセッションが使う CLI。書式は投稿前に検査する。
 *
 *   node harness/scripts/agent.ts <コマンド> [引数...]
 *
 * 各コマンドの使い方は、harness/scripts/agent/commands/ の各ファイルの先頭のコメントにある（Issue #313）。
 * この入口はコマンドの一覧を持たない。commands/ の .ts を読み込み、コマンドの名前で振り分ける（コマンドを足すときは commands/ にファイルを置くだけ）。
 *
 * ■ Routine 用（GitHub API を呼ばない。投稿・ラベル操作は Routine が GitHub の MCP ツールで行う）
 *   render-claim・render-block・render-plan・render-verdict・render-metrics・usage・check・worktree（--routine）・worktree-remove・session-url・incident（GitHub を読み書きしない。記録はリポジトリの外のファイル）
 *
 * ■ 人のセッション用（gh の認証で GitHub API を呼ぶ）
 *   上のほかの全部のコマンド
 *
 * リポジトリは GITHUB_REPOSITORY か git remote から決める。
 *
 * ■ API の呼び出しの回数（#247）
 *   AGENT_HARNESS_API_COUNT=1 を付けて動かすと、終わり（正常・process.exit・例外のどれでも）に標準エラーへ要約を出す。
 *   付けない（未設定・空・0）ときは何も足さない（gh api の引数も出力も今と同じ）。要約の形（harness/lib/api-count.ts）：
 *     [api-count] <コマンド>: 計 N 回（HTTP の応答 M 回）   ← 計は呼び出しの数、応答はやり直しを含む HTTP の応答の数
 *     [api-count]   core: remaining R / used U / limit L    ← 資源ごとに最後に見た上限のヘッダー
 *     [api-count]   <回数>  <メソッド> <パスの形>            ← 番号を伏せた形ごと（回数の多い順）
 */

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const counter = apiCountFromEnv(process.env);
  // exit は process.exit・例外でも呼ばれる。writeSync は exit の中でも書き込みを取りこぼさない
  if (counter) process.on('exit', () => void writeSync(2, counter.summary(cmd ?? '(none)')));
  const commands = await loadCommands(COMMANDS_DIR);
  let gh: GitHub | null = null;
  const ctx: CommandContext = { counter, gh: () => (gh ??= newGitHub(counter)) };
  const command = cmd === undefined ? undefined : commands.get(cmd);
  if (!command) {
    // 分ける前と同じく、知らないコマンドでも先に GitHub を作る（origin が読めなければそこで止まる）
    ctx.gh();
    console.error('usage: see header of harness/scripts/agent.ts');
    process.exit(1);
  }
  await command.run(args, ctx);
}

await main();
