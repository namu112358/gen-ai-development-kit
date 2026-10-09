/**
 * agent.ts step の判断（Issue #306）：GitHub の事実と段階のグラフ（flow.ts）から、今やってよいノードを1つだけ返す。GitHub を呼ばない純粋関数。
 * 段階は fleet の表と同じ issueNode（fleet.ts）で決め、前提（セッションの ID・担当・着手宣言）、ループの上限、同じ指摘の繰り返しをここで確かめる。
 * 宣言の投稿・解除と段階のファイルの書き込みは、呼び出し元（harness/scripts/agent.ts）がこの結果の claim・release・critique に従って行う。
 * 流れと止まる理由の一覧は docs/formats.md の「agent.ts step の出力」。
 */
import { issueNode, type FleetIssue } from './fleet.ts';
import type { FlowNodeId, FlowStep, FlowStopReason } from './flow.ts';
import { postClaim, type ClaimIo } from './claim.ts';
import { claimBlocker, isOwnClaim, type Claim, type ClaimStage } from './queue.ts';
import type { ReasonCode } from './config.ts';
import { TRANSCRIPT_SESSION_ID } from './session.ts';
import type { CritiqueRound } from './stage-file.ts';
import type { BlockingFinding } from './verdict.ts';

/** step が行わせるノード（作業をするノード） */
export type StepNodeId = 'plan' | 'plan-critique' | 'implement' | 'judge' | 'fix' | 'sync';

/** 段階のファイルの中だけで進む、plan と plan-critique の間の遷移（step --plan・step --critique） */
export type StepLocal =
  | { kind: 'none' }
  /** step --plan <file>：計画のファイルの書式の誤り（agent.ts check と同じ検査。無ければ空） */
  | { kind: 'plan'; errors: string[] }
  /** step --critique <file>：plan-critic の出力 */
  | { kind: 'critique'; round: CritiqueRound };

export interface StepInput {
  issue: FleetIssue;
  /** 今のセッションの ID（無ければ null） */
  session: string | null;
  /** 担当の確かめ（assignee.ts の checkAssignee）の止まる文。requireAssignee が無効か、自分1人なら null */
  assignee: string | null;
  /** 計画の触るファイルの領域の上限（concurrency.ts の fullAreas の説明）。当たらなければ null。implement の前だけ見る */
  areaFull: string | null;
  /**
   * 開いた PR の App の変更要求レビュー（kind=fix-request）の指摘。古い順、1つのレビューが1つの配列。
   * 読み方は report.ts の fixRequestFindings で、判定のゲート（harness/gates/on-comment.ts の renderBlockingReview）の本文の書式に依存する
   */
  fixRequests: BlockingFinding[][];
  /** 開いた PR の main からの取り込み（親が2つの commit）の数 */
  mergeCommits: number;
  /** PR（無ければ Issue）の agent:blocked の理由コード（App・Claude のコメントの最新の reasonMark）。無ければ null */
  blockedReason: ReasonCode | null;
  /** 開いた PR の head のブランチ（無ければ null） */
  prBranch: string | null;
  /** sync ⇄ judge の上限（config.ts の syncLoopConfig） */
  syncLimit: number;
  /** 段階のファイルから引き継いだ批評の回（stage-file.ts の carriedCritique） */
  critique: CritiqueRound[];
  local: StepLocal;
  /** --proceed：人が agent:plan-review の計画を進めると決めた */
  proceed: boolean;
  now: Date;
  humanClaimStaleHours: number;
  /**
   * このセッションの読み込みが古いときの judge を止める文（harness/lib/harness-drift.ts の judgeBlock）。古くない・判断しないなら null か無し。
   * judge のノードの前だけ見て、宣言を出さずに stop（harness-stale。自分の宣言は解除する）を返す（Issue #199）
   */
  harnessStale?: string | null;
}

interface StepBase {
  version: 1;
  issue: number;
  pr: number | null;
  /** 今のノード（flow.ts のノード ID） */
  node: FlowNodeId;
}

export interface StepNodeResult extends StepBase {
  kind: 'node';
  node: StepNodeId;
  /** 使う skill（flow.ts の step） */
  skill: Exclude<FlowStep, 'none'>;
  /** 宣言する番号（Issue か PR）と段階。step が宣言を出す（同じ段階の自分の宣言があれば出さない） */
  claim: { target: number; stage: ClaimStage };
  /** step が確かめ済みの前提 */
  preconditions: string[];
  /** このノードで使ってよい操作 */
  allowed: string[];
  /** 読むもの */
  inputs: string[];
  /** 出すものの書式 */
  output: string;
  branch: string | null;
  branchPrefix: string;
  files: string[] | null;
}

export interface StepWaitResult extends StepBase {
  kind: 'wait';
  /** app＝App の結果待ち、human＝人（Merge・人の PR の修正）待ち、area-limit＝領域の上限、done＝Merge 済み（終わり） */
  waitingFor: 'app' | 'human' | 'area-limit' | 'done';
  detail: string;
}

export interface StepStopResult extends StepBase {
  kind: 'stop';
  reason: FlowStopReason;
  detail: string;
  /** step がこのセッションの宣言を解除したか */
  released: boolean;
}

export type StepResult = StepNodeResult | StepWaitResult | StepStopResult;

export interface StepDecision {
  result: StepResult;
  /** 投稿する宣言（node で、同じ段階の自分の宣言が無いときだけ） */
  claim: { target: number; stage: ClaimStage } | null;
  /** 解除する自分の宣言の番号（stop のときだけ） */
  release: number[];
  /** 段階のファイルに残す批評の回 */
  critique: CritiqueRound[];
}

/** 批評の回の上限（flow.ts の plan ⇄ plan-critique と同じ） */
export const CRITIQUE_LIMIT = 3;

const STEP = 'node harness/scripts/agent.ts step';

/** ノードごとの許す操作・入力・出力の書式（n は Issue 番号、pr は PR 番号） */
function spec(node: StepNodeId, n: number, pr: number | null, prefix: string, postPlan: boolean): Pick<StepNodeResult, 'allowed' | 'inputs' | 'output'> {
  switch (node) {
    case 'plan':
      return {
        allowed: ['node harness/scripts/agent.ts check <計画のファイル>', `${STEP} ${n} --plan <計画のファイル>`],
        inputs: [`gh issue view ${n} --comments（コラボレーターのコメントだけ）`, 'リポジトリ（触るファイル、参照元、テスト、docs）'],
        output: '計画のファイル（docs/formats.md の「計画（agent-plan）」。投稿はまだしない）',
      };
    case 'plan-critique':
      return {
        allowed: [
          `node harness/scripts/agent.ts critic-input ${n} <計画のファイル> [--previous <前回の批評>]`,
          'plan-critic サブエージェント',
          `${STEP} ${n} --critique <批評のファイル>`,
          ...(postPlan ? [`node harness/scripts/agent.ts post-plan ${n} <計画のファイル>`] : []),
        ],
        inputs: ['critic-input の出力のファイル', ...(postPlan ? ['批評が go か split になった計画（critique を書いて投稿する）'] : [])],
        output: postPlan ? '計画コメント（post-plan。docs/formats.md の「計画（agent-plan）」）' : 'plan-critic の出力（批評のファイル）',
      };
    case 'implement':
      return {
        allowed: [
          `node harness/scripts/agent.ts worktree ${prefix}<短い名前>`,
          'test-designer サブエージェント',
          'npm run check',
          'git add <ファイル> / git commit',
          `git push -u origin ${prefix}<短い名前>（force push しない）`,
          `node harness/scripts/agent.ts scope-check ${n}`,
          `node harness/scripts/agent.ts ensure-claim ${n}`,
          'gh pr create --draft --base <既定ブランチ>',
        ],
        inputs: [`node harness/scripts/agent.ts show-plan ${n}（計画の files が触ってよいファイル）`, 'Issue の AC と Validation Requirements'],
        output: `Closes #${n} 付きの Draft PR（.github/pull_request_template.md）`,
      };
    case 'judge':
      return {
        allowed: [
          `node harness/scripts/agent.ts judge-input ${pr}`,
          'reviewer・risk-agent サブエージェント',
          `node harness/scripts/agent.ts compose-verdict ${pr} <reviewer.json> <risk.json> --judge-input <file>`,
          `node harness/scripts/agent.ts post-verdict ${pr} <file>`,
        ],
        inputs: ['judge-input の出力のファイル'],
        output: '判定コメント（docs/formats.md の「判定（agent-verdict）」）',
      };
    case 'fix':
      return {
        allowed: [`node harness/scripts/agent.ts worktree <PR のブランチ>`, 'npm run check', 'git add <ファイル> / git commit', 'git push origin <PR のブランチ>（force push しない）', `gh pr comment ${pr}（何を直したか）`],
        inputs: [`App の最新の変更要求レビュー（kind=fix-request）と、現在の head へのコラボレーターのレビュー（gh api repos/{owner}/{repo}/pulls/${pr}/reviews）`, `node harness/scripts/agent.ts show-plan ${n}`],
        output: '指摘を直した commit の push と、何を直したかの PR のコメント',
      };
    case 'sync':
      return {
        allowed: [`node harness/scripts/agent.ts worktree <PR のブランチ>`, 'git fetch origin / git merge origin/<既定ブランチ>（rebase・force push しない）', 'npm run check', 'git push origin <PR のブランチ>（force push しない）', `gh pr comment ${pr}（取り込みと衝突の解消）`],
        inputs: ['衝突したファイルと、両方の変更の意図'],
        output: 'main を取り込んだ merge commit の push',
      };
  }
}

/** 2つの fix-request に共通する指摘（kind と file が同じ。file の無い指摘は kind と detail が同じ） */
export function repeatedFindings(prev: BlockingFinding[], latest: BlockingFinding[]): BlockingFinding[] {
  const same = (a: BlockingFinding, b: BlockingFinding): boolean =>
    a.kind === b.kind && (a.file !== undefined || b.file !== undefined ? a.file === b.file : a.detail.trim() === b.detail.trim());
  return latest.filter((b) => prev.some((a) => same(a, b)));
}

const describeFinding = (b: BlockingFinding): string => `${b.kind}${b.file ? ` ${b.file}` : ''}: ${b.detail}`;

/** 今やってよいノードを1つだけ決める */
export function decideStep(input: StepInput): StepDecision {
  const i = input.issue;
  const n = i.facts.number;
  const branchPrefix = `claude/issue-${n}-`;
  const base = (node: FlowNodeId, pr: number | null) => ({ version: 1 as const, issue: n, pr, node });
  let critique = [...input.critique];

  if (!input.session || !TRANSCRIPT_SESSION_ID.test(input.session)) {
    const detail = input.session
      ? 'このセッションの ID が付き添いのセッションの形ではありません（step は付き添いのセッション用。Routine は queue を使う）'
      : 'このセッションの ID が得られません（SessionStart の hook の AGENT_HARNESS_SESSION が要る）';
    return { result: { ...base('issue', null), kind: 'stop', reason: 'no-session', detail, released: false }, claim: null, release: [], critique };
  }
  const session = input.session;

  const at = issueNode(i, i.prs.some((p) => p.merged));
  const openPr = i.prs.find((p) => !p.merged && p.facts !== null) ?? null;
  const issueClaim: Claim | null = i.facts.claim;
  const prClaim: Claim | null = openPr?.facts?.claim ?? null;
  const ownClaims = [...(isOwnClaim(issueClaim, session) ? [n] : []), ...(openPr && isOwnClaim(prClaim, session) ? [openPr.number] : [])];

  const wait = (node: FlowNodeId, waitingFor: StepWaitResult['waitingFor'], detail: string): StepDecision =>
    ({ result: { ...base(node, at.pr), kind: 'wait', waitingFor, detail }, claim: null, release: [], critique });
  const stop = (node: FlowNodeId, reason: FlowStopReason, detail: string, releaseOwn = true): StepDecision => {
    const release = releaseOwn ? ownClaims : [];
    return { result: { ...base(node, at.pr), kind: 'stop', reason, detail, released: release.length > 0 }, claim: null, release, critique };
  };

  /** 前提を確かめて node を返す（担当 → 宣言の持ち主 → 投稿する宣言） */
  const run = (node: StepNodeId, extra: { postPlan?: boolean; inputs?: string[]; preconditions?: string[] } = {}): StepDecision => {
    const onPr = node === 'judge' || node === 'fix' || node === 'sync';
    const target = onPr ? at.pr! : n;
    const stage: ClaimStage = node;
    if (input.assignee) return stop(node, 'assignee', input.assignee);
    const current = onPr ? prClaim : issueClaim;
    const blocker = claimBlocker(current, session, { takeover: false, now: input.now, humanClaimStaleHours: input.humanClaimStaleHours });
    if (blocker) return stop(node, 'claimed', `#${target}: ${blocker}`, false);
    const s = spec(node, n, at.pr, branchPrefix, extra.postPlan === true);
    const result: StepNodeResult = {
      ...base(node, onPr ? at.pr : null),
      kind: 'node',
      node,
      skill: node === 'plan-critique' ? 'plan' : node,
      claim: { target, stage },
      preconditions: [
        'このセッションの ID がある',
        input.assignee === null ? '担当（Assignee）の食い違いが無い' : '',
        'ほかのセッションの有効な着手宣言が無い',
        ...(extra.preconditions ?? []),
      ].filter((x) => x !== ''),
      allowed: s.allowed,
      inputs: [...(extra.inputs ?? []), ...s.inputs],
      output: s.output,
      branch: onPr ? input.prBranch : null,
      branchPrefix,
      files: i.planFiles,
    };
    const already = isOwnClaim(current, session) && current?.stage === stage;
    return { result, claim: already ? null : { target, stage }, release: [], critique };
  };

  /** 計画を書く・批評する（段階のファイルの中の遷移） */
  const planning = (): StepDecision => {
    const local = input.local;
    if (local.kind === 'plan') {
      if (local.errors.length > 0) return run('plan', { inputs: [`計画のファイルの書式の誤り：${local.errors.join('、')}`] });
      return run('plan-critique', { preconditions: ['計画のファイルが書式の検査を通った'] });
    }
    if (local.kind === 'critique') {
      const prev = critique.at(-1) ?? null;
      const round = local.round;
      critique = [...critique, { verdict: round.verdict, must: [...round.must] }];
      if (round.verdict === 'go' || round.verdict === 'split') return run('plan-critique', { postPlan: true, preconditions: [`批評が ${round.verdict}（${critique.length} 回目）`] });
      if (round.verdict === 'drop') return stop('plan-critique', 'other', `plan-critic の判定が drop（${critique.length} 回目）。進める／直す／やめるを人が決める`, false);
      if (critique.length >= CRITIQUE_LIMIT && round.must.length > 0) {
        return stop('plan-critique', 'critique-limit', `${critique.length} 回目の批評でも必須の指摘が残る：${round.must.join(' / ')}`, false);
      }
      const same = prev ? round.must.filter((m) => prev.must.some((p) => p.trim() === m.trim())) : [];
      if (same.length > 0) return stop('plan-critique', 'repeated-finding', `前回と同じ必須の指摘が直っていない：${same.join(' / ')}`, false);
      return run('plan', { inputs: round.must.map((m) => `直す必須の指摘：${m}`) });
    }
    const last = critique.at(-1);
    if (last && (last.verdict === 'go' || last.verdict === 'split')) return run('plan-critique', { postPlan: true, preconditions: [`批評が ${last.verdict}（${critique.length} 回目）`] });
    if (last && last.verdict === 'revise') return run('plan', { inputs: last.must.map((m) => `直す必須の指摘：${m}`) });
    return run('plan');
  };

  if (at.humanPr) return wait(at.node, 'human', at.note ?? '人の PR（修正・取り込みは人が行う）');
  if (at.sync) {
    if (input.mergeCommits >= input.syncLimit) {
      return stop('sync', 'sync-limit', `PR の main からの取り込みが ${input.mergeCommits} 回（上限 ${input.syncLimit}、harness.config.json の syncLoop.limit）に達した後に、もう一度 sync が要る（${at.note ?? ''}）`);
    }
    return run('sync', { inputs: [at.note ?? 'main と衝突'] });
  }

  switch (at.node) {
    case 'merged':
      return wait('merged', 'done', at.note ?? 'Merge 済み');
    case 'stopped': {
      const reason: FlowStopReason = at.stopReason === 'blocked' && input.blockedReason === 'fix-limit' ? 'fix-limit' : at.stopReason ?? 'other';
      return stop('stopped', reason, at.note ?? '止まる印あり');
    }
    case 'plan-gate':
      return wait('plan-gate', 'app', at.note ?? 'App の計画ゲートの結果待ち');
    case 'verdict-pending':
    case 'merge-route-pending':
      return wait(at.node, 'app', at.note ?? 'App の結果待ち');
    case 'auto-merge':
      return wait('auto-merge', 'app', 'App の auto-merge で Merge されるのを待つ');
    case 'human-merge':
      return wait('human-merge', 'human', '人の Merge 待ち');
    case 'plan-review':
      if (input.local.kind !== 'none') return planning();
      if (input.proceed && i.facts.latestPlanAt !== null) {
        if (input.areaFull) return wait('plan-ok', 'area-limit', input.areaFull);
        return run('implement', { preconditions: ['人が agent:plan-review の計画を進めると決めた（--proceed）'] });
      }
      return stop('plan-review', 'plan-review', at.note ?? '計画ゲートで人の判断待ち');
    case 'issue':
      return planning();
    case 'plan-ok':
      if (input.areaFull) return wait('plan-ok', 'area-limit', input.areaFull);
      return run('implement', { preconditions: ['計画ゲートを通った（App の agent:plan-ok）'] });
    case 'judge':
      if (input.harnessStale) return stop('judge', 'harness-stale', input.harnessStale);
      return run('judge');
    case 'fix': {
      const [prev, latest] = input.fixRequests.slice(-2);
      const blockingFix = at.note === 'ブロッキング指摘';
      if (blockingFix && prev && latest) {
        const same = repeatedFindings(prev, latest);
        if (same.length > 0) return stop('fix', 'repeated-finding', `直近2つの変更要求レビューに同じ指摘がある：${same.map(describeFinding).join(' / ')}`);
      }
      return run('fix', { inputs: [at.note ?? 'ブロッキング指摘'] });
    }
  }
}

/** 宣言の投稿・解除に使う GitHub の操作と、宣言の本文の作り方 */
export interface StepClaimOptions {
  session: string;
  now: Date;
  humanClaimStaleHours: number;
  /** 宣言の値からコメントの本文を作る（agent.ts の renderClaim） */
  render: (value: Claim) => string;
  /** 投稿の後、読み直す前に待つ（テストで短くする。既定は claim.ts の待ち時間） */
  wait?: () => Promise<void>;
}

/**
 * decideStep の結果に従って宣言を投稿し（claim.ts の postClaim。読み直しで後の側なら stop claimed に変える）、stop なら自分の宣言を解除する。
 * 解除の本文は、このセッションの手動の宣言の値に released を付けたもの
 */
export async function applyStepClaims(io: ClaimIo, decision: StepDecision, opts: StepClaimOptions): Promise<StepResult> {
  let result = decision.result;
  if (decision.claim) {
    const r = await postClaim(io, decision.claim.target, {
      current: opts.session,
      manual: true,
      takeover: false,
      stage: decision.claim.stage,
      render: opts.render,
      now: opts.now,
      humanClaimStaleHours: opts.humanClaimStaleHours,
      ...(opts.wait ? { wait: opts.wait } : {}),
    });
    if (r.error) result = { version: 1, issue: result.issue, pr: result.pr, node: result.node, kind: 'stop', reason: 'claimed', detail: r.error, released: false };
  }
  for (const target of decision.release) {
    await io.comment(target, opts.render({ by: 'manual', at: opts.now.toISOString(), session: opts.session, released: true }));
  }
  return result;
}
