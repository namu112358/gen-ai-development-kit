import { createContext } from './context.ts';
import { onScheduleWithLabels } from './label-apply.ts';
import { onComment } from './on-comment.ts';
import { onIssue } from './on-issue.ts';
import { onMainPush } from './on-main-push.ts';
import { onPullRequest } from './on-pr.ts';
import { publishesQueueOn, publishQueue } from './publish-queue.ts';

/**
 * ゲートの入口で、イベントの種類ごとに処理を選ぶ。定期実行と手動の起動のときだけ、最後に queue を公開し直す。
 * workflow から `node harness/gates/run.ts` で呼ぶ。
 */
const ctx = createContext();
const handlers: Record<string, (c: typeof ctx) => Promise<void>> = {
  issue_comment: onComment,
  issues: onIssue,
  pull_request_target: onPullRequest,
  push: onMainPush,
  // 足りないラベルを付けてから（label-apply）ダッシュボードを書き直す
  schedule: onScheduleWithLabels,
  workflow_dispatch: onScheduleWithLabels,
};

const handler = handlers[ctx.eventName];
if (!handler) {
  ctx.log(`未対応のイベント: ${ctx.eventName}`);
} else {
  try {
    await handler(ctx);
  } catch (e) {
    ctx.log(`ゲートが失敗しました: ${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  }
  // 定期実行と手動の起動のときだけ、ゲートの成否にかかわらず、次にやること（queue）をダッシュボードに公開し直す（Routine はこれを読む）
  if (publishesQueueOn(ctx.eventName)) {
    try {
      await publishQueue(ctx);
    } catch (e) {
      ctx.log(`queue の公開に失敗しました: ${(e as Error).stack ?? e}`);
      process.exitCode = 1;
    }
  } else {
    ctx.log('queue の公開はしません（定期実行・手動の起動だけ）');
  }
}
