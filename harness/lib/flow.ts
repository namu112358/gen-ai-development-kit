import type { ReasonCode } from './config.ts';

/**
 * 段階のグラフ（ノード・エッジ・ループの上限・止まる先の理由）を1か所に置いたデータ（Issue #201）。
 * queue.ts・fleet.ts は、次にやること（step）と fleet の表の段階をここから引く。GitHub を呼ばない。
 * 流れの説明は docs/plan.md の「段階の制御をコードに移す」、ship の skill、overview.html にもあるが、正はこのデータ。
 */

/** 次にやること（ship の段階の skill）。none は、今は何もしない（App・人・ほかの段階を待つ） */
export type FlowStep = 'plan' | 'implement' | 'judge' | 'fix' | 'sync' | 'none';

/** 強制のされ方：code＝App・Ruleset・hook がコードで止める、conditional＝条件つきでコードが確かめる、ai＝AI の手順だけ、human＝人が決める */
export type Enforcement = 'code' | 'conditional' | 'ai' | 'human';

/** fleet の表の段階（fleet.ts の FLEET_STAGES のキー） */
export type FlowFleetStage = 'no-plan' | 'plan-gate' | 'plan-review' | 'plan-ok' | 'judge' | 'fix' | 'human-merge' | 'auto-merge' | 'merged' | 'stopped';

export interface FlowNode {
  label: string;
  /** 終了条件（このノードを出てよいとき） */
  exit: string;
  enforcement: Enforcement;
  /** このノードにいるときに次にやること */
  step: FlowStep;
  /** fleet の表の段階。表に出ない作業中のノードと、段階を残して next だけを上書きする sync は null */
  fleetStage: FlowFleetStage | null;
  /** 終わり（ここから出るエッジが無くてよい） */
  terminal?: true;
}

export const FLOW_NODES = {
  issue: { label: 'Issue（計画なし）', exit: '計画に着手した（claim --stage plan）', enforcement: 'ai', step: 'plan', fleetStage: 'no-plan' },
  plan: { label: '計画', exit: '計画を書き、書式の検査（agent.ts check）を通した', enforcement: 'ai', step: 'plan', fleetStage: null },
  'plan-critique': { label: '批評', exit: 'plan-critic の判定が go か split（止める条件に当たれば人の判断）。App の批評の関所が、計画の critique と計画より前の plan-critique の宣言を確かめる', enforcement: 'conditional', step: 'plan', fleetStage: null },
  'plan-gate': { label: '計画ゲート', exit: 'App の計画ゲートの記録が付き、App が agent:plan-ok か agent:plan-review を付けた', enforcement: 'code', step: 'none', fleetStage: 'plan-gate' },
  'plan-review': { label: '人の判断（計画）', exit: '人が進めると決めた（決定の記録・委任承認を含む）か、計画を出し直した', enforcement: 'human', step: 'none', fleetStage: 'plan-review' },
  'plan-ok': { label: '計画ゲート通過', exit: '実装に着手した（claim --stage implement）', enforcement: 'ai', step: 'implement', fleetStage: 'plan-ok' },
  implement: { label: '実装', exit: 'Closes 付きの Draft PR を出した', enforcement: 'ai', step: 'implement', fleetStage: null },
  judge: { label: '判定', exit: '現在の head（patch-id）に対する判定コメントを投稿した', enforcement: 'conditional', step: 'judge', fleetStage: 'judge' },
  'verdict-pending': { label: '判定の受け付け待ち', exit: 'App が判定を受け付けた（kind=acceptance）か却下した', enforcement: 'code', step: 'none', fleetStage: 'judge' },
  'merge-route-pending': { label: '合格・Merge の経路待ち', exit: 'App が auto-merge を付けたか、kind=human-review のコメントを付けた', enforcement: 'code', step: 'none', fleetStage: 'judge' },
  fix: { label: '修正', exit: 'ブロッキング指摘・人のレビューを直して push した（修正の回数の上限は App が数える）', enforcement: 'conditional', step: 'fix', fleetStage: 'fix' },
  sync: { label: 'main の取り込み', exit: 'main を取り込んで push し、衝突が無い', enforcement: 'ai', step: 'sync', fleetStage: null },
  'human-merge': { label: '人の Merge 待ち', exit: '人が Merge した', enforcement: 'human', step: 'none', fleetStage: 'human-merge' },
  'auto-merge': { label: '自動 Merge 待ち', exit: 'App の auto-merge で Merge された', enforcement: 'code', step: 'none', fleetStage: 'auto-merge' },
  merged: { label: 'Merge 済み', exit: '（終わり）', enforcement: 'code', step: 'none', fleetStage: 'merged', terminal: true },
  stopped: { label: '止まる印あり', exit: '人が止まる印を外したか、依存が片付いた', enforcement: 'human', step: 'none', fleetStage: 'stopped' },
} as const satisfies Record<string, FlowNode>;

export type FlowNodeId = keyof typeof FLOW_NODES;

export interface FlowEdge {
  from: FlowNodeId;
  to: FlowNodeId;
  /** 条件の短い文 */
  when: string;
}

/** 行き先と条件（止まる先へのエッジは FLOW_STOPS） */
export const FLOW_EDGES: readonly FlowEdge[] = [
  { from: 'issue', to: 'plan', when: '計画が無い' },
  { from: 'plan', to: 'plan-critique', when: '計画を書いた' },
  { from: 'plan-critique', to: 'plan', when: '批評が revise（指摘を直してもう一度）' },
  { from: 'plan-critique', to: 'plan-gate', when: '批評が go か split で、post-plan で投稿した' },
  { from: 'plan-gate', to: 'plan-ok', when: 'App が agent:plan-ok を付けた' },
  { from: 'plan-review', to: 'plan-ok', when: '人が進めると決めた（決定の記録を App が確かめた・委任承認）' },
  { from: 'plan-review', to: 'plan', when: '計画を出し直す' },
  { from: 'plan-ok', to: 'implement', when: '実装に着手した' },
  { from: 'implement', to: 'judge', when: 'Draft PR を出した' },
  { from: 'judge', to: 'verdict-pending', when: '判定コメントを投稿した' },
  { from: 'verdict-pending', to: 'fix', when: '受け付けの記録が不合格（kind=fix-request）' },
  { from: 'verdict-pending', to: 'merge-route-pending', when: '受け付けの記録が合格' },
  { from: 'fix', to: 'judge', when: '直して push した' },
  { from: 'judge', to: 'sync', when: 'main と衝突している、または Merge 済みの PR があり main に追従していない' },
  { from: 'verdict-pending', to: 'sync', when: 'main と衝突している、または Merge 済みの PR があり main に追従していない' },
  { from: 'merge-route-pending', to: 'sync', when: 'main と衝突している、または Merge 済みの PR があり main に追従していない' },
  { from: 'fix', to: 'sync', when: 'main と衝突している、または Merge 済みの PR があり main に追従していない' },
  { from: 'human-merge', to: 'sync', when: 'main と衝突している、または Merge 済みの PR があり main に追従していない（段階は残し、次にやることだけ sync）' },
  { from: 'auto-merge', to: 'sync', when: 'main と衝突している、または Merge 済みの PR があり main に追従していない（段階は残し、次にやることだけ sync）' },
  { from: 'judge', to: 'fix', when: '最後の push より後に人のレビューがある' },
  { from: 'sync', to: 'judge', when: '取り込んだ（差分が変われば判定し直す）' },
  { from: 'merge-route-pending', to: 'human-merge', when: 'App が kind=human-review のコメントを付け、PR が Ready' },
  { from: 'merge-route-pending', to: 'auto-merge', when: 'App が auto-merge を付けた' },
  { from: 'human-merge', to: 'merged', when: '人が Merge した' },
  { from: 'auto-merge', to: 'merged', when: 'auto-merge で Merge された' },
  { from: 'stopped', to: 'issue', when: '人が止まる印を外したか、依存が片付いた（今の状態から段階を決め直す）' },
];

/** 止まる理由：ラベル・事実によるもの（hold・blocked・waiting・epic・依存）か、config.ts の REASON_CODES の理由コードか、agent.ts step だけが返す理由 */
export type FlowStopLabel = 'hold' | 'blocked' | 'waiting' | 'epic' | 'dependency';
export const FLOW_STOP_LABELS: readonly FlowStopLabel[] = ['hold', 'blocked', 'waiting', 'epic', 'dependency'];

/**
 * agent.ts step（harness/lib/step.ts）だけが返す止まる理由（Issue #306）。人に返す理由で、agent:blocked のコメントの理由コード（REASON_CODES）ではない。
 * no-session＝セッションの ID が得られない、assignee＝担当の食い違い、claimed＝ほかのセッションの宣言、plan-review＝計画ゲートの人の判断待ち、
 * sync-limit＝sync ⇄ judge の上限、repeated-finding＝同じ指摘の繰り返し、critique-limit＝批評の3回目でも必須が残る、harness-stale＝このセッションの読み込みが古いので judge を始めない（#199）
 */
export type FlowStepStopReason = 'no-session' | 'assignee' | 'claimed' | 'plan-review' | 'sync-limit' | 'repeated-finding' | 'critique-limit' | 'harness-stale';
export const FLOW_STEP_STOP_REASONS: readonly FlowStepStopReason[] = ['no-session', 'assignee', 'claimed', 'plan-review', 'sync-limit', 'repeated-finding', 'critique-limit', 'harness-stale'];

export type FlowStopReason = FlowStopLabel | ReasonCode | FlowStepStopReason;

export interface FlowStop {
  from: readonly FlowNodeId[];
  to: 'stopped' | 'plan-review';
  reasons: readonly FlowStopReason[];
}

/** 止まる先へのエッジと、そのとき残る理由 */
export const FLOW_STOPS: readonly FlowStop[] = [
  { from: ['issue', 'plan-gate', 'plan-review', 'plan-ok'], to: 'stopped', reasons: ['hold', 'blocked', 'waiting', 'epic', 'dependency'] },
  { from: ['judge', 'verdict-pending', 'merge-route-pending', 'fix', 'sync'], to: 'stopped', reasons: ['hold', 'blocked', 'orphan-base', 'external'] },
  { from: ['fix'], to: 'stopped', reasons: ['fix-limit'] },
  { from: ['plan-critique'], to: 'plan-review', reasons: ['needs-decision'] },
  { from: ['plan-gate'], to: 'plan-review', reasons: ['plan-invalid', 'needs-decision', 'high-risk', 'no-critique', 'split-invalid', 'resplit', 'split-failed', 'other'] },
  { from: ['issue'], to: 'stopped', reasons: ['form-error'] },
  // agent.ts step の止まり方（Issue #306）
  { from: ['issue', 'plan', 'plan-critique', 'plan-ok', 'judge', 'fix', 'sync'], to: 'stopped', reasons: ['no-session', 'assignee', 'claimed'] },
  { from: ['plan-gate'], to: 'plan-review', reasons: ['plan-review'] },
  { from: ['plan-critique'], to: 'plan-review', reasons: ['critique-limit', 'repeated-finding'] },
  { from: ['fix'], to: 'stopped', reasons: ['repeated-finding'] },
  { from: ['sync'], to: 'stopped', reasons: ['sync-limit'] },
  // 読み込みが古いので judge を始めない（#199）
  { from: ['judge'], to: 'stopped', reasons: ['harness-stale'] },
];

export interface FlowLoop {
  nodes: readonly [FlowNodeId, FlowNodeId];
  /** 回数の上限。数値、harness.config.json のキー、または上限なし（null） */
  limit: number | { config: 'fixLoop.normalLimit' | 'fixLoop.criticalLimit' | 'syncLoop.limit' }[] | null;
  /** 上限を超えたときの止まる理由（上限なしなら null） */
  stop: FlowStopReason | null;
  note: string;
}

/** ループと上限 */
export const FLOW_LOOPS: readonly FlowLoop[] = [
  { nodes: ['plan', 'plan-critique'], limit: 3, stop: 'critique-limit', note: '3回目でも必須の指摘が残るか、前回と同じ必須の指摘が直っていなければ止める。Routine は needs-decision（.claude/routine.md の plan の render-block）、有人セッションの step は critique-limit・repeated-finding を返し、人に聞く' },
  { nodes: ['fix', 'judge'], limit: [{ config: 'fixLoop.normalLimit' }, { config: 'fixLoop.criticalLimit' }], stop: 'fix-limit', note: '修正の回数は App が数え、上限で agent:blocked にする（critical は criticalLimit）' },
  { nodes: ['sync', 'judge'], limit: [{ config: 'syncLoop.limit' }], stop: 'sync-limit', note: 'PR の main からの取り込み（親が2つの commit）が harness.config.json の syncLoop.limit（無ければ 3）に達した後に、もう一度 sync が要れば agent.ts step が止める（#306）' },
];

/** ノードの次にやること（リテラルの型のまま返す） */
export function stepOf<N extends FlowNodeId>(node: N): (typeof FLOW_NODES)[N]['step'] {
  return FLOW_NODES[node].step;
}

/** ノードの fleet の表の段階（表に出ないノードは null） */
export function fleetStageOf<N extends FlowNodeId>(node: N): (typeof FLOW_NODES)[N]['fleetStage'] {
  return FLOW_NODES[node].fleetStage;
}

/** queue.ts の Action の kind。sync は resolve-conflict、none は null、ほかは同じ名前 */
export type QueueActionKind<S extends FlowStep> = S extends 'sync' ? 'resolve-conflict' : S extends 'none' ? null : S;

export function queueActionKindOf<S extends FlowStep>(step: S): QueueActionKind<S> {
  return (step === 'sync' ? 'resolve-conflict' : step === 'none' ? null : step) as QueueActionKind<S>;
}

/** step の作業をするノード（step が none 以外のときの行き先） */
export function stepNode(step: Exclude<FlowStep, 'none'>): FlowNodeId {
  return step;
}
