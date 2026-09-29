/**
 * queue（decideIssue・decidePr）と fleet（fleetStatus）が、次にやること（step）で食い違うと分かっている組み合わせの一覧（Issue #201）。
 * flow-queue-fleet.test.ts が総当たりで比べ、どの項目にも当たらない食い違いと、総当たりで一度も当たらない項目を失敗にする。
 * 述語は食い違いの起きる事実だけに狭め、理由を書く。
 */
import { LABELS } from '../../lib/config.ts';
import type { FleetPr } from '../../lib/fleet.ts';
import type { IssueFacts, PrFacts } from '../../lib/queue.ts';

/** 総当たりの1件：Issue の事実と、開いた PR（無ければ null） */
export interface FlowCase {
  issue: IssueFacts;
  pr: FleetPr | null;
}

export interface KnownDivergence {
  id: string;
  /** なぜ食い違うか（どちらの見方か） */
  reason: string;
  applies: (c: FlowCase) => boolean;
}

/** 開いた PR の事実（無ければ null） */
const prFactsOf = (c: FlowCase): PrFacts | null => c.pr?.facts ?? null;
/** PR に止まる印（hold・blocked）が無い。あれば queue も fleet も止まるので食い違わない */
const prNotStopped = (f: PrFacts): boolean => !f.labels.includes(LABELS.hold) && !f.labels.includes(LABELS.blocked);

export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  {
    id: 'issue-stop-label-in-pr-stage',
    reason:
      'PR の段階では、Issue 側の止まる印（agent:hold・agent:blocked・agent:waiting・epic）を fleet（issueStage）だけが見て none にする。queue の decidePr は PR のラベルしか見ない（Issue の agent:plan-review と依存は PR の段階ではどちらも見ない）',
    applies: (c) => c.pr !== null && [LABELS.hold, LABELS.blocked, LABELS.waiting, LABELS.epic].some((l) => c.issue.labels.includes(l)),
  },
  {
    id: 'human-pr-conflict',
    reason: '人の PR が main と衝突しているとき、queue は受け付けが無ければ judge を返し、fleet は sync を「人の PR（sync は人が行う）」で none に上書きする',
    applies: (c) => {
      const f = prFactsOf(c);
      return f !== null && !f.agent && f.conflicted && f.acceptance === null && !f.verdictAwaitingGate && prNotStopped(f);
    },
  },
  {
    id: 'human-pr-review',
    reason: '人の PR に最後の push より後の人のレビューがあるとき、queue は受け付けが無ければ judge を返し、fleet は fix を「人の PR（fix は人が行う）」で none に上書きする',
    applies: (c) => {
      const f = prFactsOf(c);
      return f !== null && !f.agent && f.humanFeedbackSincePush > 0 && f.acceptance === null && !f.verdictAwaitingGate && prNotStopped(f);
    },
  },
  {
    id: 'agent-pr-rejected-awaiting-gate',
    reason:
      'Agent PR で不合格の受け付けの記録があり、新しい判定の受け付け待ち（verdictAwaitingGate）のとき、fleet は受け付けの記録を先に見て fix、queue は受け付け待ちを先に見て skip',
    applies: (c) => {
      const f = prFactsOf(c);
      return f !== null && f.agent && !f.conflicted && f.humanFeedbackSincePush === 0 && f.verdictAwaitingGate && f.acceptance !== null && !f.acceptance.reviewPass && prNotStopped(f);
    },
  },
];
