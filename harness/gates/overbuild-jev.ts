/**
 * 判定の受け付けで⑨のブロッキング指摘を Jev に問い、受け付けの記録の overbuildJev を作る。純粋な部分は harness/lib/overbuild-jev.ts（Epic #497、Issue #584）
 */
import { askJev } from '../lib/jev.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { askableOverbuild, buildOverbuildRequest, overbuildBlocking, overbuildJevMode, skippedOverbuildJev, summarizeOverbuildJev, type OverbuildJevRecord } from '../lib/overbuild-jev.ts';
import { appRecords } from '../lib/state.ts';
import type { Verdict } from '../lib/verdict.ts';
import type { GateContext } from './context.ts';

/**
 * 判定の⑨のブロッキング指摘ごとに Jev の答えの記録を作る。jev.overbuild が off、または⑨が0件なら undefined。
 * recent_diff は前回の受け付けの head から今の head への compare（間に main の取り込みがあると main の変更も入る）。取れなければ null で問う
 */
export async function overbuildJevFor(ctx: GateContext, prNumber: number, verdict: Verdict, diff: string): Promise<OverbuildJevRecord | undefined> {
  if (overbuildJevMode(ctx.config) === 'off') return undefined;
  const findings = overbuildBlocking(verdict);
  if (findings.length === 0) return undefined;
  const key = ctx.secrets.jevApiKey;
  if (!key) return skippedOverbuildJev(ctx.config, findings, 'skipped', 'JEV_API_KEY が未設定');
  const first = askableOverbuild(ctx.config, findings, diff, null);
  if (!first.ask) return skippedOverbuildJev(ctx.config, findings, 'skipped', first.reason);

  const prev = appRecords<Acceptance>(ctx.config, await ctx.gh.listComments(prNumber), 'acceptance').at(-1)?.value.verdictHeadSha;
  let recentDiff: string | null = null;
  if (prev && prev !== verdict.headSha) {
    try {
      recentDiff = await ctx.gh.compareDiff(prev, verdict.headSha);
    } catch {
      recentDiff = null;
    }
  }
  const second = askableOverbuild(ctx.config, findings, diff, recentDiff);
  if (!second.ask) return skippedOverbuildJev(ctx.config, findings, 'skipped', second.reason);

  const res = await (ctx.askJev ?? askJev)(key, buildOverbuildRequest(ctx.config, diff, findings, recentDiff));
  if (res.status === 'error') return skippedOverbuildJev(ctx.config, findings, 'error', res.detail);
  return summarizeOverbuildJev(ctx.config, res.model, res.answers, findings, recentDiff !== null && recentDiff !== '');
}
