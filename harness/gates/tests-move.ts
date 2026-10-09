/**
 * テストファイルの削除の移し先を Jev に問い、App の記録（kind=test-move-jev）に残す（Epic #511、Issue #514）。
 * 削除があり、PR 本文に対応表があるときだけ、消したテストの確かめが足したテストに残っているかを Jev に問う（材料は diff だけ。lib/test-move-jev.ts）。
 * on-pr.ts（tests-check.ts の書き手）と apply.ts の rewriteTestsCheck の両方から使うので、apply.ts を import しない。
 * 同じ patch-id・同じ問いの版の記録があれば問い直さず、今の設定で通すかを決め直す。Jev の error は記録しない（次のイベントで問い直す）。
 * jev.testTamper が off・fork の PR・JEV_API_KEY が無い・対応表が無い・問えない材料のときは問わない。
 */
import { askJev } from '../lib/jev.ts';
import type { IssueComment } from '../lib/github.ts';
import { appRecords, isSameRepoPr, type PullRequest } from '../lib/state.ts';
import {
  hasMoveTable,
  renderTestMove,
  resummarizeTestMove,
  summarizeTestMove,
  testMoveMaterial,
  testMoveRequest,
  TEST_MOVE_JEV_KIND,
  TEST_MOVE_JEV_QUESTION_SET,
  type TestMoveOutcome,
  type TestMoveRecord,
} from '../lib/test-move-jev.ts';
import { DEFAULT_TEST_PATTERNS, type TamperFinding } from '../lib/test-tamper.ts';
import { tamperJevMode } from '../lib/test-tamper-jev.ts';
import { appComment, type GateContext } from './context.ts';

type Lazy<T> = T | (() => Promise<T>);
const resolve = <T>(v: Lazy<T>): Promise<T> => (typeof v === 'function' ? (v as () => Promise<T>)() : Promise.resolve(v));

/** diff・patch・comments は呼び出し元が読みを使い回す関数でもよい。問わないときは呼ばない */
export async function testMoveJevFor(
  ctx: GateContext,
  pr: PullRequest,
  findings: TamperFinding[],
  diff: Lazy<string>,
  patch: Lazy<string>,
  comments: Lazy<IssueComment[]>,
): Promise<TestMoveOutcome> {
  const deletedFiles = [...new Set(findings.filter((f) => f.kind === 'deleted-file').map((f) => f.file))];
  if (deletedFiles.length === 0) return { applies: false };
  const mode = tamperJevMode(ctx.config);
  const skip = (reason: string): TestMoveOutcome => ({ applies: true, mode, asked: false, reason });
  if (mode === 'off') return skip('`jev.testTamper` が off です');
  if (!isSameRepoPr(pr, ctx.repository)) return skip('fork の PR は Jev に問いません');
  const apiKey = ctx.secrets.jevApiKey;
  if (!apiKey) return skip('`JEV_API_KEY` が未設定です');
  const table = hasMoveTable(pr.body ?? null, deletedFiles);
  if (!table.ok) return skip(table.reason);

  const patchId = await resolve(patch);
  const recorded = appRecords<TestMoveRecord>(ctx.config, await resolve(comments), TEST_MOVE_JEV_KIND)
    .filter((r) => r.value.patchId === patchId && r.value.questionSet === TEST_MOVE_JEV_QUESTION_SET)
    .at(-1)?.value;
  if (recorded) return { applies: true, mode, asked: true, reused: true, model: recorded.model, ...resummarizeTestMove(ctx.config, recorded.files ?? []) };

  const material = testMoveMaterial(await resolve(diff), ctx.config.testPatterns ?? DEFAULT_TEST_PATTERNS, deletedFiles);
  if (material.deleted.length !== deletedFiles.length) return skip('消したファイルの中身を diff から読めません');
  const req = testMoveRequest(ctx.config, material);
  if (!req.ask) return skip(req.reason);

  const r = await (ctx.askJev ?? askJev)(apiKey, req.request);
  if (r.status !== 'ok') {
    ctx.log(`#${pr.number} のテストファイルの削除の移し先を Jev に問えませんでした: ${r.detail}`);
    return skip(`Jev に問えませんでした（${r.detail}）。次のイベントで問い直します`);
  }
  const summary = summarizeTestMove(ctx.config, r.answers, material.deleted.map((d) => d.file));
  const outcome: TestMoveOutcome = { applies: true, mode, asked: true, reused: false, model: r.model, ...summary };
  const record: TestMoveRecord = { version: 1, patchId, headSha: pr.head.sha, mode, model: r.model, questionSet: TEST_MOVE_JEV_QUESTION_SET, ...summary };
  await appComment(ctx, pr.number, TEST_MOVE_JEV_KIND, [`消したテストファイル（${material.deleted.length} 件）の移し先を Jev に問いました（記録）。`, '', renderTestMove(outcome)].join('\n'), record);
  return outcome;
}
