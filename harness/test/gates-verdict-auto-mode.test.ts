// 判定コメントの受け付け（onComment → buildAcceptance）が、auto mode なら自動経路に乗せてよいか（受け付けの記録の autoMode）を Jev の危険の判定で決める動作を、偽の GitHub と偽の Jev で確かめる（Issue #345）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET } from '../lib/auto-mode.ts';
import { appMark, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Verdict } from '../lib/verdict.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, DIFF, acceptanceFake, config as base, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, postedBodies, postedRecord, stackedPr } from './support/stack-fixtures.ts';

/** 判定の受け付けで Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の危険の問いは jev.mode と独立） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };

/** ガードレールにも delegateMergeExclude にも当たる */
const CONFIG_FILE = 'harness.config.json';
/** ガードレールに当たり delegateMergeExclude には当たらない */
const GUARDED = 'harness/lib/epic.ts';

const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

/** 計画ゲートを通った記録（files 指定） */
const planGate = (files: string[]) => ({
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } })}`,
});

/** 偽の Jev。危険の問い（danger）にだけ答え、呼ばれた要求を残す */
function fakeJev(answer: number | 'error') {
  const asked: { state: any; questions: Record<string, unknown> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request as { state: any; questions: Record<string, unknown> });
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    if (answer === 'error') return { status: 'error', detail: 'HTTP 500' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
  };
  return { asked, fn };
}

/** 判定の受け付け用の偽の GitHub。既定は、変更ファイルと計画の files がどちらも harness.config.json */
function verdictFake(o: { files?: string[]; planFiles?: string[]; pr?: ReturnType<typeof pr>; prComments?: unknown[] } = {}): FakeGitHub {
  const files = o.files ?? [CONFIG_FILE];
  return acceptanceFake({ pr: o.pr ?? pr(), dashboardLabels: [], prComments: o.prComments ?? [] })
    .on('GET', /\/issues\/3\/comments/, () => [planGate(o.planFiles ?? files)])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/5\/events/, () => []);
}

async function accept(fake: FakeGitHub, v: Verdict, o: { jev?: ReturnType<typeof fakeJev>; key?: boolean; config?: HarnessConfig } = {}): Promise<Record<string, any>> {
  const extra = { config: o.config ?? config, secrets: o.key === false ? {} : { jevApiKey: 'jev-key' }, ...(o.jev ? { askJev: o.jev.fn } : {}) };
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), extra));
  return postedRecord(fake, 'acceptance');
}

/** 受け付けのコメントの表の「auto mode」の行 */
const autoModeRow = (fake: FakeGitHub): string | undefined => postedBodies(fake, 'acceptance').at(-1)?.split('\n').find((l) => l.startsWith('| auto mode |'));

// ---- AC5：必須の条件を満たし Jev が安全なら eligible ----

test('AC5：委任しないパス・ガードレールに触れる critical の PR で、必須の条件を満たし Jev が安全なら autoMode.eligible が真で、飛ばす理由が skipped に残る', async () => {
  const fake = verdictFake();
  const jev = fakeJev(0.01);
  const a = await accept(fake, critical(), { jev });
  assert.equal(a.autoEligible, false, '自動 Merge の対象ではない');
  assert.ok(a.autoMode, '受け付けの記録に autoMode が無い');
  assert.equal(a.autoMode.eligible, true, a.autoMode.reasons.join(' / '));
  assert.deepEqual(a.autoMode.reasons, []);
  const skipped = a.autoMode.skipped as string[];
  assert.ok(skipped.some((s) => s.includes('critical')), `Risk の理由が無い: ${skipped.join(' / ')}`);
  assert.ok(skipped.some((s) => s.includes('ガードレール') && s.includes(CONFIG_FILE)), `ガードレールの理由が無い: ${skipped.join(' / ')}`);
  assert.ok(skipped.some((s) => s.includes('delegateMergeExclude') && s.includes(CONFIG_FILE)), `delegateMergeExclude の理由が無い: ${skipped.join(' / ')}`);
  assert.equal(a.autoMode.jev?.status, 'ok');
  assert.equal(a.autoMode.jev?.yes, 0.01);
  assert.equal(jev.asked.length, 1, 'Jev に1回だけ問う');
  assert.equal(jev.asked[0]!.state.diff, DIFF, 'Jev には App が集めた diff を渡す');
  assert.deepEqual(jev.asked[0]!.state.changed_files, [CONFIG_FILE]);
  assert.match(autoModeRow(fake) ?? '', /^\| auto mode \| 可/, '表に auto mode の可の行が無い');
});

test('AC5：ガードレールだけ・critical だけの PR も、Jev が安全なら eligible', async () => {
  const cases: [string, string[], Verdict][] = [
    ['ガードレールだけ', [GUARDED], verdict()],
    ['critical だけ', ['docs/a.md'], critical()],
  ];
  for (const [name, files, v] of cases) {
    const fake = verdictFake({ files });
    const jev = fakeJev(0.02);
    const a = await accept(fake, v, { jev });
    assert.equal(a.autoEligible, false, name);
    assert.equal(a.autoMode?.eligible, true, `${name}: ${a.autoMode?.reasons.join(' / ')}`);
    assert.equal(jev.asked.length, 1, name);
  }
});

// ---- AC5：Jev が危険・記録が無いなら偽で理由が残る ----

test('AC5：Jev が危険と答えた・鍵なし・diff が大きすぎる・error なら autoMode.eligible が偽で、reasons に理由が残る', async () => {
  const small: HarnessConfig = { ...config, jev: { ...config.jev, maxDiffChars: 10 } };
  const cases: [string, { jev: ReturnType<typeof fakeJev>; key?: boolean; config?: HarnessConfig }, string, RegExp, number][] = [
    ['危険', { jev: fakeJev(0.5) }, 'ok', /Jev：危険の確率/, 1],
    ['鍵なし', { jev: fakeJev(0.01), key: false }, 'skipped', /JEV_API_KEY/, 0],
    ['diff が大きすぎる', { jev: fakeJev(0.01), config: small }, 'skipped', /diff が大きすぎます/, 0],
    ['error', { jev: fakeJev('error') }, 'error', /HTTP 500/, 1],
  ];
  for (const [name, o, status, reason, asked] of cases) {
    const fake = verdictFake();
    const a = await accept(fake, critical(), o);
    assert.equal(a.autoMode?.eligible, false, name);
    assert.equal(a.autoMode?.jev?.status, status, name);
    const reasons = a.autoMode?.reasons as string[];
    assert.ok(reasons.some((r) => r.includes('auto mode の危険の判定で保留') && reason.test(r)), `${name}: reasons に理由が無い: ${reasons.join(' / ')}`);
    assert.equal(o.jev.asked.length, asked, `${name}: Jev に問った回数`);
    assert.match(autoModeRow(fake) ?? '', /^\| auto mode \| 不可: /, `${name}: 表に auto mode の不可の行が無い`);
  }
});

// ---- 必須の条件を満たさなければ Jev に問わない ----

test('AC5：範囲外・ブロッキング指摘・Stacked PR・人の PR では Jev に問わず、autoMode.eligible は偽で理由が残る', async () => {
  const blocking = verdict({ risk: critical().risk, review: { pass: false, blocking: [{ kind: 'ac-unmet', detail: 'AC 2' }], nonBlocking: [] } });
  const human = pr({ head: { ref: 'feature/x', sha: 'a'.repeat(40), repo: { full_name: 'o/r' } }, user: { login: 'me' } });
  const cases: [string, FakeGitHub, Verdict, RegExp][] = [
    ['範囲外', verdictFake({ files: [CONFIG_FILE, 'docs/x.md'], planFiles: [CONFIG_FILE] }), critical(), /計画の範囲外/],
    ['ブロッキング指摘', verdictFake(), blocking, /ブロッキング/],
    ['Stacked PR', verdictFake({ pr: stackedPr() }), critical(), /base が既定ブランチではない/],
    ['人の PR', verdictFake({ pr: human }), critical(), /Agent の PR ではない/],
  ];
  for (const [name, fake, v, reason] of cases) {
    const jev = fakeJev(0.01);
    const a = await accept(fake, v, { jev });
    assert.equal(a.autoMode?.eligible, false, name);
    assert.ok((a.autoMode?.reasons as string[]).some((r) => reason.test(r)), `${name}: reasons に理由が無い: ${a.autoMode?.reasons.join(' / ')}`);
    assert.equal(a.autoMode?.jev, undefined, `${name}: 問わないのに jev の記録がある`);
    assert.equal(jev.asked.length, 0, `${name}: Jev に問った`);
  }
});

test('自動 Merge の対象（low・docs）の PR は Jev に問わず、表の auto mode の行は「不要」', async () => {
  const fake = verdictFake({ files: ['docs/a.md'] });
  const jev = fakeJev(0.01);
  const a = await accept(fake, verdict(), { jev });
  assert.equal(a.autoEligible, true);
  assert.equal(a.autoMode?.eligible, false);
  assert.equal(jev.asked.length, 0);
  assert.match(autoModeRow(fake) ?? '', /不要/);
});

// ---- 同じ patch-id の記録の使い回し ----

const jevRecord = (status: 'ok' | 'error', yes?: number) => ({ status, detail: status === 'ok' ? 'jev-prev' : 'HTTP 502', ...(yes === undefined ? {} : { yes }), questionSet: AUTO_MODE_JEV_QUESTION_SET });

test('同じ patch-id の2回目の受け付けでは、前の受け付けの記録の autoMode.jev（ok）を使い回して問い直さない', async () => {
  for (const yes of [0.01, 0.5]) {
    const previous = acceptanceComment(91, { autoMode: { eligible: yes < 0.1, reasons: [], skipped: [], jev: jevRecord('ok', yes) } });
    const fake = verdictFake({ prComments: [previous] });
    const jev = fakeJev(yes < 0.1 ? 0.9 : 0.01);
    const a = await accept(fake, critical(), { jev });
    assert.equal(jev.asked.length, 0, `${yes}: 問い直した`);
    assert.deepEqual(a.autoMode?.jev, jevRecord('ok', yes), `${yes}: 前の記録を使い回していない`);
    assert.equal(a.autoMode?.eligible, yes < 0.1, `${yes}`);
  }
});

test('前の受け付けの autoMode.jev が error・別の patch-id なら使い回さずに問う', async () => {
  const cases: [string, unknown][] = [
    ['error', acceptanceComment(91, { autoMode: { eligible: false, reasons: [], skipped: [], jev: jevRecord('error') } })],
    ['別の patch-id', acceptanceComment(91, { patchId: 'other', autoMode: { eligible: true, reasons: [], skipped: [], jev: jevRecord('ok', 0.01) } })],
  ];
  for (const [name, previous] of cases) {
    const fake = verdictFake({ prComments: [previous] });
    const jev = fakeJev(0.02);
    const a = await accept(fake, critical(), { jev });
    assert.equal(jev.asked.length, 1, `${name}: 問っていない`);
    assert.equal(a.autoMode?.jev?.yes, 0.02, name);
  }
});
