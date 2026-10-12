import { createHash } from 'node:crypto';
import { extractBlock } from './blocks.ts';
import { appLogin, type HarnessConfig, LABELS } from './config.ts';
import { type DecisionAcChangeAccepted, parseDecision } from './decision.ts';
import type { IssueComment } from './github.ts';
import { hasLabel, isAppComment, isTrustedComment, latestPlanGate, type TimelineEvent } from './state.ts';

/**
 * 人が受け入れた AC の変更の提案を、judge が照らす AC にするかの判断（Issue #869）。GitHub を呼ばない。
 * 値を返すのは、次の2つの印が両方そろうときだけ（片方だけでは返さない。どちらも人の名義で書けるため）。
 *   (A) 決定の記録（agent-decision）の acChangeAccepted：最新の計画ゲートの記録の計画コメントを指し、その記録のコメントより後に、
 *       コラボレーター（App 以外）が書き、書いた後に編集されていない（updated_at が created_at と同じ）。計画ゲートの記録は acChangeProposed で、
 *       計画コメントの今の本文がゲートの見た本文（planBodySha256）と同じ
 *   (B) その決定の記録より後に、App 以外のコラボレーター（collaborators に入る login）が agent:plan-review を外し、その後に付け直されず、今も付いていない
 * 提案の本文は計画コメントの見出しが「AC の変更の提案」で始まる節だけ。見出しが無い・節が空なら返さない。
 * App の受け付け・計画ゲートはこの関数を使わない（Merge の経路は変わらない）。
 */

export interface AcceptedAcChange {
  issue: number;
  planCommentId: number;
  planCommentUrl: string;
  gateRecordUrl: string;
  proposal: string;
  decision: { commentId: number; url: string; accepted: DecisionAcChangeAccepted };
  unlabeled: { login: string; at: string };
}

export interface AcceptedAcChangeInput {
  issue: number;
  comments: IssueComment[];
  events: TimelineEvent[];
  labels: ({ name?: string } | string)[];
  /** 権限が admin か write の login */
  collaborators: ReadonlySet<string>;
}

export interface AcceptedAcChangeResult {
  value: AcceptedAcChange | null;
  /** value が null の理由（1行）。value があれば null */
  reason: string | null;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^(`{3,})/;
const TITLE = 'AC の変更の提案';

/** 計画コメントの見出しのうち「AC の変更の提案」で始まる最初のものから、同じかより上の段の次の見出しの前まで（agent-plan ブロックは省く）。無い・空なら null */
export function acChangeProposal(body: string): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let level = 0;
  let fence: string | null = null;
  let fenceKind = false;
  let started = false;
  for (const line of lines) {
    const f = line.match(FENCE);
    if (fence === null && f) {
      fence = f[1]!;
      fenceKind = /^`{3,}[ \t]*agent-plan[ \t]*$/.test(line);
      if (started && !fenceKind) kept.push(line);
      continue;
    }
    if (fence !== null) {
      if (line.startsWith(fence) && line.slice(fence.length).trim() === '') {
        fence = null;
        if (started && !fenceKind) kept.push(line);
        fenceKind = false;
      } else if (started && !fenceKind) kept.push(line);
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      if (started) {
        if (h[1]!.length <= level) break;
      } else if (h[2]!.trim().startsWith(TITLE)) {
        started = true;
        level = h[1]!.length;
        continue;
      }
    }
    if (started) kept.push(line);
  }
  const text = kept.join('\n').trim();
  return started && text !== '' ? text : null;
}

const none = (reason: string): AcceptedAcChangeResult => ({ value: null, reason });
const at = (s: string | undefined | null): number => (s ? Date.parse(s) : Number.NaN);

export function acceptedAcChange(config: HarnessConfig, input: AcceptedAcChangeInput): AcceptedAcChangeResult {
  const gate = latestPlanGate(config, input.comments);
  const record = gate?.value as { planCommentId: number; planBodySha256?: string; plan?: { acChangeProposed?: boolean } } | undefined;
  if (!gate || !record) return none('計画ゲートの記録がありません');
  if (record.plan?.acChangeProposed !== true) return none('最新の計画ゲートの記録の計画が AC の変更を提案していません');
  const planComment = input.comments.find((c) => c.id === record.planCommentId);
  if (!planComment) return none('計画ゲートの記録の計画コメントがありません');
  if (!record.planBodySha256 || createHash('sha256').update(planComment.body).digest('hex') !== record.planBodySha256) {
    return none('計画コメントがゲートの後に編集されたか、記録に planBodySha256 がありません');
  }

  const found = input.comments
    .filter((c) => c.id !== gate.comment.id && isTrustedComment(c) && !isAppComment(config, c) && at(c.created_at) > at(gate.comment.created_at))
    .flatMap((c) => {
      const block = extractBlock(c.body, 'agent-decision');
      if (!block.found || !block.ok) return [];
      const d = parseDecision(block.value);
      if (!d.ok || d.value.issue !== input.issue || d.value.planCommentId !== record.planCommentId || !d.value.proceed || !d.value.acChangeAccepted) return [];
      if (c.updated_at !== c.created_at) return [];
      return [{ comment: c, accepted: d.value.acChangeAccepted }];
    })
    .sort((a, b) => at(a.comment.created_at) - at(b.comment.created_at))
    .at(-1);
  if (!found) return none('受け入れた決定の記録（acChangeAccepted）がありません（無い・計画コメントが違う・ゲートより前・編集された・コラボレーターの記録でない）');

  if (hasLabel(input, LABELS.planReview)) return none(`${LABELS.planReview} が付いたままです`);
  const last = input.events.filter((e) => e.label?.name === LABELS.planReview && (e.event === 'labeled' || e.event === 'unlabeled')).at(-1);
  if (!last || last.event !== 'unlabeled') return none(`${LABELS.planReview} を外した事実がありません（外した後に付け直されたものを含む）`);
  const login = last.actor?.login;
  if (!login || login === appLogin(config) || !input.collaborators.has(login)) return none(`${LABELS.planReview} を外したのが App かコラボレーターでありません`);
  if (!(at(last.created_at) > at(found.comment.created_at))) return none(`${LABELS.planReview} を外したのが決定の記録より後ではありません`);

  const proposal = acChangeProposal(planComment.body);
  if (proposal === null) return none(`計画コメントに見出し「${TITLE}」の節がありません（空を含む）`);

  return {
    reason: null,
    value: {
      issue: input.issue,
      planCommentId: planComment.id,
      planCommentUrl: planComment.html_url,
      gateRecordUrl: gate.comment.html_url,
      proposal,
      decision: { commentId: found.comment.id, url: found.comment.html_url, accepted: found.accepted },
      unlabeled: { login, at: last.created_at! },
    },
  };
}
