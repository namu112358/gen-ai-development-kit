// Issue #189：fleet-status の番号なしの対象に、agent:* の無い（コラボレーターが作った）開いた Issue も入れる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appLogin, loadConfig } from '../lib/config.ts';
import { fleetStatus, fleetTargets, selectFleet, type FleetFacts, type FleetIssue, type FleetTargetItem } from '../lib/fleet.ts';
import type { IssueFacts } from '../lib/queue.ts';

const root = join(import.meta.dirname, '..', '..');
const config = loadConfig();
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';

// GitHub の Issue 一覧の1件（fleetTargets に渡す形）
const item = (n: number, labels: string[], patch: Partial<FleetTargetItem> = {}): FleetTargetItem => ({
  number: n, title: `t${n}`, labels: labels.map((name) => ({ name })), user: { login: 'someone' }, author_association: 'OWNER', ...patch,
});
const targets = (items: FleetTargetItem[]) => fleetTargets(items, config).map((i) => i.number);

// 対象にした Issue を fleetStatus・selectFleet に通すための事実
const issueFacts = (n: number, labels: string[], patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels, readyAt: null, claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null, ...patch,
});
const fi = (facts: IssueFacts): FleetIssue => ({ facts, closed: false, planFiles: null, prs: [] });
const facts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });
const select = (f: FleetFacts, currentSession: string | null = null) => selectFleet(config, f, fleetStatus(f), null, currentSession);

// ---- fleetTargets ----

test('fleetTargets：agent:ready・agent:plan-ok・agent:plan-review の Issue は作成者を問わず対象', () => {
  const items = [
    item(1, ['agent:ready'], { author_association: 'CONTRIBUTOR' }),
    item(2, ['agent:ready', 'agent:plan-ok'], { author_association: 'NONE' }),
    item(3, ['agent:plan-review'], { author_association: 'CONTRIBUTOR' }),
    item(4, ['agent:plan-ok'], { author_association: 'OWNER' }),
  ];
  assert.deepEqual(targets(items), [1, 2, 3, 4]);
});

test('fleetTargets：agent:* の無い Issue は、作成者が OWNER・MEMBER・COLLABORATOR のときだけ対象', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.deepEqual(targets([item(1, ['type:feat'], { author_association: a })]), [1], `type:feat だけ・${a}`);
    assert.deepEqual(targets([item(1, [], { author_association: a })]), [1], `ラベル無し・${a}`);
  }
  for (const a of ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR']) {
    assert.deepEqual(targets([item(1, ['type:feat'], { author_association: a })]), [], `type:feat だけ・${a}`);
    assert.deepEqual(targets([item(1, [], { author_association: a })]), [], `ラベル無し・${a}`);
  }
  assert.deepEqual(targets([item(1, [], { author_association: undefined })]), [], '作成者の関係が分からなければ対象にしない');
});

test('fleetTargets：agent:hold・agent:blocked・agent:waiting だけが付いた Issue は対象外', () => {
  for (const l of ['agent:hold', 'agent:blocked', 'agent:waiting']) {
    assert.deepEqual(targets([item(1, [l])]), [], l);
    assert.deepEqual(targets([item(1, [l, 'type:feat'])]), [], `${l}＋type:feat`);
  }
});

test('fleetTargets：止まる印を agent:ready と一緒に付けた Issue は対象になるが、fleetStatus で stopped になり選ばれない', () => {
  for (const l of ['agent:hold', 'agent:blocked', 'agent:waiting']) {
    const labels = ['agent:ready', l];
    assert.deepEqual(targets([item(1, labels)]), [1], l);
    const f = facts([fi(issueFacts(1, labels, { readyAt: '2026-09-26T00:01:00Z' }))]);
    assert.equal(fleetStatus(f)[0]!.stage, 'stopped', l);
    const s = select(f);
    assert.deepEqual(s.selected, [], l);
    assert.ok(s.excluded.has(1), l);
  }
});

test('fleetTargets：PR は対象外', () => {
  assert.deepEqual(targets([item(1, ['agent:ready'], { pull_request: { url: 'x' } })]), []);
  assert.deepEqual(targets([item(2, [], { pull_request: { url: 'x' } })]), []);
  assert.deepEqual(targets([item(3, [], { pull_request: {} })]), []);
});

test('fleetTargets：ダッシュボードの Issue（タイトルが一致し、作成者が App）は対象外。作成者が App でなければ対象', () => {
  const title = config.dashboardIssueTitle;
  assert.deepEqual(targets([item(1, [], { title, user: { login: appLogin(config) }, author_association: 'NONE' })]), []);
  assert.deepEqual(targets([item(2, [], { title, user: { login: appLogin(config) }, author_association: 'OWNER' })]), [], '関係が OWNER でも App のダッシュボードは除く');
  assert.deepEqual(targets([item(3, [], { title, user: { login: 'someone' }, author_association: 'OWNER' })]), [3]);
  assert.deepEqual(targets([item(4, [], { title: 'ほかの題', user: { login: appLogin(config) }, author_association: 'OWNER' })]), [4]);
});

test('fleetTargets：元の順序を保ち、対象外だけを抜く', () => {
  const items = [
    item(5, [], { author_association: 'MEMBER' }),
    item(3, ['agent:hold']),
    item(9, ['agent:ready'], { author_association: 'NONE' }),
    item(1, ['type:feat'], { author_association: 'CONTRIBUTOR' }),
    item(2, [], { pull_request: {} }),
    item(7, ['agent:plan-review']),
  ];
  assert.deepEqual(targets(items), [5, 9, 7]);
  const out = fleetTargets(items, config);
  assert.equal(out[0], items[0], '渡した要素をそのまま返す');
});

// ---- fleetStatus・selectFleet に通したとき ----

test('ラベルの無い Issue は、計画が無ければ no-plan・plan で選ばれ、agent:ready の Issue（readyAt あり）より後に並ぶ', () => {
  const items = [item(1, [], { author_association: 'OWNER' }), item(2, ['agent:ready']), item(3, ['type:feat'], { author_association: 'COLLABORATOR' })];
  assert.deepEqual(targets(items), [1, 2, 3]);
  const f = facts([
    fi(issueFacts(1, [])),
    fi(issueFacts(2, ['agent:ready'], { readyAt: '2026-09-26T00:02:00Z' })),
    fi(issueFacts(3, ['type:feat'])),
  ]);
  const rows = fleetStatus(f);
  for (const n of [1, 3]) {
    const r = rows.find((x) => x.issue === n)!;
    assert.deepEqual([r.stage, r.next], ['no-plan', 'plan'], `#${n}`);
  }
  assert.deepEqual(select(f).selected, [2, 1, 3]);
});

test('ラベルの無い Issue でも、依存・ほかのセッションの着手宣言・epic があれば fleetTargets は通るが選ばれない', () => {
  const items = [item(1, []), item(2, ['type:feat']), item(3, ['epic']), item(4, ['epic', 'type:feat']), item(5, [])];
  assert.deepEqual(targets(items), [1, 2, 3, 4, 5]);
  const f = facts([
    fi(issueFacts(1, [], { openBlockers: [7] })),
    fi(issueFacts(2, ['type:feat'], { claim: { by: 'manual', at: '2026-09-26T00:00:00Z', session: OTHER, stage: 'plan' } })),
    fi(issueFacts(3, ['epic'])),
    fi(issueFacts(4, ['epic', 'type:feat'])),
    fi(issueFacts(5, [])),
  ]);
  const rows = fleetStatus(f);
  assert.equal(rows.find((r) => r.issue === 1)!.stage, 'stopped', '依存');
  assert.equal(rows.find((r) => r.issue === 3)!.stage, 'stopped', 'epic');
  assert.equal(rows.find((r) => r.issue === 4)!.stage, 'stopped', 'epic＋type:feat');
  const s = select(f);
  assert.deepEqual(s.selected, [5]);
  assert.match(s.excluded.get(1)!, /依存/);
  assert.match(s.excluded.get(2)!, /着手宣言/);
  assert.match(s.excluded.get(3)!, /Epic/);
  assert.match(s.excluded.get(4)!, /Epic/);
});

// ---- 手順の文面 ----

const read = (f: string) => readFileSync(join(root, f), 'utf8');
// 「Issue を作ったら同じセッションで plan まで進める」ことを書いた箇条（1行）を探す
const createThenPlan = (text: string) =>
  text.split('\n').find((l) => /^\s*(?:[-*]|\d+\.)\s/.test(l) && l.includes('作') && l.includes('同じセッション') && l.includes('plan'));

test('手順：harness/CLAUDE.harness.md の進め方と ship・fleet の skill に、Issue を作ったら同じセッションで plan まで進めることが書かれている', () => {
  const harness = read('harness/CLAUDE.harness.md');
  const section = harness.slice(harness.indexOf('## 進め方'), harness.indexOf('\n## ', harness.indexOf('## 進め方') + 1));
  assert.ok(createThenPlan(section), 'harness/CLAUDE.harness.md の「進め方」にありません');
  assert.ok(read('CLAUDE.md').includes('@harness/CLAUDE.harness.md') || read('CLAUDE.md').includes('harness/CLAUDE.harness.md') || createThenPlan(read('CLAUDE.md')), 'CLAUDE.md から規則に届きません');
  assert.ok(createThenPlan(read('.claude/skills/ship/SKILL.md')), 'ship の skill にありません');
  assert.ok(createThenPlan(read('.claude/skills/fleet/SKILL.md')), 'fleet の skill にありません');
});

test('手順：fleet の skill の入力の対象の既定と docs/operations.md が、agent:* の無い Issue も含むことを書いている', () => {
  const fleet = read('.claude/skills/fleet/SKILL.md');
  const target = fleet.split('\n').find((l) => l.startsWith('- 対象：')) ?? '';
  assert.match(target, /agent:\*`?\s*の無い/, 'fleet の skill の対象の既定に「agent:* の無い」Issue がありません');
  const ops = read('docs/operations.md').split('\n').filter((l) => l.includes('fleet'));
  assert.ok(ops.some((l) => /agent:\*`?\s*の無い/.test(l)), 'docs/operations.md の fleet の説明に「agent:* の無い」Issue がありません');
});
