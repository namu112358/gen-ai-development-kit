// Issue #157：着手宣言に段階（stage）とセッション（session）を書き、同じセッションの宣言は待たず、段階を表とダッシュボードに出す
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_MARK, claudeMark, claudeMarkSession, extractBlock, renderBlock } from '../lib/blocks.ts';
import { loadConfig } from '../lib/config.ts';
import { claimOf } from '../lib/facts.ts';
import { fleetStatus, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue } from '../lib/fleet.ts';
import type { IssueComment } from '../lib/github.ts';
import { buildQueue, CLAIM_STAGES, describeClaim, isOwnClaim, type Claim, type IssueFacts } from '../lib/queue.ts';

const root = join(import.meta.dirname, '..', '..');
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';
const ROUTINE_URL = 'https://claude.ai/code/session_01ABCDEFGHxyz';

const now = new Date('2026-09-26T12:00:00Z');
const opts = (currentSession: string | null) => ({ currentSession, now, routineClaimTakeoverMinutes: 90, humanClaimStaleHours: 6 });

const manual = (patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', ...patch });
const routine = (session: string, at: string): Claim => ({ by: 'routine', session, at });

// ---- 宣言の書式（新旧）----

let nextId = 1;
function comment(body: string): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `u${id}`, created_at: `2026-09-26T00:00:${String(id).padStart(2, '0')}Z`, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } };
}

test('CLAIM_STAGES：計画から sync までの段階', () => {
  assert.deepEqual([...CLAIM_STAGES], ['plan', 'plan-critique', 'plan-gate', 'implement', 'judge', 'fix', 'sync']);
});

test('claimOf：stage・session 付きの宣言（ID 付きの印）と、古い書式の宣言（ID なしの印）の両方が読める', () => {
  const fresh = { by: 'manual', at: '2026-09-26T11:00:00Z', session: SESSION, stage: 'plan-critique' };
  assert.deepEqual(claimOf([comment(`${claudeMark(SESSION)}\n着手しました。\n\n${renderBlock('agent-claim', fresh)}`)]), fresh);
  const escaped = `&lt;!-- agent-harness:claude session=${SESSION} --&gt;\n着手しました。\n\n${renderBlock('agent-claim', fresh)}`;
  assert.deepEqual(claimOf([comment(escaped)]), fresh, 'エンティティの形の ID 付きの印も読める');
  const old = { by: 'manual', at: '2026-09-26T11:00:00Z' };
  assert.deepEqual(claimOf([comment(`${CLAUDE_MARK}\n着手しました。\n\n${renderBlock('agent-claim', old)}`)]), old);
  const oldRoutine = { by: 'routine', session: ROUTINE_URL, at: '2026-09-26T11:00:00Z' };
  assert.deepEqual(claimOf([comment(`${CLAUDE_MARK}\n着手しました。\n\n${renderBlock('agent-claim', oldRoutine)}`)]), oldRoutine);
});

// ---- render-claim --stage ----

function agentEnv(session: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (session !== null) env.AGENT_HARNESS_SESSION = session;
  return env;
}
const renderClaim = (args: string[], session: string | null) =>
  spawnSync(process.execPath, ['harness/scripts/agent.ts', 'render-claim', ...args], { cwd: root, encoding: 'utf8', env: agentEnv(session) });

const claimBlock = (body: string): Record<string, unknown> => {
  const b = extractBlock(body, 'agent-claim');
  assert.ok(b.found && b.ok, body);
  return b.value as Record<string, unknown>;
};
const withoutBlock = (body: string): string => body.replace(/```agent-claim[\s\S]*?```/, '');

test('render-claim --manual --stage plan-critique：本文と agent-claim ブロックに段階、印とブロックにセッション ID', () => {
  const r = renderClaim(['--manual', '--stage', 'plan-critique'], SESSION);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`${claudeMark(SESSION)}\n`), r.stdout);
  assert.equal(claudeMarkSession(r.stdout), SESSION);
  const v = claimBlock(r.stdout);
  assert.equal(v.by, 'manual');
  assert.equal(v.stage, 'plan-critique');
  assert.equal(v.session, SESSION);
  assert.ok(withoutBlock(r.stdout).includes('plan-critique'), '本文（ブロックの外）にも段階が入る');
});

test('render-claim：AGENT_HARNESS_SESSION が無ければ session も印の ID も無い（今の形）', () => {
  const r = renderClaim(['--manual', '--stage', 'plan'], null);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`${CLAUDE_MARK}\n`), r.stdout);
  assert.equal(claudeMarkSession(r.stdout), null);
  const v = claimBlock(r.stdout);
  assert.equal(v.stage, 'plan');
  assert.ok(!('session' in v), 'session のキーを入れない');
});

test('render-claim：--stage なしは今までどおり（段階を入れない）', () => {
  const r = renderClaim(['--manual'], null);
  assert.equal(r.status, 0, r.stderr);
  const v = claimBlock(r.stdout);
  assert.equal(v.by, 'manual');
  assert.ok(!('stage' in v));
});

test('render-claim：CLAIM_STAGES のどれでも通り、不正な --stage は終了コード非0', () => {
  for (const stage of CLAIM_STAGES) {
    const r = renderClaim(['--manual', '--stage', stage], SESSION);
    assert.equal(r.status, 0, `${stage}: ${r.stderr}`);
    assert.equal(claimBlock(r.stdout).stage, stage);
  }
  for (const bad of [['--stage', 'deploy'], ['--stage']]) {
    const r = renderClaim(['--manual', ...bad], SESSION);
    assert.notEqual(r.status, 0, `止めるべき: ${bad.join(' ')}`);
  }
});

// ---- isOwnClaim / describeClaim ----

test('isOwnClaim：手動の宣言で session と current が空でない同じ文字列のときだけ true', () => {
  assert.equal(isOwnClaim(manual({ session: SESSION }), SESSION), true);
  assert.equal(isOwnClaim(manual({ session: SESSION, stage: 'plan-gate' }), SESSION), true);
  assert.equal(isOwnClaim(manual({ session: OTHER }), SESSION), false, '別のセッション');
  assert.equal(isOwnClaim(manual(), SESSION), false, 'session の無い古い宣言');
  assert.equal(isOwnClaim(manual({ session: SESSION }), null), false, '今のセッションが分からない');
  assert.equal(isOwnClaim(manual({ session: '' }), ''), false, '空文字は一致とみなさない');
  assert.equal(isOwnClaim(routine(SESSION, '2026-09-26T11:00:00Z'), SESSION), false, 'Routine の宣言');
  assert.equal(isOwnClaim(null, SESSION), false);
});

test('describeClaim：段階とセッションの短い形を含み、無いものは省く', () => {
  const full = describeClaim(manual({ session: SESSION, stage: 'plan-critique' }));
  assert.ok(full.includes('plan-critique'), full);
  assert.ok(full.includes('3f2a9c1e'), full);
  assert.ok(!full.includes(SESSION), `セッションは短い形: ${full}`);
  const stageOnly = describeClaim(manual({ stage: 'implement' }));
  assert.ok(stageOnly.includes('implement') && !stageOnly.includes('session'), stageOnly);
  const bare = describeClaim(manual());
  assert.ok(!bare.includes('段階') && !bare.includes('session'), bare);
});

// ---- buildQueue（ダッシュボードのキューに出る理由）----

const issue = (n: number, claim: Claim | null): IssueFacts => ({
  number: n, title: 't', labels: ['agent:ready'], readyAt: '2026-09-26T00:00:00Z', claim, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null,
});
const skipReason = (claim: Claim, current: string | null): string | null => {
  const q = buildQueue([issue(1, claim)], [], opts(current), 10);
  const s = q.skipped.find((a) => a.kind === 'skip');
  return s && s.kind === 'skip' ? s.reason : null;
};

test('buildQueue：同じセッションの宣言は着手中にせず、ほかのセッションの宣言は段階つきで飛ばす', () => {
  const own = buildQueue([issue(1, manual({ session: SESSION, stage: 'plan-critique' }))], [], opts(SESSION), 10);
  assert.deepEqual(own.actions, [{ kind: 'plan', issue: 1 }]);
  assert.equal(own.skipped.length, 0);

  const other = skipReason(manual({ session: OTHER, stage: 'plan-critique' }), SESSION);
  assert.ok(other !== null && other.includes('plan-critique'), `理由に段階が入る: ${other}`);
  assert.ok(other.includes('人のセッションが着手中'), other);

  assert.ok(skipReason(manual(), SESSION)?.includes('人のセッションが着手中'), '古い書式の宣言は今までどおり飛ばす');
  assert.ok(skipReason(manual({ session: SESSION }), null) !== null, '今のセッションが分からなければ飛ばす');
});

test('buildQueue：手動の宣言の停滞の表示は変わらない', () => {
  const stale = skipReason(manual({ at: '2026-09-26T01:00:00Z', session: OTHER, stage: 'implement' }), SESSION);
  assert.ok(stale !== null && stale.includes('停滞') && stale.includes('implement'), `${stale}`);
});

test('buildQueue：Routine の宣言の判定は変わらない（URL が同じなら奪える、90分以内の別の Routine は飛ばす、手元の UUID とは一致しない）', () => {
  const kinds = (claim: Claim, current: string | null) => buildQueue([issue(1, claim)], [], opts(current), 10).actions.map((a) => a.kind);
  assert.deepEqual(kinds(routine(ROUTINE_URL, '2026-09-26T11:59:00Z'), ROUTINE_URL), ['plan'], '自分の Routine の宣言');
  assert.deepEqual(kinds(routine('https://claude.ai/code/session_other', '2026-09-26T11:30:00Z'), ROUTINE_URL), [], '別の Routine が着手中');
  assert.deepEqual(kinds(routine('https://claude.ai/code/session_other', '2026-09-26T10:00:00Z'), ROUTINE_URL), ['plan'], '終わった Routine は引き継ぐ');
  assert.deepEqual(kinds(routine(ROUTINE_URL, '2026-09-26T11:30:00Z'), SESSION), [], 'Routine の宣言（URL）と手元の UUID は一致しない');
});

// ---- selectFleet / renderFleetStatus ----

const config = { ...loadConfig(), areaConcurrency: { harness: 2 } };
const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const planOk = (n: number, claim: Claim | null): IssueFacts => ({
  ...issue(n, claim), title: `t${n}`, readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`,
  labels: ['agent:ready', 'agent:plan-ok'], gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true,
});
const fi = (facts: IssueFacts, planFiles: string[] | null = null): FleetIssue => ({ facts, closed: false, planFiles, prs: [] });
const fleetFacts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });

/** 表の Issue の行のセル（先頭・末尾の空を除く） */
function rowCells(table: string, n: number): string[] {
  const line = table.split('\n').find((l) => l.startsWith(`| #${n} `));
  assert.ok(line, `#${n} の行がありません\n${table}`);
  return line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
}

test('selectFleet：同じセッションの宣言は「待つ」にせず、ほかのセッションの宣言は段階つきで「待つ」', () => {
  const f = fleetFacts([
    fi(planOk(1, manual({ session: SESSION, stage: 'implement' }))),
    fi(planOk(2, manual({ session: OTHER, stage: 'plan-critique' }))),
    fi(planOk(3, manual())),
  ]);
  const sel = selectFleet(config, f, fleetStatus(f), null, SESSION);
  assert.ok(sel.selected.includes(1), '自分の宣言の Issue は選ぶ');
  assert.ok(!sel.selected.includes(2) && !sel.selected.includes(3));
  const r2 = sel.excluded.get(2)!;
  assert.match(r2, /着手宣言あり/);
  assert.ok(r2.includes('plan-critique'), r2);
  assert.match(sel.excluded.get(3)!, /着手宣言あり/, '古い書式の宣言は今までどおり待つ');
});

test('selectFleet：currentSession を渡さなければ今までどおり宣言のある Issue は待つ', () => {
  const f = fleetFacts([fi(planOk(1, manual({ session: SESSION, stage: 'implement' })))]);
  const sel = selectFleet(config, f, fleetStatus(f), null);
  assert.deepEqual(sel.selected, []);
  assert.match(sel.excluded.get(1)!, /着手宣言あり/);
});

test('renderFleetStatus：着手宣言がある行のメモ列に段階が出る', () => {
  const f = fleetFacts([
    fi(planOk(1, manual({ session: SESSION, stage: 'implement' }))),
    fi(planOk(2, manual({ session: OTHER, stage: 'plan-critique' }))),
    fi(planOk(4, null)),
  ]);
  const rows = fleetStatus(f);
  const table = renderFleetStatus(rows, selectFleet(config, f, rows, null, SESSION), null);
  const own = rowCells(table, 1);
  assert.equal(own[4], '選ぶ');
  assert.ok(own[6]!.includes('implement'), `メモ: ${own[6]}`);
  const other = rowCells(table, 2);
  assert.ok(other[4]!.startsWith('待つ'));
  assert.ok(other[6]!.includes('plan-critique'), `メモ: ${other[6]}`);
  const none = rowCells(table, 4);
  assert.ok(!CLAIM_STAGES.some((s) => none[6]!.includes(s)), `宣言の無い行に段階を出さない: ${none[6]}`);
});

// ---- skill の文 ----

const skill = (name: string): string => readFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
const claimWithStage = (stage: string): RegExp => new RegExp(`agent\\.ts claim [^\\n]*--stage ${stage}(?![-\\w])`);

test('各 skill に段階ごとに宣言を更新する手順（claim --stage <段階>）がある', () => {
  const expected: Record<string, string[]> = {
    plan: ['plan', 'plan-critique'],
    implement: ['implement'],
    judge: ['judge'],
    fix: ['fix'],
    sync: ['sync'],
  };
  for (const [name, stages] of Object.entries(expected)) {
    const text = skill(name);
    for (const stage of stages) assert.match(text, claimWithStage(stage), `${name}/SKILL.md に claim --stage ${stage} がありません`);
  }
});

test('ship・fleet の skill に、宣言の時点（claim）・--takeover・release による解除がある', () => {
  for (const name of ['ship', 'fleet']) {
    const text = skill(name);
    assert.match(text, /claim [^\n]*--stage/, `${name}: claim --stage の手順がありません`);
    assert.ok(text.includes('--takeover'), `${name}: --takeover の説明がありません`);
    assert.match(text, /release <[^>]+>/, `${name}: release で解除する手順がありません`);
  }
});
