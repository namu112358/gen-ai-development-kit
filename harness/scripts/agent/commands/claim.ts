import { checkAssignee } from '../../../lib/assignee.ts';
import { postClaim } from '../../../lib/claim.ts';
import { countsTowardAreaLimit, describeFullAreas, fullAreas } from '../../../lib/concurrency.ts';
import { GitHub } from '../../../lib/github.ts';
import { driftLine, judgeBlock } from '../../../lib/harness-drift.ts';
import { type ClaimStage, SESSION_ID_MISSING } from '../../../lib/queue.ts';
import { latestPlanGate, linkedIssues, type PlanGateRecord, type PullRequest, withStack } from '../../../lib/state.ts';
import { type AgentCommand, assigneeIo, claimBody, config, currentSession, ensureOwnClaim, fail, parseStage, harnessDrift, renderClaim, sessionUrl } from '../cli.ts';

/**
 * 着手宣言（宣言・持ち主の確かめ・解除）。
 *
 *   node harness/scripts/agent.ts claim <n> [--manual] [--stage <段階>] [--force] [--takeover]
 *                                                           着手宣言のコメント（段階とこのセッションの ID を書く。同じセッションなら段階の更新）。
 *                                                           --manual は、計画の触るファイルの領域の判定前の Agent PR（Draft）が上限（areaConcurrency）に達していれば止まる（--force で着手）。
 *                                                           ほかのセッションの着手宣言があれば止まる（期限切れでも。引き継ぐのは人が決めて --takeover）。
 *                                                           投稿の後に少し待って読み直し、先に宣言したセッションがあれば（最初の宣言が持ち主）自分の宣言を取り下げて止まる。
 *                                                           このセッションの ID が得られなければ投稿せずに止まる
 *                                                           harness.config.json の requireAssignee が true なら、--manual は Assignee がちょうど1人で今の GitHub のユーザーのときだけ宣言する
 *                                                           （PR 番号なら PR が Close する Issue の Assignee。ensure-claim などの確かめも同じ。エージェントはアサインしない）
 *                                                           このセッションの読み込みが古い（harness-drift）とき、--stage judge は宣言を投稿せずに止まる（--force・--takeover でも。Issue #199）。
 *                                                           ほかの段階は宣言の後に標準エラーへ一言出すだけで止めない
 *   node harness/scripts/agent.ts ensure-claim <番号>        このセッションの着手宣言（持ち主）があるかを確かめるだけ（PR を作る前に使う）
 *   node harness/scripts/agent.ts release <n>               着手宣言の解除コメント（このセッションの ID が得られなければ止まる）
 */

async function claim(gh: GitHub, n: number, manual: boolean, force: boolean, takeover: boolean, stage?: ClaimStage): Promise<void> {
  // 読み込みの記録があるときだけ fetch して比べる（judge の前の確かめと、宣言の後の一言で1回だけ読む）
  let drift: ReturnType<typeof harnessDrift> | undefined;
  const readDrift = () => (drift === undefined ? (drift = harnessDrift()) : drift);
  // 宣言の前の確かめ：読み込みが古いときの judge（--force・--takeover でも）→ Assignee（手動の宣言。--force・--takeover でも）→ 領域の上限（手動で --force でないとき）の順
  const before = async (): Promise<string | null> => {
    const stale = stage === 'judge' ? judgeBlock(stage, readDrift()) : null;
    if (stale) return `#${n}: ${stale}`;
    if (manual) {
      const notMine = await checkAssignee(assigneeIo(gh), config, n);
      if (notMine) return notMine;
    }
    if (!manual || force) return null;
    const gate = latestPlanGate(config, await gh.listComments(n)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
    const repository = `${gh.owner}/${gh.repo}`;
    const labels: string[][] = [];
    for (const p of await gh.paginate<PullRequest>('/pulls?state=open')) {
      // 数えるのは判定前の Agent PR（Draft）だけ。この Issue に紐付く PR（続きの作業。スタックの層は本文の Refs／Closes）は数えない
      if (!countsTowardAreaLimit(config, p, repository) || (await linkedIssues(gh, config, await withStack(gh, config, p))).includes(n)) continue;
      labels.push(p.labels.map((l) => l.name));
    }
    const full = fullAreas(config, gate?.value.plan?.files ?? [], labels);
    return full.length > 0 ? `${describeFullAreas(full)}。どれかが Merge されてから着手してください（急ぐなら --force）` : null;
  };
  // 手動の宣言でなくても、Routine のセッション URL が無ければ手動の宣言として書く（claimBody と同じ）
  const r = await postClaim(gh, n, {
    current: currentSession(),
    manual: manual || !sessionUrl(),
    takeover,
    stage,
    render: renderClaim,
    now: new Date(),
    humanClaimStaleHours: config.routine.humanClaimStaleHours,
    before,
  });
  if (r.error) fail([r.error]);
  const line = driftLine(readDrift());
  if (line) console.error(line);
}

/** 着手宣言の解除。ID が得られなければ持ち主の解除として数えられないので止める */
async function release(gh: GitHub, n: number): Promise<void> {
  const session = currentSession();
  if (session === null || session === '') fail([`#${n}: ${SESSION_ID_MISSING}`]);
  await gh.comment(n, claimBody(true, true));
}

export const commands: AgentCommand[] = [
  { name: 'claim', run: (args, ctx) => claim(ctx.gh(), Number(args[0]), args.includes('--manual'), args.includes('--force'), args.includes('--takeover'), parseStage(args)) },
  { name: 'ensure-claim', run: (args, ctx) => ensureOwnClaim(ctx.gh(), Number(args[0])) },
  { name: 'release', run: (args, ctx) => release(ctx.gh(), Number(args[0])) },
];
