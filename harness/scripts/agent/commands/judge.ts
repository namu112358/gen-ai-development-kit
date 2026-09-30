import { readFileSync } from 'node:fs';
import { parseChildMarker } from '../../../lib/epic.ts';
import { GitHub } from '../../../lib/github.ts';
import { pastPrsFor } from '../../../lib/past-pr-reads.ts';
import { checkJudgeInput, type CheckRun, composeVerdict, epicChildrenFromRecords, type JudgeFacts, lowerLayers, type ParentEpic, parseComposeArgs, type PrCommit, renderJudgeInput, type StackFacts } from '../../../lib/session-inputs.ts';
import { classifyBase, stackOf } from '../../../lib/stack.ts';
import { changedFiles, linkedIssues, type PullRequest } from '../../../lib/state.ts';
import { type AgentCommand, config, currentSession, fail, type IssueItem, readJson, renderVerdict, samePatchAsCurrent, sessionUrl, writeTemp } from '../cli.ts';

/**
 * 判定の段階（Reviewer の入力・判定コメントの組み立てと投稿）。
 *
 *   node harness/scripts/agent.ts post-verdict <pr> <file>  判定コメントを検査して投稿。headSha が現在の head と違っても PR 自身の差分（patch-id）が同じなら
 *                                                           判定した head のまま投稿する。違えば止まる
 *   node harness/scripts/agent.ts judge-input <pr>          Reviewer に渡す入力（head、Closes する Issue の本文とコラボレーターのコメント〔計画コメントの agent-plan ブロックは省く〕、
 *                                                           Epic の子課題なら親 Epic〔子課題の一覧と Validation Requirements〕、計画ゲートの記録の計画、PR 本文、
 *                                                           PR のコラボレーターのコメント〔判定コメントを除く〕、agent/scope の結果、前回の判定の head とブロッキング指摘、
 *                                                           前回の head の後の main の取り込みの有無、PR の状態、変更ファイル（先頭 30 件）を触った Merge 済みの過去の PR
 *                                                           〔Merge の新しい順に最大 10 件〕のコラボレーターのコメント〔App・Claude の目印・空の本文を除き、
 *                                                           1件 1500 字・節全体 20000 字で切る〕。過去の PR の節は GraphQL でまとめて読む〔harness/lib/past-pr-reads.ts。#249〕）
 *                                                           をファイルに書き、パスを出力
 *   node harness/scripts/agent.ts compose-verdict <pr> <reviewer.json> <risk.json> --judge-input <file> [--model <m>]
 *                                                           サブエージェントの出力から判定コメントを作って検査し、ファイルのパスを出力（投稿は post-verdict）。
 *                                                           オプションの位置は問わない。judge-input のファイルの PR 番号が <pr> と違えば止まる。
 *                                                           判定した head は judge-input のファイルの headSha。現在の head と違っても PR 自身の差分（patch-id）が
 *                                                           同じなら判定した head のまま。違えば止まる。
 *                                                           metrics.judgedBy はセッション URL（無ければ「付き添いのセッション」）
 */

async function postVerdict(gh: GitHub, n: number, file: string): Promise<void> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const posted = await gh.comment(n, renderVerdict(n, pr.head.sha, file, (judged) => samePatchAsCurrent(pr, judged)));
  console.log(JSON.stringify({ posted: posted.html_url }, null, 2));
}

/** Epic の子課題なら親を読む。子課題の一覧は App の epic-split の記録から、無ければ Sub-issues の API から */
async function parentEpic(gh: GitHub, body: string | null): Promise<ParentEpic | undefined> {
  const mark = parseChildMarker(body);
  if (!mark) return undefined;
  const parent = await gh.get<IssueItem>(`/issues/${mark.parent}`);
  const recorded = epicChildrenFromRecords(config, await gh.listComments(mark.parent));
  if (recorded === null) {
    const subs = await gh.paginate<IssueItem>(`/issues/${mark.parent}/sub_issues`);
    return { number: mark.parent, title: parent.title, body: parent.body, children: subs.map((c) => ({ number: c.number, title: c.title })), childrenSource: 'sub-issues' };
  }
  const children: ParentEpic['children'] = [];
  for (const c of recorded) children.push({ number: c, title: (await gh.get<IssueItem>(`/issues/${c}`)).title });
  return { number: mark.parent, title: parent.title, body: parent.body, children, childrenSource: 'record' };
}

/** Stacked PR の層なら、base・位置と、下の層（PR 番号・base・変更ファイル）。層でなければ null */
async function stackFactsFor(gh: GitHub, pr: PullRequest): Promise<StackFacts | null> {
  const stack = stackOf(pr);
  if (classifyBase(pr, config.defaultBranch) !== 'stacked' || stack === null || stack === 'malformed') return null;
  const open = await gh.paginate<PullRequest>('/pulls?state=open');
  const lower: StackFacts['lower'] = [];
  for (const l of lowerLayers(open, pr, config.defaultBranch, `${gh.owner}/${gh.repo}`, stack.size)) {
    lower.push({ ...l, files: await changedFiles(gh, l.number) });
  }
  return { base: pr.base.ref, number: stack.number, position: stack.position, size: stack.size, lower };
}

async function judgeInput(gh: GitHub, n: number): Promise<string> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const issues: JudgeFacts['issues'] = [];
  for (const i of await linkedIssues(gh, config, pr)) {
    const issue = await gh.get<IssueItem>(`/issues/${i}`);
    const epic = await parentEpic(gh, issue.body);
    issues.push({ number: i, title: issue.title, body: issue.body, comments: await gh.listComments(i), ...(epic ? { epic } : {}) });
  }
  const text = renderJudgeInput(config, {
    pr: { number: n, headSha: pr.head.sha, body: pr.body, baseRef: pr.base.ref },
    issues,
    prComments: await gh.listComments(n),
    checkRuns: await gh.paginate<CheckRun>(`/commits/${pr.head.sha}/check-runs`),
    commits: await gh.paginate<PrCommit>(`/pulls/${n}/commits`),
    prState: { state: pr.state, draft: pr.draft, merged: pr.merged },
    pastPrs: await pastPrsFor(gh, config, n),
    stack: await stackFactsFor(gh, pr),
  });
  return writeTemp(`judge-input-${n}.txt`, text);
}

async function composeVerdictFile(gh: GitHub, args: string[]): Promise<string> {
  const a = parseComposeArgs(args);
  if (!a.ok) fail(a.errors);
  const { pr: n, reviewerFile, riskFile, judgeInput: inputFile, model } = a.value;
  const judged = checkJudgeInput(readFileSync(inputFile, 'utf8'), n);
  if (!judged.ok) fail(judged.errors.map((e) => `${inputFile}: ${e}`));
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  // head が違うときだけ、PR 自身の差分（patch-id）を比べる（main の取り込みだけなら判定した head のまま組み立てる）
  const samePatch = judged.value === pr.head.sha ? undefined : samePatchAsCurrent(pr, judged.value);
  const r = composeVerdict({
    pr: n,
    judgedHead: judged.value,
    currentHead: pr.head.sha,
    ...(samePatch === undefined ? {} : { samePatch }),
    reviewer: readJson(reviewerFile),
    risk: readJson(riskFile),
    meta: { model, judgedBy: sessionUrl() ?? '付き添いのセッション' },
  }, currentSession());
  if (!r.ok) fail(r.errors);
  return writeTemp(`verdict-${n}.md`, r.value);
}

export const commands: AgentCommand[] = [
  { name: 'post-verdict', run: (args, ctx) => postVerdict(ctx.gh(), Number(args[0]), args[1]!) },
  { name: 'judge-input', run: async (args, ctx) => void console.log(await judgeInput(ctx.gh(), Number(args[0]))) },
  { name: 'compose-verdict', run: async (args, ctx) => void console.log(await composeVerdictFile(ctx.gh(), args)) },
];
