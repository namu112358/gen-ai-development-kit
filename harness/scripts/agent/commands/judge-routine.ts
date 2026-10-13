import { readFileSync } from 'node:fs';
import { GitHub } from '../../../lib/github.ts';
import { checkJudgeRoutineInput, type JudgeRoutineDecision, type JudgeRoutineInput, parseJudgeRoutineInput } from '../../../lib/judge-routine.ts';
import type { PullRequest } from '../../../lib/state.ts';
import { type AgentCommand, fail, samePatchAsCurrent } from '../cli.ts';

/**
 * 判定の Routine の1回分（`/judge --routine`。Issue #786）の入力の検査。GitHub は REST の GET /pulls/{n} だけを読み、書き込まない。
 *
 *   node harness/scripts/agent.ts judge-routine-check <入力のファイル>
 *                                                           入力（{ pr, head, base, dryRun } の JSON。コードブロックに入っていてもよい）を、PR の今の状態と照らして
 *                                                           { action: 'judge', pr, head, inputHead, dryRun } か { action: 'skip', reason } を JSON で出す。
 *                                                           skip も終了コード 0（手順が action を見て止まる）。入力のファイルが読めないときだけ終了コード 2。
 *                                                           PR が open でない・base が違う・head が違い patch-id も違う・PR が 404、は skip。
 */

type SamePatch = (pr: PullRequest, judgedHead: string) => boolean;

export async function runJudgeRoutineCheck(gh: GitHub, file: string, samePatch: SamePatch = samePatchAsCurrent): Promise<JudgeRoutineDecision> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    fail([`入力のファイルを読めません: ${file}（${(e as Error).message}）`]);
  }
  const parsed = parseJudgeRoutineInput(text);
  const decision: JudgeRoutineDecision = !parsed.ok
    ? { action: 'skip', reason: parsed.reason }
    : await decide(gh, parsed.value, samePatch);
  console.log(JSON.stringify(decision, null, 2));
  return decision;
}

async function decide(gh: GitHub, input: JudgeRoutineInput, samePatch: SamePatch): Promise<JudgeRoutineDecision> {
  const pr = await gh.get<PullRequest | null>(`/pulls/${input.pr}`, { allow404: true });
  if (pr === null) return { action: 'skip', reason: `PR #${input.pr} が見つかりません（404）` };
  return checkJudgeRoutineInput(input, { state: pr.state, merged: pr.merged, headSha: pr.head.sha, baseRef: pr.base.ref }, (judged) => samePatch(pr, judged));
}

export const commands: AgentCommand[] = [
  {
    name: 'judge-routine-check',
    run: async (args, ctx) => {
      if (args.length !== 1) fail(['judge-routine-check <入力のファイル>']);
      await runJudgeRoutineCheck(ctx.gh(), args[0]!);
    },
  },
];
