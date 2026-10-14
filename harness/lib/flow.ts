import type { ReasonCode } from './config.ts';

/**
 * 段階のノード（次にやること・fleet の表の段階）と止まる理由を置くデータ（Issue #201）。今やるノードは step.ts の decideStep が決める。
 * queue.ts・fleet.ts は、次にやること（step）と fleet の表の段階をここから引く。GitHub を呼ばない。
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

/** 止まる理由：ラベル・事実によるもの（hold・blocked・waiting・epic・依存）か、config.ts の REASON_CODES の理由コードか、agent.ts step だけが返す理由 */
export type FlowStopLabel = 'hold' | 'blocked' | 'waiting' | 'epic' | 'dependency';

/**
 * agent.ts step（harness/lib/step.ts）だけが返す止まる理由（Issue #306）。人に返す理由で、agent:blocked のコメントの理由コード（REASON_CODES）ではない。
 * no-session＝セッションの ID が得られない、assignee＝担当の食い違い、claimed＝ほかのセッションの宣言、plan-review＝計画ゲートの人の判断待ち、
 * sync-limit＝sync ⇄ judge の上限、repeated-finding＝同じ指摘の繰り返し、critique-limit＝批評の3回目でも必須が残る、harness-stale＝このセッションの読み込みが古いので judge を始めない（#199）
 */
export type FlowStepStopReason = 'no-session' | 'assignee' | 'claimed' | 'plan-review' | 'sync-limit' | 'repeated-finding' | 'critique-limit' | 'harness-stale';

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

