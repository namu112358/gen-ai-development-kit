import type { Confirm } from '../../../lib/confirm.ts';
import type { GitHub } from '../../../lib/github.ts';
import { type AgentCommand, checkFile, fail, readBlockFile } from '../cli.ts';

/**
 * 確認事項の投稿（Issue #953）。人の判断が要る場面で、止まって待たずに確認事項を対象の Issue か PR に書く。書式と答えの読み方は harness/lib/confirm.ts。
 *
 *   node harness/scripts/agent.ts post-confirm <番号> <ファイル>   ```agent-confirm を検査し、target が番号と同じなら、セッションの目印つきで Issue か PR にコメントを1件書く。
 *                                                                   ラベル・本文・Merge・Close は変えない
 */

async function postConfirm(gh: GitHub, n: number, file: string): Promise<void> {
  if (!Number.isInteger(n) || n <= 0 || !file) fail(['使い方: node harness/scripts/agent.ts post-confirm <番号> <ファイル>']);
  const checked = checkFile(file);
  if (checked.kind !== 'confirm' || checked.errors.length > 0) fail(checked.kind !== 'confirm' ? ['agent-confirm ブロックがありません'] : checked.errors);
  const confirm = checked.value as Confirm;
  if (confirm.target !== n) fail([`confirm.target（${confirm.target}）が #${n} と一致しません`]);
  const posted = await gh.comment(n, readBlockFile(file));
  console.log(JSON.stringify({ posted: posted.html_url }, null, 2));
}

export const commands: AgentCommand[] = [
  { name: 'post-confirm', run: (args, ctx) => postConfirm(ctx.gh(), Number(args[0]), args[1]!) },
];
