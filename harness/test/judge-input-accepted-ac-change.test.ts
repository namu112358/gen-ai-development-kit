// 人が受け入れた AC の変更の提案（決定の記録の acChangeAccepted と、その後のコラボレーターによる agent:plan-review の外し）だけを judge-input の節にする（Issue #869、harness/lib/accepted-ac-change.ts）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { acceptedAcChange, acChangeProposal, type AcceptedAcChange } from '../lib/accepted-ac-change.ts';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import { LABELS } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Plan } from '../lib/plan.ts';
import { renderJudgeInput, type JudgeFacts } from '../lib/session-inputs.ts';
import type { TimelineEvent } from '../lib/state.ts';
import { APP, config, CRITIQUE, HEAD } from './support/gate-fixtures.ts';

const ISSUE = 869;
const URL = `https://github.com/o/r/issues/${ISSUE}#issuecomment-`;
const T = { plan: '2026-10-01T09:50:00Z', stop: '2026-10-01T09:59:00Z', gate: '2026-10-01T10:00:00Z', decision: '2026-10-01T10:05:00Z', unlabel: '2026-10-01T10:10:00Z', relabel: '2026-10-01T10:15:00Z' };
const HEADER = `=== 受け入れた AC の変更 (#${ISSUE})`;
const PROPOSAL_LINE = '- AC2 を「judge が照らす AC に受け入れた変更を含める」に変える';
const REASON_LINE = '受け入れた提案を判定が見ないと、合格の基準がずれるため。';
const ACCEPTED = { choice: '受け入れる', quote: 'AC2 はこの提案どおりに変えてよいです', at: '2026-10-01T19:05:00+09:00' };
const PROCEED = { choice: '進める', quote: 'この計画で進めてください', at: '2026-10-01T19:05:00+09:00' };

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const planOf = (patch: Partial<Plan> = {}): Plan => ({
  version: 1, issue: ISSUE, risk: 'low', needsHuman: true, needsHumanReasons: ['AC の変更の提案'], acChangeProposed: true, openQuestions: [], files: ['harness/lib/a.ts'], critique: CRITIQUE, ...patch,
});
const planBodyOf = (sections: string[]): string => [`# 計画（#${ISSUE}）`, ...sections, '', renderBlock('agent-plan', planOf())].join('\n');
const PLAN_BODY = planBodyOf(['', '## 方針', '方針の本文。', '', '## AC の変更の提案', PROPOSAL_LINE, '', '### 理由', REASON_LINE, '', '## 触るファイル', '- harness/lib/a.ts']);

const comment = (id: number, at: string, body: string, patch: Partial<IssueComment> = {}): IssueComment => ({
  id, body, html_url: `${URL}${id}`, created_at: at, updated_at: at, author_association: 'OWNER', user: { login: 'me', type: 'User' }, ...patch,
});
const label = (event: 'labeled' | 'unlabeled', at: string, login: string): TimelineEvent => ({ event, created_at: at, actor: { login }, label: { name: LABELS.planReview } });

interface Parts {
  /** 計画ゲートが見た計画コメントの本文（記録の planBodySha256 の元） */
  planBody: string;
  /** 今の計画コメントの本文（ゲートの後に編集されたら違う） */
  currentPlanBody?: string;
  gate: Record<string, unknown>;
  /** null なら決定の記録のコメントが無い */
  decision: Record<string, unknown> | null;
  decisionComment: Partial<IssueComment>;
  events: TimelineEvent[];
  labels: string[];
  collaborators: string[];
}

/** 偽の材料（計画コメント・計画ゲートの記録・決定の記録・timeline・ラベル）。既定は受け入れがそろった状態で、一部だけ変えられる */
function build(patch: Partial<Parts> = {}) {
  const p: Parts = {
    planBody: PLAN_BODY, gate: {}, decision: {}, decisionComment: {},
    events: [label('labeled', T.stop, APP), label('unlabeled', T.unlabel, 'alice')], labels: [LABELS.ready], collaborators: ['me', 'alice', APP], ...patch,
  };
  const gate = { version: 1, planCommentId: 80, planBodySha256: sha256(p.planBody), pass: false, reasons: ['AC の変更の提案'], planReviewOrigin: 'planner', plan: planOf(), ...p.gate };
  const comments: IssueComment[] = [
    comment(80, T.plan, p.currentPlanBody ?? p.planBody),
    comment(90, T.gate, `${appMark('plan-gate')}\n計画ゲートで停止しました。\n${renderBlock('agent-app', gate)}`, { author_association: 'NONE', user: { login: APP, type: 'Bot' } }),
  ];
  if (p.decision) {
    const decision = { version: 1, issue: ISSUE, planCommentId: 80, proceed: PROCEED, acChangeAccepted: ACCEPTED, ...p.decision };
    comments.push(comment(95, T.decision, `${CLAUDE_MARK}\n## 決定の記録\n\n${renderBlock('agent-decision', decision)}`, p.decisionComment));
  }
  return { issue: ISSUE, comments, events: p.events, labels: p.labels.map((name) => ({ name })), collaborators: new Set(p.collaborators) };
}

const facts = (input: ReturnType<typeof build>, accepted?: AcceptedAcChange | null): JudgeFacts => ({
  pr: { number: 900, headSha: HEAD, body: `Closes #${ISSUE}` }, prComments: [], checkRuns: [], prState: { state: 'open', draft: true, merged: false },
  issues: [{ number: ISSUE, title: 't', body: '## Acceptance Criteria\n- AC1\n- AC2', comments: input.comments, acceptedAcChange: accepted }],
});

/** judge-input の受け入れた AC の変更の節（見出しから次の === の前まで）。無ければ null */
function section(text: string): string | null {
  const start = text.indexOf(HEADER);
  if (start < 0) return null;
  const end = text.indexOf('\n=== ', start + HEADER.length);
  return text.slice(start, end < 0 ? undefined : end);
}

function assertNotAccepted(name: string, patch: Partial<Parts>): void {
  const input = build(patch);
  const r = acceptedAcChange(config, input);
  assert.equal(r.value, null, name);
  assert.equal(typeof r.reason, 'string', name);
  assert.ok(r.reason!.length > 0, name);
  assert.equal(section(renderJudgeInput(config, facts(input, r.value))), null, name);
}

// (1)
test('受け入れた AC の変更：決定の記録とその後のコラボレーターのラベルの外しがそろうと、judge-input に節が入り、提案の本文・人の言葉・外した人が載る', () => {
  const input = build();
  const r = acceptedAcChange(config, input);
  assert.ok(r.value, String(r.reason));
  assert.equal(r.reason, null);
  assert.equal(r.value.issue, ISSUE);
  assert.equal(r.value.planCommentId, 80);
  assert.equal(r.value.planCommentUrl, `${URL}80`);
  assert.equal(r.value.gateRecordUrl, `${URL}90`);
  assert.deepEqual(r.value.decision, { commentId: 95, url: `${URL}95`, accepted: ACCEPTED });
  assert.deepEqual(r.value.unlabeled, { login: 'alice', at: T.unlabel });

  const text = renderJudgeInput(config, facts(input, r.value));
  const body = section(text);
  assert.ok(body, text);
  assert.ok(text.indexOf(`=== 計画ゲートの記録の計画 (#${ISSUE})`) < text.indexOf(HEADER), '計画ゲートの記録の計画の節の後に入る');
  for (const s of [`${URL}95`, ACCEPTED.quote, ACCEPTED.choice, 'alice', T.unlabel, `${URL}90`, `${URL}80`, PROPOSAL_LINE, REASON_LINE]) assert.ok(body.includes(s), `${s}\n${body}`);
  for (const s of ['方針の本文。', '- harness/lib/a.ts', '```agent-plan']) assert.ok(!body.includes(s), `${s}\n${body}`);
});

test('受け入れた AC の変更：acceptedAcChange が undefined・null なら judge-input に節を書かない', () => {
  const input = build();
  assert.equal(section(renderJudgeInput(config, facts(input))), null);
  assert.equal(section(renderJudgeInput(config, facts(input, null))), null);
});

// (2)
test('受け入れた AC の変更：ラベルの外しだけ（決定の記録なし）では入らない', () => {
  assertNotAccepted('決定の記録なし', { decision: null });
});

// (3)
test('受け入れた AC の変更：決定の記録だけ（agent:plan-review が付いたまま）では入らない', () => {
  assertNotAccepted('付いたまま', { events: [label('labeled', T.stop, APP)], labels: [LABELS.ready, LABELS.planReview] });
});

// (4)
test('受け入れた AC の変更：コラボレーター以外・App が外したなら入らない', () => {
  assertNotAccepted('コラボレーター以外', { events: [label('labeled', T.stop, APP), label('unlabeled', T.unlabel, 'stranger')] });
  assertNotAccepted('App（collaborators に入っていても）', { events: [label('labeled', T.stop, APP), label('unlabeled', T.unlabel, APP)] });
});

// (5)
test('受け入れた AC の変更：外したのが決定の記録より前・同時刻、外した後に付け直したなら入らない', () => {
  const cases: [string, Partial<Parts>][] = [
    ['決定の記録より前', { events: [label('labeled', T.stop, APP), label('unlabeled', T.gate, 'alice')] }],
    ['決定の記録と同時刻', { events: [label('labeled', T.stop, APP), label('unlabeled', T.decision, 'alice')] }],
    ['付け直した（今も付いている）', { events: [label('labeled', T.stop, APP), label('unlabeled', T.unlabel, 'alice'), label('labeled', T.relabel, APP)], labels: [LABELS.ready, LABELS.planReview] }],
    ['付け直した（timeline の labeled が後にある）', { events: [label('labeled', T.stop, APP), label('unlabeled', T.unlabel, 'alice'), label('labeled', T.relabel, 'me')] }],
  ];
  for (const [name, patch] of cases) assertNotAccepted(name, patch);
});

// (6)
test('受け入れた AC の変更：決定の記録・計画ゲートの記録・計画コメントが条件に合わなければ入らない', () => {
  const cases: [string, Partial<Parts>][] = [
    ['決定の記録の planCommentId が違う', { decision: { planCommentId: 81 } }],
    ['決定の記録の issue が違う', { decision: { issue: ISSUE + 1 } }],
    ['決定の記録が編集された（updated_at≠created_at）', { decisionComment: { updated_at: '2026-10-01T10:06:00Z' } }],
    ['決定の記録に acChangeAccepted が無い', { decision: { acChangeAccepted: undefined } }],
    ['決定の記録の書き手がコラボレーターでない', { decisionComment: { author_association: 'NONE', user: { login: 'stranger', type: 'User' } } }],
    ['決定の記録が計画ゲートの記録より前', { decisionComment: { created_at: T.stop, updated_at: T.stop } }],
    ['計画コメントがゲートの後に編集された', { currentPlanBody: `${PLAN_BODY}\n追記` }],
    ['計画ゲートの記録に planBodySha256 が無い', { gate: { planBodySha256: undefined } }],
    ['計画ゲートの記録の計画が acChangeProposed でない', { gate: { plan: planOf({ acChangeProposed: false }) } }],
  ];
  for (const [name, patch] of cases) assertNotAccepted(name, patch);
});

// (7)
test('受け入れた AC の変更：見出し「AC の変更の提案」の節だけが本文になり（agent-plan ブロックは省く）、見出しが無い・節が空なら入らない', () => {
  assert.equal(acChangeProposal(PLAN_BODY)?.includes(PROPOSAL_LINE), true);
  const inner = acChangeProposal(planBodyOf(['## AC の変更の提案', PROPOSAL_LINE, '', renderBlock('agent-plan', planOf()), '', '# 別の大見出し', '外の本文']));
  assert.ok(inner?.includes(PROPOSAL_LINE), String(inner));
  for (const s of ['```agent-plan', '外の本文', '別の大見出し']) assert.ok(!inner!.includes(s), `${s}\n${inner}`);

  const noHeading = planBodyOf(['', '## 方針', PROPOSAL_LINE]);
  const empty = planBodyOf(['', '## AC の変更の提案', '', '## 触るファイル', '- harness/lib/a.ts']);
  for (const [name, body] of [['見出しが無い', noHeading], ['節が空', empty]] as const) {
    assert.equal(acChangeProposal(body), null, name);
    assertNotAccepted(name, { planBody: body });
  }
});
