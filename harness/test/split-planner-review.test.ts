/**
 * Planner の申告で付いた agent:plan-review が残る Issue の split の計画を、App が印を外して子 Issue に分けることを確かめる（Issue #659、harness/lib/decision.ts の splitPlannerRelease と harness/gates/on-comment.ts）。
 * AC1：申告の無い split の計画なら、人の答え無しで印を外し、子 Issue を作り、plan-gate に splitReleased を残す。
 * AC2（守り）：委任承認が有効でも、計画自身の files がガードレールに触れる split の計画では印を外さず子 Issue を作らない。
 * 出どころ：批評の関所で止まったら印を残し planReviewOrigin は planner のまま。単体：人が窓の外で付けた印と AC の変更提案では外さない。
 * Issue #779（守り）：子課題の files がガードレール・delegateMergeExclude（と harness.config.json）に触れる split の計画は、委任承認が有効でも印を外さず子 Issue を作らない。
 * 外さない理由（子課題の番号と当たったパターン）はゲートのログに出る。子課題がどれにも触れなければ AC1 のとおり外す。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { splitPlannerRelease } from '../lib/decision.ts';
import type { SplitChild } from '../lib/epic.ts';
import type { Plan } from '../lib/plan.ts';
import type { GateContext } from '../gates/context.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config, CRITIQUE, critiqueClaim, ctxFor, DELEGATE, delegateLabeled, pr, type FakeGitHub } from './support/gate-fixtures.ts';
import { postedBodies, postedRecord } from './support/stack-fixtures.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const P = Date.parse('2026-09-27T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const PLAN_AT = P;
const GATE_AT = P + 20_000;

const base: Plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'], critique: CRITIQUE };
/** 前の計画：Planner の申告で止まった */
const asked: Plan = { ...base, needsHuman: true, needsHumanReasons: ['既定値を決める'], openQuestions: ['shadow から始めるか'] };
const child = (title: string, files: string[]): SplitChild => ({ title, goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files, dependsOn: [] });
/** 申告の無い split の計画 */
const splitPlan: Plan = { ...base, files: [], split: [child('docs: a', ['docs/a/**']), child('docs: b', ['docs/b/**'])] };

const comment = (id: number, body: string, at: number, login: string) => ({
  id, body, html_url: `c${id}`, created_at: iso(at), updated_at: iso(at), author_association: login === APP ? 'NONE' : 'OWNER', user: { login, type: login === APP ? 'Bot' : 'User' },
});
const planBody = (p: Plan) => renderBlock('agent-plan', p);
const stopRecord = (p: Plan) => ({ version: 1, planCommentId: 80, planBodySha256: sha256(planBody(p)), pass: false, reasons: ['Planner が人間の判断が必要と申告しています'], plan: p, planReviewOrigin: 'planner' });
/** 計画コメント（id 80）と、Planner の申告による停止の記録（id 90） */
const stopped = (p: Plan = asked) => [comment(80, planBody(p), PLAN_AT, 'me'), comment(90, `${appMark('plan-gate')}\n記録\n${renderBlock('agent-app', stopRecord(p))}`, GATE_AT, APP)];
const labeled = (at: number) => ({ event: 'labeled', created_at: iso(at), label: { name: 'agent:plan-review' }, actor: { login: 'me' } });
/** post-plan が投稿の直前に付けた印 */
const byPostPlan = [labeled(PLAN_AT - 30_000)];

/** 子 Issue を作れる偽の GitHub（split-guardrail.test.ts の epicFake に events と委任を足したもの） */
function world(opts: { claim?: boolean; delegate?: boolean } = {}): FakeGitHub {
  const comments: unknown[] = [...(opts.claim === false ? [] : [critiqueClaim()]), ...stopped()];
  let next = 100;
  const delegate = opts.delegate ? { dashboardLabels: [DELEGATE.planLabel], dashboardEvents: [delegateLabeled(DELEGATE.planLabel, iso(Date.now() - 600_000))] } : {};
  return acceptanceFake({ pr: pr(), ...delegate })
    .on('GET', /\/issues\/3\/comments/, () => comments)
    .on('POST', /\/issues\/3\/comments$/, (_m, body) => {
      const c = comment(500 + comments.length, body.body, Date.now(), APP);
      comments.push(c);
      return c;
    })
    .on('GET', /\/issues\/3\/(events|timeline)/, () => byPostPlan)
    .on('GET', /\/issues\/3\/sub_issues/, () => [])
    .on('GET', /\/issues\?state=all&creator=/, () => [])
    .on('POST', /\/repos\/o\/r\/issues$/, (_m, body) => ({ id: 9000 + next, number: next++, body: body.body, labels: [], user: { login: APP } }))
    .on('POST', /\/issues\/3\/sub_issues$/, () => ({}))
    .on('GET', /\/issues\/\d+\/dependencies\/blocked_by/, () => [])
    .on('POST', /\/issues\/\d+\/dependencies\/blocked_by$/, () => ({}));
}

/** extra は ctxFor の extra（config の差し替えと log を集める口） */
async function send(fake: FakeGitHub, p: Plan, extra: Partial<GateContext> = {}) {
  const event = { action: 'created', issue: { number: 3, labels: [{ name: 'agent:ready' }, { name: 'agent:plan-review' }], state: 'open' }, comment: comment(200, planBody(p), P + 3_600_000, 'me') };
  await onComment(ctxFor(fake, 'issue_comment', event, extra));
}
const created = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && /\/repos\/o\/r\/issues$/.test(c.path));

test('AC1：Planner の申告だけで止まった Issue に申告の無い split の計画を出すと、人の答え無しで印を外して子 Issue を作る', async () => {
  const fake = world();
  await send(fake, splitPlan);
  assert.ok(fake.writes().includes('label-agent:plan-review'), fake.writes().join(','));
  assert.equal(created(fake).length, splitPlan.split!.length);
  const r = postedRecord(fake, 'plan-gate');
  assert.equal(r.pass, true);
  assert.equal(r.splitReleased, true);
  assert.equal(r.decisionCommentId, undefined, '人の決定の記録は無い');
  assert.match(postedBodies(fake, 'plan-gate').at(-1)!, /Planner の申告で付いた `agent:plan-review` を.*外しました/);
});

test('AC2：委任承認が有効でも、計画自身の files がガードレールに触れる split の計画は印を外さず子 Issue を作らない', async () => {
  const fake = world({ delegate: true });
  await send(fake, { ...splitPlan, files: ['harness/lib/epic.ts'] });
  assert.ok(!fake.writes().includes('label-agent:plan-review'), fake.writes().join(','));
  assert.equal(created(fake).length, 0);
  const r = postedRecord(fake, 'plan-gate');
  assert.equal(r.pass, false);
  // 委任でガードレールの理由は飛んでいる（委任が効いた）うえで、印で止まる
  assert.deepEqual(r.reasons.map((x: string) => /`agent:plan-review` が付いています/.test(x)), [true], r.reasons.join(' / '));
  assert.equal(r.splitReleased, undefined);
});

test('出どころ：split の経路で外せる計画でも、批評の関所で止まれば印を残し planReviewOrigin は planner のまま', async () => {
  const fake = world({ claim: false });
  await send(fake, splitPlan);
  assert.ok(!fake.writes().includes('label-agent:plan-review'));
  assert.equal(created(fake).length, 0);
  const r = postedRecord(fake, 'plan-gate');
  assert.equal(r.pass, false);
  assert.equal(r.planReviewOrigin, 'planner');
  assert.equal(r.splitReleased, undefined);
});

/** 2つ目の子課題だけを差し替えた split の計画（計画自身の files は空） */
const splitWith = (files: string[]): Plan => ({ ...splitPlan, split: [child('docs: a', ['docs/a/**']), child('fix: guarded', files)] });
/** ガードレールには入らず、delegateMergeExclude だけに入るパスを足した設定 */
const secretConfig = { ...config, delegateMergeExclude: [...config.delegateMergeExclude!, 'docs/secret/**'] };

test('#779 AC1（守り）：委任承認が有効でも、子課題の files がガードレールに触れる split の計画は印を外さず子 Issue を作らず、理由をログに出す', async () => {
  const fake = world({ delegate: true });
  const logs: string[] = [];
  await send(fake, splitWith(['harness/lib/**']), { log: (m: string) => logs.push(m) });
  assert.ok(!fake.writes().includes('label-agent:plan-review'), fake.writes().join(','));
  assert.equal(created(fake).length, 0);
  const r = postedRecord(fake, 'plan-gate');
  assert.equal(r.pass, false);
  assert.equal(r.splitReleased, undefined);
  const log = logs.join('\n');
  assert.match(log, /子課題 2/, log);
  assert.ok(log.includes('harness/lib/**'), log);
});

test('#779 AC2（守り）：委任承認が有効でも、子課題の files が delegateMergeExclude だけに触れる split の計画は印を外さず子 Issue を作らない', async () => {
  const fake = world({ delegate: true });
  const logs: string[] = [];
  await send(fake, splitWith(['docs/secret/**']), { config: secretConfig, log: (m: string) => logs.push(m) });
  assert.ok(!fake.writes().includes('label-agent:plan-review'), fake.writes().join(','));
  assert.equal(created(fake).length, 0);
  const r = postedRecord(fake, 'plan-gate');
  assert.equal(r.pass, false);
  assert.equal(r.splitReleased, undefined);
  assert.ok(logs.join('\n').includes('docs/secret/**'), logs.join('\n'));
});

const gateOf = (p: Plan) => [{ planCreatedAt: iso(PLAN_AT), gateCreatedAt: iso(GATE_AT), value: stopRecord(p) as any }];
type UnitCase = {
  name: string;
  prior: Plan;
  events: unknown[];
  release: boolean;
  /** 新しい split の計画（既定は splitPlan） */
  plan?: Plan;
  /** 照合に使う設定（既定はテストの config） */
  cfg?: typeof config;
  /** 外さないとき、理由のどれかに含まれるべき文字列 */
  hits?: string[];
};
const unitCases: UnitCase[] = [
  { name: 'post-plan の窓で付いた Planner の申告の印 → 外す', prior: asked, events: byPostPlan, release: true },
  { name: '窓の外で人が付けた印 → 外さない', prior: asked, events: [labeled(GATE_AT + 86_400_000)], release: false },
  { name: '印を付けた計画に AC の変更提案 → 外さない', prior: { ...asked, acChangeProposed: true }, events: byPostPlan, release: false },
  // #779：子課題の files の照合（守りなので境界も省かない）
  { name: '子課題がガードレール（harness/lib/**）に触れる → 外さない', prior: asked, events: byPostPlan, release: false, plan: splitWith(['harness/lib/**']), hits: ['子課題 2', 'harness/lib/**'] },
  { name: '子課題がガードレールだけ（delegateMergeExclude の外）に触れる → 外さない', prior: asked, events: byPostPlan, release: false, plan: splitWith(['harness/scripts/report.ts']), hits: ['子課題 2', 'harness/scripts/report.ts'] },
  { name: '子課題が delegateMergeExclude だけに触れる → 外さない', prior: asked, events: byPostPlan, release: false, plan: splitWith(['docs/secret/**']), cfg: secretConfig, hits: ['子課題 2', 'docs/secret/**'] },
  { name: '子課題が harness.config.json に触れる → 外さない', prior: asked, events: byPostPlan, release: false, plan: splitWith(['harness.config.json']), hits: ['子課題 2', 'harness.config.json'] },
  { name: '1つ目の子課題が触れる → 外さず理由は子課題 1', prior: asked, events: byPostPlan, release: false, plan: { ...splitPlan, split: [child('fix: lib', ['harness/gates/**']), child('docs: b', ['docs/b/**'])] }, hits: ['子課題 1', 'harness/gates/**'] },
  { name: 'guardrailPaths・delegateMergeExclude の無い設定では子課題がすべて当たる → 外さない', prior: asked, events: byPostPlan, release: false, cfg: { ...config, guardrailPaths: undefined, delegateMergeExclude: undefined } as typeof config, hits: ['子課題 1', 'docs/a/**'] },
  { name: '子課題が guardrailExclude のファイルだけに触れ delegateMergeExclude にも無い → 外す', prior: asked, events: byPostPlan, release: true, plan: splitWith(['harness/lib/usage.ts']) },
  { name: '子課題がどれにも触れない（docs/c/**）→ 外す', prior: asked, events: byPostPlan, release: true, plan: splitWith(['docs/c/**']) },
];
for (const { name, prior, events, release, plan = splitPlan, cfg = config, hits = [] } of unitCases) {
  test(`splitPlannerRelease：${name}`, () => {
    const r = splitPlannerRelease({ plan, gates: gateOf(prior), events: events as any, config: cfg });
    assert.equal(r.release, release, r.reasons.join(' / '));
    assert.equal(r.reasons.length === 0, release);
    if (hits.length > 0) assert.ok(r.reasons.some((x) => hits.every((h) => x.includes(h))), r.reasons.join(' / '));
  });
}
