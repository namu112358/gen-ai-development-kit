import { readFileSync } from 'node:fs';
import { acceptedAcChange } from '../../../lib/accepted-ac-change.ts';
import { parseChildMarker } from '../../../lib/epic.ts';
import { GitHub } from '../../../lib/github.ts';
import { pastPrsFor } from '../../../lib/past-pr-reads.ts';
import { checkJudgeInput, type CheckRun, composeVerdict, epicChildrenFromRecords, type JudgeFacts, lowerLayers, type ParentEpic, parseComposeArgs, type PrCommit, readAuthorViewFile, renderJudgeInput, type StackFacts } from '../../../lib/session-inputs.ts';
import { classifyBase, stackOf } from '../../../lib/stack.ts';
import { appLogin, LABELS, type HarnessConfig } from '../../../lib/config.ts';
import { changedFiles, linkedIssues, type PullRequest, timeline, type TimelineEvent } from '../../../lib/state.ts';
import { type AgentCommand, config, currentSession, fail, type IssueItem, readJson, renderVerdict, samePatchAsCurrent, sessionUrl, writeTemp } from '../cli.ts';

/**
 * 判定の段階（Reviewer の入力・判定コメントの組み立てと投稿）。
 *
 *   node harness/scripts/agent.ts post-verdict <pr> <file>  判定コメントを検査して投稿。headSha が現在の head と違っても PR 自身の差分（patch-id）が同じなら
 *                                                           判定した head のまま投稿する。違えば止まる
 *                                                           --dry-run（位置は問わない）を付けると、同じ検査の後に組み立てた本文を { dryRun: true, body } で出し、投稿しない（Issue #786）
 *   node harness/scripts/agent.ts judge-input <pr>          Reviewer に渡す入力（head、Closes する Issue の本文とコラボレーターのコメント〔計画コメントの agent-plan ブロックは省く〕、
 *                                                           Epic の子課題なら親 Epic〔子課題の一覧と Validation Requirements〕、計画ゲートの記録の計画、PR 本文、
 *                                                           PR のコラボレーターのコメント〔判定コメントを除く〕、agent/scope の結果、前回の判定の head とブロッキング指摘、
 *                                                           前回の head の後の main の取り込みの有無、PR の状態、変更ファイル（先頭 30 件）を触った Merge 済みの過去の PR
 *                                                           〔Merge の新しい順に最大 10 件〕のコラボレーターのコメント〔App・Claude の目印・空の本文を除き、
 *                                                           1件 1500 字・節全体 20000 字で切る〕。過去の PR の節は GraphQL でまとめて読む〔harness/lib/past-pr-reads.ts。#249〕）
 *                                                           をファイルに書き、パスを出力
 *                                                           人が受け入れた AC の変更があれば節「受け入れた AC の変更」も入る（harness/lib/accepted-ac-change.ts。決定の記録の
 *                                                           acChangeAccepted と、その後に App 以外のコラボレーターが agent:plan-review を外した事実の両方があるときだけ。
 *                                                           外した人の権限は GET /collaborators/{login}/permission が admin か write の login だけ〔失敗した login は入れない・
 *                                                           同じ login は1回だけ読む・unlabeled が無ければ API を呼ばない・App の login は呼ばない〕。無いときの理由は標準エラーに1行）
 *   node harness/scripts/agent.ts compose-verdict <pr> <reviewer.json> <risk.json> --judge-input <file> [--model <m>] [--author-view <file>]
 *                                                           サブエージェントの出力から判定コメントを作って検査し、ファイルのパスを出力（投稿は post-verdict）。
 *                                                           オプションの位置は問わない。judge-input のファイルの PR 番号が <pr> と違えば止まる。
 *                                                           判定した head は judge-input のファイルの headSha。現在の head と違っても PR 自身の差分（patch-id）が
 *                                                           同じなら判定した head のまま。違えば止まる。
 *                                                           metrics.judgedBy はセッション URL（無ければ「付き添いのセッション」）。
 *                                                           --author-view は PR を実装したセッションの見解のテキストのファイル（任意。前後の空白を除いて空なら止まる）。
 *                                                           agent-verdict の authorView に入り、auto mode の危険の問いの見解ありの問いにだけ渡る（結論には使わない。#426）
 */

export async function postVerdict(gh: GitHub, n: number, file: string, opts: { dryRun?: boolean } = {}): Promise<void> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const body = renderVerdict(n, pr.head.sha, file, (judged) => samePatchAsCurrent(pr, judged));
  if (opts.dryRun) {
    console.log(JSON.stringify({ dryRun: true, body }, null, 2));
    return;
  }
  const posted = await gh.comment(n, body);
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

/** agent:plan-review を外した App 以外の actor のうち、権限が admin か write の login（API が失敗した login は入れない。同じ login は1回だけ読む） */
async function collaboratorsWhoUnlabeled(gh: GitHub, cfg: HarnessConfig, events: TimelineEvent[], label: string): Promise<Set<string>> {
  const logins = new Set<string>();
  for (const e of events) {
    const login = e.actor?.login;
    if (e.event === 'unlabeled' && e.label?.name === label && login && login !== appLogin(cfg)) logins.add(login);
  }
  const out = new Set<string>();
  for (const login of logins) {
    try {
      const r = await gh.get<{ permission?: string }>(`/collaborators/${encodeURIComponent(login)}/permission`);
      if (r.permission === 'admin' || r.permission === 'write') out.add(login);
    } catch {
      // 確かめられない login はコラボレーターとして扱わない
    }
  }
  return out;
}

async function judgeInput(gh: GitHub, n: number): Promise<string> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const issues: JudgeFacts['issues'] = [];
  for (const i of await linkedIssues(gh, config, pr)) {
    const issue = await gh.get<IssueItem & { labels?: { name?: string }[] }>(`/issues/${i}`);
    const epic = await parentEpic(gh, issue.body);
    const comments = await gh.listComments(i);
    const events = await timeline(gh, i);
    const accepted = acceptedAcChange(config, {
      issue: i, comments, events, labels: issue.labels ?? [], collaborators: await collaboratorsWhoUnlabeled(gh, config, events, LABELS.planReview),
    });
    if (!accepted.value) console.error(`#${i}: 受け入れた AC の変更の節は入れません（${accepted.reason}）`);
    issues.push({ number: i, title: issue.title, body: issue.body, comments, acceptedAcChange: accepted.value, ...(epic ? { epic } : {}) });
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
  const { pr: n, reviewerFile, riskFile, judgeInput: inputFile, model, authorViewFile } = a.value;
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
    // 見解はファイルの前後の空白を除いて渡す（空なら parseVerdict が誤りにする）
    ...(authorViewFile === undefined ? {} : { authorView: readAuthorViewFile(authorViewFile) }),
  }, currentSession());
  if (!r.ok) fail(r.errors);
  return writeTemp(`verdict-${n}.md`, r.value);
}

export const commands: AgentCommand[] = [
  {
    name: 'post-verdict',
    run: (args, ctx) => {
      const dryRun = args.includes('--dry-run');
      const rest = args.filter((a) => a !== '--dry-run');
      return postVerdict(ctx.gh(), Number(rest[0]), rest[1]!, { dryRun });
    },
  },
  { name: 'judge-input', run: async (args, ctx) => void console.log(await judgeInput(ctx.gh(), Number(args[0]))) },
  { name: 'compose-verdict', run: async (args, ctx) => void console.log(await composeVerdictFile(ctx.gh(), args)) },
];
