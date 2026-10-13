// Issue #964：偽の GitHub（コメントの POST を見本に足す acceptComments）の上で、確認事項の書き込みから再開までを1つのテストで通す。
// post-confirm（harness/scripts/agent/commands/confirm.ts）で implement で止めた確認事項を書く → step（collectFleetIssues → decideStep）は wait の human
// → 手元のダッシュボードの一覧（loadAll → buildGraph の todos）に確認事項の行 → その行の材料から作った要求を createConfirmSink に出して 201
// → もう一度 step は再開の implement（inputs の先頭に答えのコメントの URL と人の答え）。
// 文言は固定せず、kind・node・waitingFor・行の id・状態の番号で確かめる。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { LABELS } from '../lib/config.ts';
import { collectFleetIssues, type FleetIssueItem } from '../lib/fleet-reads.ts';
import { GitHub } from '../lib/github.ts';
import { Snapshot } from '../lib/graphql-prefetch.ts';
import type { StoredClaim } from '../lib/queue.ts';
import { decideStep, type StepNodeResult, type StepWaitResult } from '../lib/step.ts';
import type { AgentCommand } from '../scripts/agent/cli.ts';
import { createConfirmSink } from '../scripts/dashboard/confirm.ts';
import { CommentOnlyTransport } from '../scripts/dashboard/decision.ts';
import { DashboardData, ReadOnlyTransport } from '../scripts/dashboard/github.ts';
import { buildGraph } from '../scripts/dashboard/graph.ts';
import { config, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptComments, APP_SLUG, dashboardFake, REPO, type WActor, type World } from './support/dashboard-fixtures.ts';
import { N, NOW, SESSION, confirmValue, stepInput } from './support/step-fixtures.ts';

const APP_ACTOR: WActor = { login: APP_SLUG, bot: true };
const PLAN_ID = 1000;
const GATE_ID = 1001;
const CLAIM_ID = 1002;
const CLAIM_AT = '2026-09-26T09:30:00Z';
/** acceptComments が書き込みごとに返す時刻（確認事項は宣言より後、答えは確認事項より後で、どちらも NOW より前） */
const WRITE_AT = ['2026-09-26T09:45:00Z', '2026-09-26T10:00:00Z'];

/** 計画ゲートを通った Issue N（計画・App の計画ゲートの記録・App の agent:plan-ok・このセッションの implement の宣言）。確認事項はまだ無い */
function flowWorld(): World {
  const claim: StoredClaim = { by: 'manual', at: CLAIM_AT, session: SESSION, stage: 'implement' };
  return {
    issues: [{
      number: N, title: `t${N}`, labels: [LABELS.ready, LABELS.planOk],
      comments: [
        { id: PLAN_ID, created_at: '2026-09-26T01:00:00Z', body: [claudeMark(), '計画です。', '', renderBlock('agent-plan', { version: 1 })].join('\n') },
        {
          id: GATE_ID, created_at: '2026-09-26T01:01:00Z', author: APP_ACTOR, association: 'NONE',
          body: [appMark('plan-gate'), 'App です。', renderBlock('agent-app', { version: 1, planCommentId: PLAN_ID, pass: true, reasons: [], plan: { files: ['harness/lib/step.ts'], critique: { verdict: 'go', rounds: 1 } } })].join('\n'),
        },
        { id: CLAIM_ID, created_at: CLAIM_AT, body: [claudeMark(), '着手しました。', '', renderBlock('agent-claim', claim)].join('\n') },
      ],
      events: [
        { event: 'labeled', label: LABELS.ready, created_at: '2026-09-26T00:00:00Z' },
        { event: 'labeled', label: LABELS.planOk, created_at: '2026-09-26T01:02:00Z', actor: APP_ACTOR },
      ],
    }],
    prs: [],
  };
}

/** post-confirm を run から動かす（confirm-command.test.ts の runPost に倣う）。目印のセッションの ID は AGENT_HARNESS_SESSION で与える */
async function postConfirm(t: TestContext, fake: FakeGitHub, file: string): Promise<string> {
  const mod = await import('../scripts/agent/commands/confirm.ts');
  const cmd = (mod.commands as AgentCommand[]).find((c) => c.name === 'post-confirm');
  assert.ok(cmd, 'post-confirm のコマンドが無い');
  const logs: string[] = [];
  const saved = { session: process.env.AGENT_HARNESS_SESSION, remote: process.env.CLAUDE_CODE_REMOTE_SESSION_ID };
  process.env.AGENT_HARNESS_SESSION = SESSION;
  delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', (code?: number) => {
    throw new Error(`process.exit(${code})`);
  });
  try {
    await cmd.run([String(N), file], { counter: null, gh: () => new GitHub(fake, REPO) });
  } finally {
    t.mock.restoreAll();
    if (saved.session === undefined) delete process.env.AGENT_HARNESS_SESSION;
    else process.env.AGENT_HARNESS_SESSION = saved.session;
    if (saved.remote !== undefined) process.env.CLAUDE_CODE_REMOTE_SESSION_ID = saved.remote;
  }
  const out = logs.at(-1);
  assert.ok(out !== undefined, 'post-confirm の出力が無い');
  return String(JSON.parse(out).posted);
}

async function collectIssue(fake: FakeGitHub) {
  const gh = new GitHub(fake, REPO);
  const item = await gh.get<FleetIssueItem>(`/issues/${N}`);
  const { issues } = await collectFleetIssues(gh, config, [item], new Snapshot());
  assert.equal(issues.length, 1);
  return issues[0]!;
}

test('偽の GitHub の通し：post-confirm で書いた確認事項 → step は wait の human → ダッシュボードの一覧の行 → 答えを投稿して 201 → step は再開の implement', async (t) => {
  const world = flowWorld();
  let writes = 0;
  const fake = acceptComments(dashboardFake(world), world, () => WRITE_AT[writes++]!);

  // (0) post-confirm で、implement で止めた確認事項（resume implement）を書く
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-confirm-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'confirm.md');
  writeFileSync(file, ['確認させてください。', '', renderBlock('agent-confirm', confirmValue({ target: N, stage: 'implement', resume: 'implement' }))].join('\n'));
  const posted = await postConfirm(t, fake, file);
  const confirmComment = world.issues[0]!.comments!.at(-1)!;
  assert.equal(confirmComment.id, CLAIM_ID + 1, '確認事項のコメントが見本に足されていない');

  // (a) 答え待ち
  const waiting = await collectIssue(fake);
  assert.equal(waiting.confirms?.length, 1);
  assert.equal(waiting.confirms![0]!.commentId, confirmComment.id);
  assert.equal(waiting.confirms![0]!.url, posted, 'post-confirm の出した URL が確認事項のコメントの URL');
  const d1 = decideStep(stepInput(waiting));
  assert.equal(d1.result.kind, 'wait', JSON.stringify(d1.result));
  assert.equal((d1.result as StepWaitResult).waitingFor, 'human');

  // (b) 手元のダッシュボードの一覧に確認事項の行
  const data = new DashboardData(new GitHub(new ReadOnlyTransport(fake), REPO), config);
  await data.loadAll();
  const graph = buildGraph(data.issues(), data.prs(), [], { now: NOW, humanClaimStaleHours: 6 });
  const row = graph.todos.find((x) => x.id === `confirm-issue-${N}-${confirmComment.id}`);
  assert.ok(row, `確認事項の行が無い：${graph.todos.map((x) => x.id).join(', ')}`);
  const info = row.confirm;
  assert.ok(info, '行に答える欄の材料（confirm）が無い');

  // (c) 行の材料から作った要求で答える
  const sink = createConfirmSink({ read: new GitHub(fake, REPO), write: new GitHub(new CommentOnlyTransport(fake, REPO), REPO), token: 'f'.repeat(64), now: () => NOW });
  const r = await sink.submit({ target: info.target, confirmCommentId: info.confirmCommentId, answers: info.questions.map((q, i) => ({ to: `question:${i}`, choice: q.choices[0]! })) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(writes, 2, '書き込みは確認事項と答えの2件');

  // (d) 再開
  const answered = await collectIssue(fake);
  const fact = answered.confirms?.[0];
  assert.ok(fact?.answer, '答えとして読めない');
  assert.equal(fact.resumed, false);
  const d2 = decideStep(stepInput(answered));
  assert.equal(d2.result.kind, 'node', JSON.stringify(d2.result));
  const node = d2.result as StepNodeResult;
  assert.equal(node.node, 'implement');
  assert.ok(node.inputs[0]?.includes(fact.answer.url), `inputs の先頭に答えのコメントの URL：${node.inputs.join('\n')}`);
  assert.ok(node.inputs[0]?.includes('はい'), `inputs の先頭に人の答え：${node.inputs.join('\n')}`);
});
