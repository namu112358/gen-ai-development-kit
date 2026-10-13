import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { judgeInputFacts, selectApiReview } from '../../../lib/api-review.ts';
import { type HarnessConfig, reviewSourceConfig } from '../../../lib/config.ts';
import type { GitHub } from '../../../lib/github.ts';
import { samePrPatch } from '../../../lib/patch-id.ts';
import { checkJudgeInput, splitArgs } from '../../../lib/session-inputs.ts';
import type { PullRequest } from '../../../lib/state.ts';
import { type AgentCommand, config, fail, writeTemp } from '../cli.ts';

/**
 * judge のレビューの出どころを決める（Issue #1004・#1042）。GitHub は GET だけで、書き込まない。
 *
 *   node harness/scripts/agent.ts api-review <pr> --judge-input <file>
 *                                                           reviewSource.mode（harness.config.json。無ければ local）が local なら GitHub を読まずに
 *                                                           { action: 'local', reason: 'disabled' }。api なら judge-input の headSha・PR の状態・前回の判定の head と、
 *                                                           PR のレビュー用 App（reviewSource.appLogin）の記録から選ぶ：closed・前回の判定と同じ head は
 *                                                           { action: 'skip', reason }、posted の記録は reviewer・risk の JSON をファイルに書いて
 *                                                           { action: 'api', reviewer, risk, recordUrl, recordHead, models }、投稿しなかった記録は
 *                                                           { action: 'local', reason: <outcome>, recordUrl }。記録が無ければ 30 秒おきに読み直し、
 *                                                           reviewSource.waitMinutes を過ぎたら { action: 'local', reason: 'timeout' }。
 *                                                           どれも終了コード 0。設定・judge-input の誤りは終了コード 2
 */

export type ApiReviewOutput =
  | { action: 'api'; reviewer: string; risk: string; recordUrl: string; recordHead: string; models: { review: string; risk: string } }
  | { action: 'local'; reason: string; recordUrl?: string }
  | { action: 'skip'; reason: 'closed' | 'same-head' };

const POLL_MS = 30_000;

/** origin を fetch してから、PR 自身の差分（origin/<base>...<head>）の patch-id を比べる */
function samePatchWithFetch(): (base: string, recordHead: string, judgedHead: string) => boolean {
  let fetched = false;
  return (base, recordHead, judgedHead) => {
    if (!fetched) {
      spawnSync('git', ['fetch', '-q', 'origin'], { encoding: 'utf8' });
      fetched = true;
    }
    return samePrPatch(`origin/${base}`, recordHead, judgedHead);
  };
}

export async function apiReview(
  gh: GitHub,
  cfg: HarnessConfig,
  n: number,
  judgeInputFile: string,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void>; samePatch?: (base: string, recordHead: string, judgedHead: string) => boolean } = {},
): Promise<ApiReviewOutput> {
  let source: ReturnType<typeof reviewSourceConfig>;
  try {
    source = reviewSourceConfig(cfg);
  } catch (e) {
    fail([(e as Error).message]);
  }
  if (source.mode === 'local') return { action: 'local', reason: 'disabled' };
  const text = readFileSync(judgeInputFile, 'utf8');
  const judged = checkJudgeInput(text, n);
  if (!judged.ok) fail(judged.errors.map((e) => `${judgeInputFile}: ${e}`));
  const judgedHead = judged.value;
  const facts = judgeInputFacts(text);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const samePatch = deps.samePatch ?? samePatchWithFetch();
  const deadline = now() + source.waitMinutes * 60_000;
  // 同じ記録の head の patch-id は一度だけ比べる
  const patchCache = new Map<string, boolean>();
  for (;;) {
    const pr = await gh.get<PullRequest>(`/pulls/${n}`);
    const comments = await gh.listComments(n);
    const choice = selectApiReview({
      pr: n,
      judgedHead,
      appLogin: source.appLogin!,
      comments,
      facts,
      samePatch: (recordHead) => {
        const cached = patchCache.get(recordHead);
        if (cached !== undefined) return cached;
        const same = samePatch(pr.base.ref, recordHead, judgedHead);
        patchCache.set(recordHead, same);
        return same;
      },
    });
    if (choice.action === 'api') {
      const head7 = judgedHead.slice(0, 7);
      return {
        action: 'api',
        reviewer: writeTemp(`api-reviewer-${n}-${head7}.json`, `${JSON.stringify(choice.reviewer, null, 2)}\n`),
        risk: writeTemp(`api-risk-${n}-${head7}.json`, `${JSON.stringify(choice.risk, null, 2)}\n`),
        recordUrl: choice.recordUrl,
        recordHead: choice.recordHead,
        models: choice.models,
      };
    }
    if (choice.action !== 'pending') return choice;
    if (now() + POLL_MS > deadline) return { action: 'local', reason: 'timeout' };
    await sleep(POLL_MS);
  }
}

export const commands: AgentCommand[] = [
  {
    name: 'api-review',
    run: async (args, ctx) => {
      const r = splitArgs(args, ['--judge-input']);
      const usage = 'usage: api-review <pr> --judge-input <file>';
      if (!r.ok) fail([...r.errors, usage]);
      const [pr] = r.value.positional;
      const file = r.value.options['--judge-input'];
      if (r.value.positional.length !== 1 || !pr || !/^\d+$/.test(pr) || !file) fail([usage]);
      console.log(JSON.stringify(await apiReview(ctx.gh(), config, Number(pr), file), null, 2));
    },
  },
];
