import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { judgeInputFacts, selectApiReview } from '../../../lib/api-review.ts';
import { type HarnessConfig, reviewSourceConfig } from '../../../lib/config.ts';
import type { GitHub } from '../../../lib/github.ts';
import type { GuardrailConfig } from '../../../lib/guardrail.ts';
import { samePrPatch } from '../../../lib/patch-id.ts';
import { checkJudgeInput, previousVerdict, splitArgs } from '../../../lib/session-inputs.ts';
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
 *                                                           { action: 'local', reason: <outcome>, recordUrl }。記録を探す前に、前回の判定にブロッキングがあり出どころが
 *                                                           api でない（previous-local-blocking）、変更ファイル（/pulls/<n>/files。件数が changed_files と違えば読めない扱い）か
 *                                                           base の harness.config.json（git show origin/<base>。作業ツリーの版は使わない）のガードレールの設定を読めない
 *                                                           （scope-unreadable）、base のガードレールに当たる（guardrail-files）、秘密扱いのファイルを含む（secret-files）なら
 *                                                           local。記録のコメントが編集された（record-edited）・DRY_RUN（dry-run）・diff の切り捨て（diff-truncated）も
 *                                                           { action: 'local', reason, recordUrl }。記録が無ければ 30 秒おきに読み直し、
 *                                                           reviewSource.waitMinutes を過ぎたら { action: 'local', reason: 'timeout' }。
 *                                                           どれも終了コード 0。設定・judge-input の誤りは終了コード 2
 */

export type ApiReviewOutput =
  | { action: 'api'; reviewer: string; risk: string; recordUrl: string; recordHead: string; models: { review: string; risk: string } }
  /**
   * reason：disabled・timeout・投稿しなかった記録の outcome・previous-local-blocking・scope-unreadable・guardrail-files・secret-files・
   * record-edited・dry-run・diff-truncated（記録を選んだ理由は recordUrl つき）
   */
  | { action: 'local'; reason: string; recordUrl?: string }
  | { action: 'skip'; reason: 'closed' | 'same-head' };

const POLL_MS = 30_000;

/** 1回目の呼び出しだけ origin を fetch する（base の設定と patch-id の両方が使う。apiReview の呼び出しごとに作る） */
function fetchOnce(): () => void {
  let fetched = false;
  return () => {
    if (fetched) return;
    spawnSync('git', ['fetch', '-q', 'origin'], { encoding: 'utf8' });
    fetched = true;
  };
}

/** origin を fetch してから、PR 自身の差分（origin/<base>...<head>）の patch-id を比べる */
function samePatchWithFetch(fetch: () => void): (base: string, recordHead: string, judgedHead: string) => boolean {
  return (base, recordHead, judgedHead) => {
    fetch();
    return samePrPatch(`origin/${base}`, recordHead, judgedHead);
  };
}

/**
 * origin を fetch してから、base の harness.config.json の guardrailPaths・guardrailExclude を読む（作業ツリーの版は PR の head のことがあるので使わない）。
 * 読めない・JSON でない・どちらかが配列でも undefined でもないなら null。guardrailPaths が無ければ一覧の無い設定（すべてガードレール）として返す
 */
function baseGuardrailWithFetch(fetch: () => void): (base: string) => GuardrailConfig | null {
  return (base) => {
    fetch();
    const shown = spawnSync('git', ['show', `origin/${base}:harness.config.json`], { encoding: 'utf8' });
    if (shown.status !== 0) return null;
    let value: unknown;
    try {
      value = JSON.parse(shown.stdout);
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { guardrailPaths, guardrailExclude } = value as Record<string, unknown>;
    const isList = (v: unknown): v is string[] | undefined => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!isList(guardrailPaths) || !isList(guardrailExclude)) return null;
    return {
      ...(guardrailPaths === undefined ? {} : { guardrailPaths }),
      ...(guardrailExclude === undefined ? {} : { guardrailExclude }),
    };
  };
}

/** PR の変更ファイル（リネームは旧パスも）。件数が PR の changed_files と違えば（ページの上限で切れたなど）null */
async function changedFiles(gh: GitHub, n: number, changedCount: number): Promise<string[] | null> {
  const files = await gh.paginate<{ filename: string; previous_filename?: string }>(`/pulls/${n}/files`, 30);
  if (files.length !== changedCount) return null;
  return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

export async function apiReview(
  gh: GitHub,
  cfg: HarnessConfig,
  n: number,
  judgeInputFile: string,
  deps: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    samePatch?: (base: string, recordHead: string, judgedHead: string) => boolean;
    baseGuardrail?: (base: string) => GuardrailConfig | null;
  } = {},
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
  const fetch = fetchOnce();
  const samePatch = deps.samePatch ?? samePatchWithFetch(fetch);
  const readBaseGuardrail = deps.baseGuardrail ?? baseGuardrailWithFetch(fetch);
  // base の設定は最初に読んだ PR の base で1回だけ読む
  let baseGuardrail: { value: GuardrailConfig | null } | undefined;
  const deadline = now() + source.waitMinutes * 60_000;
  // 同じ記録の head の patch-id は一度だけ比べる
  const patchCache = new Map<string, boolean>();
  for (;;) {
    const pr = await gh.get<PullRequest & { changed_files: number }>(`/pulls/${n}`);
    baseGuardrail ??= { value: readBaseGuardrail(pr.base.ref) };
    const files = await changedFiles(gh, n, pr.changed_files);
    const comments = await gh.listComments(n);
    const previous = previousVerdict(comments).verdict;
    const choice = selectApiReview({
      pr: n,
      judgedHead,
      appLogin: source.appLogin!,
      comments,
      facts: { ...facts, previous: previous && { blocking: previous.blocking.length, reviewSource: previous.reviewSource } },
      scope: { files, baseGuardrail: baseGuardrail.value },
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
