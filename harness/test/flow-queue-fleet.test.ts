import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABELS } from '../lib/config.ts';
import { FLEET_STAGES, fleetStatus, type FleetPr, type FleetRow } from '../lib/fleet.ts';
import { FLOW_EDGES, FLOW_NODES, queueActionKindOf, type FlowNode, type FlowNodeId, type FlowStep } from '../lib/flow.ts';
import { decideIssue, decidePr, type Action, type IssueFacts, type PrFacts } from '../lib/queue.ts';
import { KNOWN_DIVERGENCES, type FlowCase } from './support/flow-divergences.ts';

// queue（decideIssue・decidePr）と fleet（fleetStatus）の食い違いと、どちらも段階のグラフ（harness/lib/flow.ts）のノードに当たることの検査（Issue #201）

const opts = { currentSession: null, now: new Date('2026-09-26T12:00:00Z'), routineClaimTakeoverMinutes: 90, humanClaimStaleHours: 6 };
const nodes = FLOW_NODES as Record<FlowNodeId, FlowNode>;
const ids = Object.keys(FLOW_NODES) as FlowNodeId[];

const ISSUE_LABELS = ['none', 'hold', 'blocked', 'waiting', 'plan-review', 'epic', 'plan-ok'] as const;
const ISSUE_LABEL: Record<(typeof ISSUE_LABELS)[number], string | null> = {
  none: null, hold: LABELS.hold, blocked: LABELS.blocked, waiting: LABELS.waiting, 'plan-review': LABELS.planReview, epic: LABELS.epic, 'plan-ok': LABELS.planOk,
};
const PLAN_RECORDS = ['none', 'pending', 'pass', 'stop'] as const;
const PLAN_AT = '2026-09-26T01:00:00Z';
const GATE_AT = '2026-09-26T01:01:00Z';
const PR_NUMBER = 10;

function issueFacts(label: (typeof ISSUE_LABELS)[number], blockers: boolean, plan: (typeof PLAN_RECORDS)[number], planOkByApp: boolean, openPr: number | null): IssueFacts {
  const extra = ISSUE_LABEL[label];
  return {
    number: 1, title: 't1', labels: extra === null ? [LABELS.ready] : [LABELS.ready, extra], readyAt: '2026-09-26T00:00:00Z', claim: null,
    openBlockers: blockers ? [99] : [],
    gate: plan === 'pass' || plan === 'stop' ? { pass: plan === 'pass', planCommentId: 5, at: GATE_AT } : null,
    latestPlanAt: plan === 'none' ? null : PLAN_AT,
    planOkByApp, openPr, areaFull: null,
  };
}

interface PrShape {
  label: 'none' | 'hold' | 'blocked';
  agent: boolean;
  conflicted: boolean;
  acceptance: 'none' | 'pass' | 'fail';
  awaiting: boolean;
  feedback: 0 | 1;
  draft: boolean;
  autoMerge: boolean;
  humanReview: boolean;
}

function prFacts(s: PrShape, issueLabels: string[]): PrFacts {
  return {
    number: PR_NUMBER, agent: s.agent, conflicted: s.conflicted, issueLabels, claim: null, issue: 1, readyAt: '2026-09-26T00:00:00Z',
    labels: s.label === 'none' ? [] : [s.label === 'hold' ? LABELS.hold : LABELS.blocked], headSha: 'h', headPushedAt: '2026-09-26T02:00:00Z',
    acceptance: s.acceptance === 'none' ? null : { reviewPass: s.acceptance === 'pass', at: '2026-09-26T02:10:00Z' },
    verdictAwaitingGate: s.awaiting, humanFeedbackSincePush: s.feedback,
  };
}

const fleetPr = (s: PrShape, issueLabels: string[]): FleetPr => ({
  number: PR_NUMBER, merged: false, draft: s.draft, autoMerge: s.autoMerge, humanReview: s.humanReview, behindMain: false, facts: prFacts(s, issueLabels),
});

const bools = [false, true] as const;

/** PR 側の組み合わせ。withMergeRoute なら fleet だけが見る draft・autoMerge・humanReview も組み合わせる（queue との比較では固定） */
function* prShapes(withMergeRoute: boolean): Generator<PrShape> {
  const route = withMergeRoute
    ? bools.flatMap((draft) => bools.flatMap((autoMerge) => bools.map((humanReview) => ({ draft, autoMerge, humanReview }))))
    : [{ draft: true, autoMerge: false, humanReview: false }];
  for (const label of ['none', 'hold', 'blocked'] as const)
    for (const agent of bools)
      for (const conflicted of bools)
        for (const acceptance of ['none', 'pass', 'fail'] as const)
          for (const awaiting of bools)
            for (const feedback of [0, 1] as const)
              for (const r of route) yield { label, agent, conflicted, acceptance, awaiting, feedback, ...r };
}

/** 総当たりの Issue と開いた PR の組 */
function* cases(withMergeRoute = false): Generator<FlowCase> {
  for (const label of ISSUE_LABELS)
    for (const blockers of bools)
      for (const plan of PLAN_RECORDS)
        for (const planOkByApp of bools) {
          yield { issue: issueFacts(label, blockers, plan, planOkByApp, null), pr: null };
          for (const s of prShapes(withMergeRoute)) {
            const issue = issueFacts(label, blockers, plan, planOkByApp, PR_NUMBER);
            yield { issue, pr: fleetPr(s, issue.labels) };
          }
        }
}

const rowOf = (c: FlowCase, closed = false): FleetRow =>
  fleetStatus({ issues: [{ facts: c.issue, closed, planFiles: null, prs: c.pr === null ? [] : [c.pr] }], prConflicts: [] })[0]!;

/** fleet の1行に対応する queue の判断：開いた PR が無ければ decideIssue、あれば decidePr */
const queueActionOf = (c: FlowCase): Action => (c.pr === null ? decideIssue(c.issue, opts) : decidePr(c.pr.facts!, opts));

/** queue の Action から step：plan・implement・judge・fix はそのまま、resolve-conflict は sync、wait-dependency と skip は none */
function stepOfAction(a: Action): FlowStep {
  switch (a.kind) {
    case 'plan': case 'implement': case 'judge': case 'fix': return a.kind;
    case 'resolve-conflict': return 'sync';
    case 'wait-dependency': case 'skip': return 'none';
  }
}

const describe = (c: FlowCase): string => {
  const f = c.pr?.facts;
  const pr = f ? ` PR{labels=${f.labels.join('+') || '-'} agent=${f.agent} conflicted=${f.conflicted} acc=${f.acceptance === null ? '-' : f.acceptance.reviewPass ? 'pass' : 'fail'} awaiting=${f.verdictAwaitingGate} feedback=${f.humanFeedbackSincePush} draft=${c.pr!.draft} autoMerge=${c.pr!.autoMerge} humanReview=${c.pr!.humanReview}}` : ' PR なし';
  return `Issue{labels=${c.issue.labels.join('+')} blockers=${c.issue.openBlockers.length} gate=${c.issue.gate === null ? '-' : c.issue.gate.pass ? 'pass' : 'stop'} plan=${c.issue.latestPlanAt ?? '-'} planOkByApp=${c.issue.planOkByApp}}${pr}`;
};

test('queue と fleet の次にやることの食い違いは、すべて KNOWN_DIVERGENCES のどれかに当たる', () => {
  const unexplained: string[] = [];
  const hits = new Map<string, number>(KNOWN_DIVERGENCES.map((d) => [d.id, 0]));
  let total = 0;
  for (const c of cases()) {
    total++;
    const queue = stepOfAction(queueActionOf(c));
    const fleet = rowOf(c).next;
    if (queue === fleet) continue;
    const matched = KNOWN_DIVERGENCES.filter((d) => d.applies(c));
    for (const d of matched) hits.set(d.id, hits.get(d.id)! + 1);
    if (matched.length === 0) unexplained.push(`queue=${queue} fleet=${fleet}: ${describe(c)}`);
  }
  assert.ok(total > 10_000, `総当たりの件数 ${total}`);
  assert.deepEqual(unexplained.slice(0, 20), [], `一覧に無い食い違い ${unexplained.length} 件（先頭 20 件）`);
  const neverHit = [...hits].filter(([, n]) => n === 0).map(([id]) => id);
  assert.deepEqual(neverHit, [], '総当たりで一度も食い違いに当たらない KNOWN_DIVERGENCES の項目（直ったなら一覧から消す）');
});

test('開いた PR がある Issue には、queue の decideIssue は何もしない（PR の段階は decidePr だけが決める）', () => {
  for (const c of cases()) {
    if (c.pr === null) continue;
    assert.equal(stepOfAction(decideIssue(c.issue, opts)), 'none', describe(c));
  }
});

/** 人の PR の上書きの note（`人の PR（fix は人が行う）`）から、上書きされる前の next を取り出す */
const overriddenNext = (note: string | null): FlowStep | null => {
  const m = note?.match(/^人の PR（(fix|sync) は人が行う）/);
  return m ? (m[1] as FlowStep) : null;
};

/** (stage, next) が段階のグラフに当たるか：あるノードの (fleetStage, step) か、next が sync なら同じ fleetStage のノードから sync へのエッジがある */
function inGraph(stage: string, next: FlowStep): boolean {
  if (ids.some((id) => nodes[id].fleetStage === stage && nodes[id].step === next)) return true;
  if (next === 'sync') return ids.some((id) => nodes[id].fleetStage === stage && FLOW_EDGES.some((e) => e.from === id && e.to === 'sync'));
  return false;
}

test('fleetStatus の (段階, 次にやること) は、どれも段階のグラフのノードに当たる（人の PR の上書きは上書きの前の値で見る）', () => {
  const missing = new Set<string>();
  const seenStages = new Set<string>();
  const check = (c: FlowCase, r: FleetRow): void => {
    seenStages.add(r.stage);
    const before = overriddenNext(r.note);
    if (before !== null) {
      assert.equal(r.next, 'none', `人の PR の上書きは none：${describe(c)}`);
      if (!inGraph(r.stage, before)) missing.add(`(${r.stage}, ${before}) 人の PR で none に上書き`);
      return;
    }
    if (!inGraph(r.stage, r.next)) missing.add(`(${r.stage}, ${r.next})`);
  };
  for (const c of cases(true)) check(c, rowOf(c));
  // Issue が Close 済み
  const closed = issueFacts('plan-ok', false, 'pass', true, null);
  check({ issue: closed, pr: null }, rowOf({ issue: closed, pr: null }, true));
  assert.deepEqual([...missing].sort(), [], 'グラフに無い fleet の (段階, 次にやること)');
  // 組み合わせが fleet の表の段階をすべて通る（human-merge・auto-merge・merged を含む）
  assert.deepEqual(Object.keys(FLEET_STAGES).filter((s) => !seenStages.has(s)), []);
});

test('queue の Action の kind（skip・wait-dependency 以外）は、どれもあるノードの step を queueActionKindOf で直したもの', () => {
  const fromGraph = new Set<string | null>(ids.map((id) => queueActionKindOf(nodes[id].step)));
  const kinds = new Set<string>();
  for (const c of cases()) {
    kinds.add(queueActionOf(c).kind);
    kinds.add(decideIssue(c.issue, opts).kind);
  }
  const missing = [...kinds].filter((k) => k !== 'skip' && k !== 'wait-dependency' && !fromGraph.has(k));
  assert.deepEqual(missing, []);
  // 総当たりが queue の kind をすべて通る
  assert.deepEqual([...kinds].sort(), ['fix', 'implement', 'judge', 'plan', 'resolve-conflict', 'skip', 'wait-dependency']);
});

test('fleet.ts の FLEET_STAGES のキーは、どれもあるノードの fleetStage', () => {
  const stages = new Set(ids.map((id) => nodes[id].fleetStage).filter((s) => s !== null));
  assert.deepEqual(Object.keys(FLEET_STAGES).filter((s) => !stages.has(s as never)), []);
});
