// 着手宣言の読む側のテストが共有する補助（#655）。同じ意味の「段階ごとに1コメントの一覧」と「history を持つ1件の宣言の一覧」を手で組む claimPair と、宣言のコメントの見本 claimComment
import { claudeMark, renderBlock } from '../../lib/blocks.ts';
import type { IssueComment } from '../../lib/github.ts';
import type { ClaimEntry, ClaimStage, StoredClaim } from '../../lib/queue.ts';

export const CLAIM_SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';

const commentOf = (id: number, body: string, createdAt: string): IssueComment =>
  ({ id, body, html_url: `c${id}`, created_at: createdAt, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } }) as IssueComment;

/** 宣言のコメント（Claude の目印・OWNER の作成者） */
export function claimComment(id: number, value: StoredClaim, createdAt: string): IssueComment {
  return commentOf(id, `${claudeMark(value.session ?? null)}\n着手宣言です。\n\n${renderBlock('agent-claim', value)}`, createdAt);
}

const planComment = (id: number, at: string): IssueComment =>
  commentOf(id, `${claudeMark(CLAIM_SESSION)}\n## 計画\n\n${renderBlock('agent-plan', { version: 1, issue: 655, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'] })}`, at);

export type ClaimStep = { claim: { stage?: ClaimStage; released?: true }; at: string } | { plan: true; at: string };

/**
 * 手順の並びから同じ意味の2つの一覧を作る。各手順に firstId から1ずつ同じ ID を振る。
 * perStage は手順ごとのコメント。rewritten は最初の宣言のコメントに2件目からの段階を after = その手順の ID − 1 で history に足したもの（計画は両方に同じ ID）。
 */
export function claimPair(steps: ClaimStep[], opts: { session?: string; firstId?: number } = {}): { perStage: IssueComment[]; rewritten: IssueComment[]; ids: number[] } {
  const session = opts.session ?? CLAIM_SESSION;
  const ids = steps.map((_, i) => (opts.firstId ?? 100) + i);
  const perStage: IssueComment[] = [];
  const rewritten: IssueComment[] = [];
  const history: ClaimEntry[] = [];
  let firstClaim: { id: number; at: string } | null = null;
  for (const [i, s] of steps.entries()) {
    const id = ids[i]!;
    if ('plan' in s) {
      perStage.push(planComment(id, s.at));
      rewritten.push(planComment(id, s.at));
      continue;
    }
    perStage.push(claimComment(id, { by: 'manual', session, at: s.at, ...s.claim } as StoredClaim, s.at));
    if (!firstClaim) firstClaim = { id, at: s.at };
    history.push(history.length === 0 ? { ...s.claim, at: s.at } : { ...s.claim, at: s.at, after: id - 1 });
  }
  if (firstClaim) {
    const { id, at } = firstClaim;
    const last = history.at(-1)!;
    const value = { by: 'manual', session, at: last.at, ...(last.stage ? { stage: last.stage } : {}), ...(last.released ? { released: true } : {}), history } as StoredClaim;
    rewritten.push(claimComment(id, value, at));
    rewritten.sort((a, b) => a.id - b.id);
  }
  return { perStage, rewritten, ids };
}
