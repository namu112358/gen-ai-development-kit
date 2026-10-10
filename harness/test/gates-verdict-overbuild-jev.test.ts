// 判定の受け付け（onComment → onVerdict）が⑨のブロッキング指摘を Jev に問い、acceptance.overbuildJev に残し、enforce では下限未満の⑨を外して reviewPass・修正の依頼を決める組み込みを、偽の GitHub と偽の Jev で確かめる（Issue #584）。純粋関数の細部は review-panel-overbuild-jev.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { BlockingFinding, Verdict } from '../lib/verdict.ts';
import { onComment } from '../gates/on-comment.ts';
import { acceptanceFake, config as base, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, postedBodies, postedRecord } from './support/stack-fixtures.ts';

/** Risk の Jev（callJev）が本物の API を呼ばないよう jev.mode は off。⑨の問いは jev.overbuild で決まる */
const configWith = (overbuild: 'shadow' | 'enforce', threshold?: number): HarnessConfig => ({
  ...base,
  jev: { ...base.jev, mode: 'off', overbuild, thresholds: { ...base.jev.thresholds, ...(threshold === undefined ? {} : { overbuildBlockProbability: threshold }) } },
});

const OVER_1: BlockingFinding = { kind: 'over-implementation', file: 'docs/a.md', detail: 'OVER-1 使われない分岐' };
const OVER_2: BlockingFinding = { kind: 'over-testing', file: 'docs/a.md', detail: 'OVER-2 重なるテスト' };
const BUG: BlockingFinding = { kind: 'bug', file: 'docs/a.md', detail: 'BUG-1 境界の誤り' };
/** Jev に渡ってはいけない、セッションの言い分の目印 */
const SECRET = 'SESSION-SIDE-MARKER';
const RECENT = 'diff --git a/docs/a.md b/docs/a.md\n+RECENT-CHANGE\n';

const blockingVerdict = (blocking: BlockingFinding[]): Verdict =>
  verdict({
    review: { pass: false, blocking, nonBlocking: [], humanNotes: { concerns: [SECRET], checkPoints: [SECRET] } },
    risk: { ...verdict().risk, rationale: SECRET },
    authorView: SECRET,
  });

/** 偽の Jev。⑨の問い（block_*）があるときだけ block_<i>・recent_<i> に答え、ほかの問い（auto mode の danger など）には error を返す */
function fakeJev(block: number[], recent: number[] = []) {
  const asked: { state: any; questions: Record<string, unknown> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    const r = request as { state: any; questions: Record<string, unknown> };
    asked.push(r);
    if (!Object.keys(r.questions).some((q) => q.startsWith('block_'))) return { status: 'error', detail: '⑨の問いではない' };
    const answers: Record<string, unknown> = {};
    block.forEach((p, i) => (answers[`block_${i}`] = { type: 'noul', noul: p }));
    recent.forEach((p, i) => (answers[`recent_${i}`] = { type: 'noul', noul: p }));
    return { status: 'ok', model: 'jev-test', answers: answers as any };
  };
  /** ⑨の問いの要求だけ */
  const overbuild = () => asked.filter((r) => Object.keys(r.questions).some((q) => q.startsWith('block_')));
  return { asked, overbuild, fn };
}

function fakeGh(prComments: unknown[] = []): FakeGitHub {
  return acceptanceFake({ pr: pr(), dashboardLabels: [], prComments })
    .on('GET', /\/issues\/5\/events/, () => [])
    .on('GET', new RegExp(`/compare/${'b'.repeat(40)}\\.\\.\\.`), (_m, _b, o) => (o.raw ? RECENT : { behind_by: 0 }));
}

async function accept(fake: FakeGitHub, v: Verdict, jev: ReturnType<typeof fakeJev>, config: HarnessConfig): Promise<Record<string, any>> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), { config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  return postedRecord(fake, 'acceptance');
}

/** 修正の依頼（REQUEST_CHANGES のレビュー本文）。出していなければ undefined */
const fixRequest = (fake: FakeGitHub): string | undefined =>
  fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls/5/reviews') && c.body?.event === 'REQUEST_CHANGES')?.body.body;

test('AC1：⑨のブロッキング指摘ごとの Jev の答えが acceptance.overbuildJev に残り、⑨以外は問わず、セッションの言い分は渡さない', async () => {
  const fake = fakeGh();
  const jev = fakeJev([0.3, 0.8]);
  const a = await accept(fake, blockingVerdict([OVER_1, BUG, OVER_2]), jev, configWith('shadow', 0.5));

  assert.equal(jev.overbuild().length, 1, '⑨の問いは1回だけ');
  const req = jev.overbuild()[0]!;
  assert.deepEqual(Object.keys(req.state).sort(), ['diff', 'findings'], '前回の受け付けが無いので recent_diff は無い');
  assert.deepEqual(req.state.findings, [OVER_1, OVER_2].map((f) => ({ kind: f.kind, file: f.file, detail: f.detail })), 'bug は問わない');
  assert.deepEqual(Object.keys(req.questions).sort(), ['block_0', 'block_1']);
  assert.ok(!JSON.stringify(req.state).includes(SECRET), 'facts・rationale・authorView・humanNotes が state に入っている');

  const rec = a.overbuildJev;
  assert.ok(rec, '受け付けの記録に overbuildJev が無い');
  assert.equal(rec.status, 'ok');
  assert.deepEqual(rec.findings.map((f: any) => [f.kind, f.block, f.recent]), [['over-implementation', 0.3, null], ['over-testing', 0.8, null]]);
  assert.ok(postedBodies(fake, 'acceptance').at(-1)!.split('\n').some((l) => l.startsWith('| ⑨の Jev |')), '受け付けの表に「⑨の Jev」の行が無い');
});

test('AC2：enforce では下限未満の⑨がブロッキングから外れて reviewPass と修正の依頼が変わり、shadow では変わらない', async () => {
  const cases: [string, HarnessConfig, BlockingFinding[], number[], boolean, string[], string[]][] = [
    // 名前, 設定, ブロッキング, block の答え, reviewPass, 修正の依頼にあるもの, 無いもの
    ['enforce・⑨1件を外す', configWith('enforce', 0.5), [OVER_1, OVER_2, BUG], [0.2, 0.9], false, ['OVER-2', 'BUG-1'], ['OVER-1']],
    ['enforce・⑨だけで全部外す', configWith('enforce', 0.5), [OVER_1, OVER_2], [0.2, 0.2], true, [], []],
    ['shadow は変えない', configWith('shadow', 0.5), [OVER_1, OVER_2, BUG], [0.2, 0.9], false, ['OVER-1', 'OVER-2', 'BUG-1'], []],
  ];
  for (const [name, config, blocking, answers, pass, present, absent] of cases) {
    const fake = fakeGh();
    const a = await accept(fake, blockingVerdict(blocking), fakeJev(answers), config);
    assert.equal(a.reviewPass, pass, `${name}: reviewPass`);
    const body = fixRequest(fake);
    if (pass) {
      assert.equal(body, undefined, `${name}: 修正の依頼を出した`);
      continue;
    }
    assert.ok(body, `${name}: 修正の依頼が無い`);
    for (const s of present) assert.ok(body.includes(s), `${name}: 修正の依頼に ${s} が無い`);
    for (const s of absent) assert.ok(!body.includes(s), `${name}: 修正の依頼に ${s} が残っている`);
  }
});

test('recent：前回の受け付けの head が違えば、その head から今の head への差分を recent_diff に渡して recent_* を問い、記録の recent に残す', async () => {
  const fake = fakeGh([acceptanceComment(91, { verdictHeadSha: 'b'.repeat(40) })]);
  const jev = fakeJev([0.6, 0.7], [0.1, 0.9]);
  const a = await accept(fake, blockingVerdict([OVER_1, OVER_2]), jev, configWith('shadow', 0.5));

  assert.equal(jev.overbuild().length, 1);
  const req = jev.overbuild()[0]!;
  assert.equal(req.state.recent_diff, RECENT, '前回の head から今の head への compare を渡していない');
  assert.deepEqual(Object.keys(req.questions).sort(), ['block_0', 'block_1', 'recent_0', 'recent_1']);
  assert.deepEqual(a.overbuildJev?.findings.map((f: any) => f.recent), [0.1, 0.9]);
});
