/**
 * agent/tests の検出（アサーションの書き換え）を Jev に問い、App の記録（kind=test-tamper-jev）に残す（Q95）。
 * on-pr.ts（tests-check.ts の書き手）と apply.ts の rewriteTestsCheck の両方から使うので、apply.ts を import しない。
 * 1つの差分（patch-id）に1回だけ問う。同じ patch-id の記録があれば問い直さず、記録の確率と今の設定で通すかを計算し直す。
 * jev.testTamper が off・fork の PR・JEV_API_KEY が無い・問えない検出（削除系など）のときは問わない。Jev の error は記録しない（次のイベントで問い直す）。
 */
import { askJev } from '../lib/jev.ts';
import type { IssueComment } from '../lib/github.ts';
import { appRecords, isSameRepoPr, type PullRequest } from '../lib/state.ts';
import {
  askableChanges,
  buildTamperRequest,
  renderTamperJev,
  summarizeTamperJev,
  tamperAllows,
  tamperJevMode,
  tamperJevThreshold,
  TEST_TAMPER_JEV_KIND,
  type TamperJevOutcome,
  type TamperJevRecord,
} from '../lib/test-tamper-jev.ts';
import type { TamperFinding } from '../lib/test-tamper.ts';
import { appComment, type GateContext } from './context.ts';

type Lazy<T> = T | (() => Promise<T>);
const resolve = <T>(v: Lazy<T>): Promise<T> => (typeof v === 'function' ? (v as () => Promise<T>)() : Promise.resolve(v));

/**
 * patch は今の差分の patch-id、comments は呼び出し元が既に読んだ PR のコメント（API の呼び出しを増やさない）。
 * どちらも、読みを使い回す関数（on-pr.ts の getPatch・getComments）でもよい。問わないときは呼ばない。
 */
export async function tamperJevFor(ctx: GateContext, pr: PullRequest, findings: TamperFinding[], patch: Lazy<string>, comments: Lazy<IssueComment[]>): Promise<TamperJevOutcome> {
  const mode = tamperJevMode(ctx.config);
  if (mode === 'off') return { mode, asked: false, reason: '`jev.testTamper` が off です' };
  if (!isSameRepoPr(pr, ctx.repository)) return { mode, asked: false, reason: 'fork の PR は Jev に問いません' };
  const apiKey = ctx.secrets.jevApiKey;
  if (!apiKey) return { mode, asked: false, reason: '`JEV_API_KEY` が未設定です' };
  const askable = askableChanges(findings);
  if (!askable.ask) return { mode, asked: false, reason: askable.reason };

  const patchId = await resolve(patch);
  const recorded = appRecords<TamperJevRecord>(ctx.config, await resolve(comments), TEST_TAMPER_JEV_KIND).filter((r) => r.value.patchId === patchId).at(-1)?.value;
  if (recorded) {
    const probability = recorded.probability ?? NaN;
    return {
      mode,
      asked: true,
      reused: true,
      model: recorded.model,
      probabilities: (recorded.probabilities ?? []).map((p) => p ?? NaN),
      probability,
      threshold: tamperJevThreshold(ctx.config),
      allows: tamperAllows(ctx.config, probability),
    };
  }

  const r = await (ctx.askJev ?? askJev)(apiKey, buildTamperRequest(ctx.config, askable.changes));
  if (r.status !== 'ok') {
    ctx.log(`#${pr.number} のテストの行の変更を Jev に問えませんでした: ${r.detail}`);
    return { mode, asked: false, reason: `Jev に問えませんでした（${r.detail}）。次のイベントで問い直します` };
  }
  const summary = summarizeTamperJev(ctx.config, r.answers, askable.changes.length);
  const outcome: TamperJevOutcome = { mode, asked: true, reused: false, model: r.model, ...summary };
  const finite = (p: number) => (Number.isFinite(p) ? p : null);
  const record: TamperJevRecord = {
    version: 1,
    patchId,
    headSha: pr.head.sha,
    mode,
    model: r.model,
    probabilities: summary.probabilities.map(finite),
    probability: finite(summary.probability),
    threshold: summary.threshold,
    allows: summary.allows,
  };
  await appComment(ctx, pr.number, TEST_TAMPER_JEV_KIND, [`テストの行の変更（${askable.changes.length} 件）を Jev に問いました（記録）。`, '', renderTamperJev(outcome, mode)].join('\n'), record);
  return outcome;
}
