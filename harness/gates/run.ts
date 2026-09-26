import { createContext } from './context.ts';
import { onComment } from './on-comment.ts';
import { onIssue } from './on-issue.ts';
import { onMainPush } from './on-main-push.ts';
import { onPullRequest } from './on-pr.ts';
import { publishQueue } from './publish-queue.ts';
import { onSchedule } from './stale.ts';

/** ゲートの入口。workflow から `node harness/gates/run.ts` で呼ぶ */
const ctx = createContext();
const handlers: Record<string, (c: typeof ctx) => Promise<void>> = {
  issue_comment: onComment,
  issues: onIssue,
  pull_request_target: onPullRequest,
  push: onMainPush,
  schedule: onSchedule,
  workflow_dispatch: onSchedule,
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
  // ゲートの成否にかかわらず、次にやること（queue）をダッシュボードに公開し直す（Routine はこれを読む）
  try {
    await publishQueue(ctx);
  } catch (e) {
    ctx.log(`queue の公開に失敗しました: ${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  }
}
