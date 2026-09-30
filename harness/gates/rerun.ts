import { FetchTransport, GitHub } from '../lib/github.ts';
import { redact } from '../lib/jev.ts';
import { createContext } from './context.ts';
import { rerunFailedGateRuns } from './rerun-failed.ts';

/**
 * ジョブ rerun-failed の入口。失敗した判定・計画・決定の記録の実行を1回だけやり直す（rerun-failed.ts）。
 * workflow から `node harness/gates/rerun.ts` で呼ぶ。定期実行と手動の起動のときだけ動く。
 */
const eventName = process.env.GITHUB_EVENT_NAME ?? '';
if (eventName !== 'schedule' && eventName !== 'workflow_dispatch') {
  console.log(`失敗した実行のやり直しは定期実行・手動の起動だけです（${eventName || 'イベント不明'}）`);
} else {
  const actionsToken = process.env.GH_ACTIONS_TOKEN;
  if (!actionsToken) {
    console.log('GH_ACTIONS_TOKEN がありません（actions: write の GITHUB_TOKEN を渡す）');
    process.exitCode = 1;
  } else {
    const ctx = createContext();
    const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
    const log = (msg: string): void => ctx.log(redact(msg, actionsToken));
    try {
      const appTransport = new FetchTransport(process.env.GH_APP_TOKEN!, apiUrl);
      await rerunFailedGateRuns({
        config: ctx.config,
        app: ctx.gh,
        actions: new GitHub(new FetchTransport(actionsToken, apiUrl), ctx.repository),
        // GET /rate_limit は上限を消費しない
        appRateRemaining: async () => ((await appTransport.request('GET', '/rate_limit')) as { resources: { core: { remaining: number } } }).resources.core.remaining,
        log,
      });
    } catch (e) {
      log(`失敗した実行のやり直しに失敗しました: ${(e as Error).stack ?? e}`);
      process.exitCode = 1;
    }
  }
}
