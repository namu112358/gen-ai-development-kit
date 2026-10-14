import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { HarnessConfig } from '../../../lib/config.ts';
import { claimOf } from '../../../lib/facts.ts';
import type { ClaimAge } from '../../../lib/fleet.ts';
import { GitHub } from '../../../lib/github.ts';
import { checkJudgeRoutineInput, checkoutDecision, type JudgeRoutineDecision, type JudgeRoutineInput, judgedSkip, parseJudgeRoutineInput, type RoutineCandidate, selectRoutineCandidate } from '../../../lib/judge-routine.ts';
import { previousVerdict } from '../../../lib/session-inputs.ts';
import type { PullRequest } from '../../../lib/state.ts';
import { type AgentCommand, config, fail, samePatchAsCurrent } from '../cli.ts';

/**
 * 判定の Routine の1回分（`/judge --routine`。Issue #786・#1097）の入力の検査と、判定する PR の引き当て。GitHub は REST の GET だけを読み、書き込まない。
 *
 *   node harness/scripts/agent.ts judge-routine-check [<入力のファイル>]
 *                                                           入力（{ pr, head, base, dryRun } の JSON。コードブロックに入っていてもよい）を、PR の今の状態と照らして
 *                                                           { action: 'judge', pr, head, inputHead, dryRun } か { action: 'skip', reason } を JSON で出す。
 *                                                           入力のファイルが無ければ（GitHub のトリガー）、開いた Draft の Agent PR（head が claude/ で始まる）から、判定が無いか
 *                                                           patch-id が違い、有効な judge の宣言が無いものを updatedAt の古い順に1つ選ぶ（inputHead は今の head、dryRun は false。無ければ no-candidate）。
 *                                                           skip も終了コード 0（手順が action を見て止まる）。入力のファイルが読めないときだけ終了コード 2。
 *                                                           skip の理由は「識別子: 説明」の形（not-draft・already-judged・head-checkout・no-candidate）。
 *                                                           PR が open でない・Draft でない・base が違う・head が違い patch-id も違う・PR が 404・最新の判定と同じ（head か patch-id）・
 *                                                           checkout の HEAD が既定ブランチの祖先でないか判定する PR の head と同じ、は skip。
 *                                                           最初に shallow clone のときだけ git fetch --unshallow origin を流す（失敗は見ない）。
 */

type SamePatch = (pr: PullRequest, judgedHead: string) => boolean;

export interface JudgeRoutineDeps {
  samePatch: SamePatch;
  git: { fetchUnshallow(): void; headSha(): string; isAncestorOfDefault(defaultBranch: string): boolean };
  age: ClaimAge;
  defaultBranch: string;
}

function gitOut(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '' };
}

export function defaultJudgeRoutineDeps(cfg: HarnessConfig = config, now: Date = new Date()): JudgeRoutineDeps {
  return {
    samePatch: samePatchAsCurrent,
    git: {
      fetchUnshallow: () => {
        // 浅い clone のときだけ。終了コードは見ない（先に流してあると 128 になる。失敗を skip の理由にしない）
        if (gitOut(['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true') spawnSync('git', ['fetch', '--unshallow', 'origin'], { encoding: 'utf8' });
      },
      headSha: () => {
        const r = gitOut(['rev-parse', 'HEAD']);
        if (r.status !== 0) throw new Error('git rev-parse HEAD に失敗しました');
        return r.stdout.trim();
      },
      isAncestorOfDefault: (defaultBranch) => {
        const r = gitOut(['merge-base', '--is-ancestor', 'HEAD', `origin/${defaultBranch}`]);
        if (r.status === 0) return true;
        if (r.status === 1) return false;
        throw new Error(`origin/${defaultBranch} との祖先の確かめに失敗しました`);
      },
    },
    age: { now, humanClaimStaleHours: cfg.routine.humanClaimStaleHours, routineClaimTakeoverMinutes: cfg.routine.routineClaimTakeoverMinutes },
    defaultBranch: cfg.defaultBranch,
  };
}

export async function runJudgeRoutineCheck(gh: GitHub, file: string | null, deps: JudgeRoutineDeps): Promise<JudgeRoutineDecision> {
  let text: string | null = null;
  if (file !== null) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      fail([`入力のファイルを読めません: ${file}（${(e as Error).message}）`]);
    }
  }
  deps.git.fetchUnshallow();
  const decision = text === null ? await resolve(gh, deps) : await decideInput(gh, text, deps);
  console.log(JSON.stringify(decision, null, 2));
  return decision;
}

/** 判定する PR が決まったあとの確かめ（checkout）。head-checkout で skip か、null */
function checkout(deps: JudgeRoutineDeps, prHead: string): JudgeRoutineDecision | null {
  let checkoutHead: string;
  let headIsAncestorOfDefault: boolean;
  try {
    checkoutHead = deps.git.headSha();
    headIsAncestorOfDefault = deps.git.isAncestorOfDefault(deps.defaultBranch);
  } catch (e) {
    return { action: 'skip', reason: `head-checkout: checkout の HEAD を確かめられません（${(e as Error).message}）` };
  }
  return checkoutDecision({ headIsAncestorOfDefault, checkoutHead, prHead });
}

async function decideInput(gh: GitHub, text: string, deps: JudgeRoutineDeps): Promise<JudgeRoutineDecision> {
  const parsed = parseJudgeRoutineInput(text);
  if (!parsed.ok) return { action: 'skip', reason: parsed.reason };
  const input: JudgeRoutineInput = parsed.value;
  const pr = await gh.get<PullRequest | null>(`/pulls/${input.pr}`, { allow404: true });
  if (pr === null) return { action: 'skip', reason: `PR #${input.pr} が見つかりません（404）` };
  const checked = checkJudgeRoutineInput(input, { state: pr.state, merged: pr.merged, headSha: pr.head.sha, baseRef: pr.base.ref, draft: pr.draft }, (judged) => deps.samePatch(pr, judged));
  if (checked.action === 'skip') return checked;
  const comments = await gh.listComments(input.pr);
  const judged = judgedSkip(pr.head.sha, previousVerdict(comments).verdict?.headSha ?? null, (h) => deps.samePatch(pr, h));
  if (judged) return judged;
  return checkout(deps, pr.head.sha) ?? checked;
}

/** 入力が無いとき：開いた PR から判定する PR を1つ選ぶ */
async function resolve(gh: GitHub, deps: JudgeRoutineDeps): Promise<JudgeRoutineDecision> {
  const prs = await gh.paginate<PullRequest>('/pulls?state=open');
  const candidates: RoutineCandidate[] = [];
  for (const pr of prs) {
    if (!pr.draft || !pr.head.ref.startsWith('claude/')) continue;
    const comments = await gh.listComments(pr.number);
    const latest = previousVerdict(comments).verdict?.headSha ?? null;
    // patch-id は、最新の判定があってその head が今の head と違うときだけ比べる（同じ head なら true、判定が無ければ false）
    const samePatchAsVerdict = latest === null ? false : latest === pr.head.sha ? true : deps.samePatch(pr, latest);
    candidates.push({ number: pr.number, headSha: pr.head.sha, headRef: pr.head.ref, draft: pr.draft, updatedAt: pr.updated_at, claim: claimOf(comments), latestVerdictHead: latest, samePatchAsVerdict });
  }
  const c = selectRoutineCandidate(candidates, deps.age);
  if (c === null) return { action: 'skip', reason: 'no-candidate: 判定する PR がありません' };
  const judged = judgedSkip(c.headSha, c.latestVerdictHead, () => c.samePatchAsVerdict);
  if (judged) return judged;
  return checkout(deps, c.headSha) ?? { action: 'judge', pr: c.number, head: c.headSha, inputHead: c.headSha, dryRun: false };
}

export const commands: AgentCommand[] = [
  {
    name: 'judge-routine-check',
    run: async (args, ctx) => {
      if (args.length > 1) fail(['judge-routine-check [<入力のファイル>]']);
      await runJudgeRoutineCheck(ctx.gh(), args[0] ?? null, defaultJudgeRoutineDeps());
    },
  },
];
