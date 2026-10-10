import { createContext } from './context.ts';
import { onScheduleWithLabels } from './label-apply.ts';
import { onComment } from './on-comment.ts';
import { onIssue } from './on-issue.ts';
import { onMainPush } from './on-main-push.ts';
import { onPullRequest } from './on-pr.ts';
import { catchUpPeriodic, markPeriodic } from './periodic-catch-up.ts';
import { publishesQueueOn, publishQueue } from './publish-queue.ts';

/**
 * ゲートの入口で、イベントの種類ごとに処理を選ぶ。定期実行と手動の起動のときだけ、最後に queue を公開し直す。
 * それ以外のイベントでは、前回の定期の仕事からしきい値以上空いていれば、定期の仕事を1回補う（periodic-catch-up.ts。Issue #418）。
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
  const periodic = ctx.eventName === 'schedule' || ctx.eventName === 'workflow_dispatch';
  if (periodic) {
    // 定期の仕事を始める前に、前回の時刻の印を書く（失敗しても続ける）
    try {
      await markPeriodic(ctx, { at: new Date().toISOString(), run: process.env.GITHUB_RUN_ID ?? 'unknown', event: ctx.eventName });
    } catch (e) {
      ctx.log(`定期の仕事の印を書けませんでした: ${(e as Error).message}`);
    }
  }
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
    ctx.log('queue の公開はしません（定期実行・手動の起動と、定期の仕事を補うときだけ）');
  }
  if (!periodic) {
    try {
      await catchUpPeriodic(ctx);
    } catch (e) {
      ctx.log(`定期の仕事を補えませんでした: ${(e as Error).stack ?? e}`);
      process.exitCode = 1;
    }
  }
}
