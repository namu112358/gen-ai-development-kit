// Issue #340：付き添いのセッションが聞かずに決めたこと（セッションの判定、```agent-session-judgment）の書式・本文と、
// agent:plan-review を「進める」と決めてよいか（planReviewRiskOnly：止めた理由が想定 Risk だけで、files がガードレール・delegateMergeExclude・
// harness.config.json に触れないときだけ真）、post-judgment の投稿の前の検査、render-judgment のコマンドを確かめる。
//
// このテストが前提にする公開の形（harness/lib/session-judgment.ts）：
// - parseSessionJudgment(raw: unknown): { ok: true; value: SessionJudgment } | { ok: false; errors: string[] }
// - renderSessionJudgment(j: SessionJudgment, session: string | null): string
//     先頭に claudeMark(session)、見出し「## セッションの判定」、決めたこと・基準の言葉（SESSION_JUDGMENT_BASIS_LABELS[basis]）・理由・「覆すなら」、
//     ```agent-session-judgment のブロックを1つ
// - SESSION_JUDGMENT_BASIS_LABELS: Record<basis, string>（基準を人が読む言葉に。空でない）
// - planReviewRiskOnly(record, config, opts): { riskOnly: boolean; remaining: string[]; touches: string[]; origin: 'gate' | 'planner' | null; critique: Plan['critique'] | null; notes: string[] }
//     record は App の最新の計画ゲートの記録の値（PlanGateRecord に計画の写し plan が付いたもの）か null。config は HarnessConfig。
//     opts は { issue: number; labels: string[]; latestPlanCommentId: number | null }（Issue 番号・今のラベル・最新の計画コメントの ID）。
//     記録が無い・通過済みなら riskOnly は偽で notes に理由。touches は通過済みの記録でも写しの files から求める。
// - judgmentPostable(judgment: SessionJudgment, check: ReturnType<typeof planReviewRiskOnly> | null): { ok: boolean; reasons: string[] }
//     post-judgment が投稿してよいか。basis が risk-only なら check があって check.riskOnly が真のときだけ ok。ほかの basis は check を見ずに ok。
// コマンド：node harness/scripts/agent.ts render-judgment <target> <file>
//     file は記録の JSON（オブジェクトそのもの）。GitHub を読まず、検査に通れば本文を標準出力に出して終了コード 0。
//     target の不一致・書式の誤り・JSON として読めないファイルは fail（終了コード 2）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CLAUDE_MARK, claudeMark, extractBlock } from '../lib/blocks.ts';
import { LABELS, type HarnessConfig } from '../lib/config.ts';
import { evaluateCritiqueGate, expectedPlanGate, PRIOR_PLAN_REVIEW_REASON_PREFIX, planReviewOrigin, type Plan } from '../lib/plan.ts';
import {
  judgmentPostable,
  parseSessionJudgment,
  planReviewRiskOnly,
  renderSessionJudgment,
  SESSION_JUDGMENT_BASIS_LABELS,
} from '../lib/session-judgment.ts';
import type { PlanGateRecord } from '../lib/state.ts';
import { config as loaded } from './support/gate-fixtures.ts';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const agentPath = join(root, 'harness', 'scripts', 'agent.ts');
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const ISSUE = 340;
const PLAN_COMMENT = 80;

/** テストの設定：ガードレールは harness/** と CLAUDE.md、委任の除外は src/payments/**（ガードレールではない） */
const cfg: HarnessConfig = { ...loaded, guardrailPaths: ['harness/**', 'CLAUDE.md'], guardrailExclude: [], delegateMergeExclude: ['src/payments/**'] };

/** ガードレール・委任の除外・harness.config.json のどれにも触れない files */
const SAFE_FILES = ['src/app/**', 'docs/app.md'];

const plan = (patch: Partial<Plan> = {}): Plan => ({
  version: 1,
  issue: ISSUE,
  risk: 'high',
  needsHuman: false,
  needsHumanReasons: [],
  acChangeProposed: false,
  openQuestions: [],
  files: SAFE_FILES,
  critique: { verdict: 'go', rounds: 1 },
  ...patch,
});

type Rec = PlanGateRecord & { plan?: unknown };

/** App（harness/gates/on-comment.ts）が止めたときと同じ形の記録：reasons は計画ゲートと批評の関所、出どころは planReviewOrigin */
function stopped(p: Plan, o: { config?: HarnessConfig; extraReasons?: string[]; labelBefore?: boolean; critiqueClaimed?: boolean } = {}): Rec {
  const gate = expectedPlanGate(p, ISSUE, o.config ?? cfg, o.critiqueClaimed ?? true);
  const reasons = [...gate.reasons, ...(o.extraReasons ?? [])];
  return { version: 1, planCommentId: PLAN_COMMENT, pass: false, reasons, planReviewOrigin: planReviewOrigin(p, o.labelBefore ?? false), plan: p };
}

const opts = (patch: Partial<{ issue: number; labels: string[]; latestPlanCommentId: number | null }> = {}) => ({
  issue: ISSUE,
  labels: [LABELS.planReview],
  latestPlanCommentId: PLAN_COMMENT,
  ...patch,
});

// ---- 書式（parseSessionJudgment）----

const valid = () => ({
  version: 1,
  target: ISSUE,
  stage: 'plan-review',
  basis: 'risk-only',
  decision: '計画のとおり implement に進める',
  reason: '止めた理由は想定 Risk の high だけで、files はガードレールに触れない',
  evidence: ['https://github.com/o/r/issues/340#issuecomment-1'],
});

test('parseSessionJudgment：正しい記録を読む（evidence は任意）', () => {
  const r = parseSessionJudgment(valid());
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value, valid());
  const noEvidence: Record<string, unknown> = valid();
  delete noEvidence.evidence;
  const r2 = parseSessionJudgment(noEvidence);
  assert.ok(r2.ok, JSON.stringify(r2));
  for (const stage of ['plan-review', 'plan-critique', 'scope', 'area-limit', 'other']) {
    for (const basis of ['risk-only', 'fixable', 'recorded', 'wait']) {
      assert.ok(parseSessionJudgment({ ...valid(), stage, basis }).ok, `${stage} / ${basis}`);
    }
  }
});

test('parseSessionJudgment：書式の誤りをそれぞれエラーにする', () => {
  const base = valid();
  const cases: [string, unknown][] = [
    ['オブジェクトでない', 'text'],
    ['null', null],
    ['版が 1 でない', { ...base, version: 2 }],
    ['版が無い', { ...base, version: undefined }],
    ['target が整数でない', { ...base, target: '340' }],
    ['target が小数', { ...base, target: 1.5 }],
    ['target が無い', { ...base, target: undefined }],
    ['stage が知らない値', { ...base, stage: 'implement' }],
    ['stage が無い', { ...base, stage: undefined }],
    ['basis が前の計画の gate-only', { ...base, basis: 'gate-only' }],
    ['basis が知らない値', { ...base, basis: 'human' }],
    ['basis が無い', { ...base, basis: undefined }],
    ['decision が空', { ...base, decision: '' }],
    ['decision が空白だけ', { ...base, decision: '   ' }],
    ['decision が無い', { ...base, decision: undefined }],
    ['reason が空', { ...base, reason: '' }],
    ['reason が無い', { ...base, reason: undefined }],
    ['evidence が文字列', { ...base, evidence: 'https://example.com' }],
    ['evidence に文字列でないもの', { ...base, evidence: ['u', 1] }],
  ];
  for (const [name, raw] of cases) {
    const r = parseSessionJudgment(raw);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.length > 0, name);
  }
});

// ---- 本文（renderSessionJudgment）----

test('renderSessionJudgment：目印・見出し・決めたこと・基準の言葉・理由・覆すなら・ブロック1つが入り、ブロックを読み戻すと同じ値', () => {
  for (const basis of ['risk-only', 'fixable', 'recorded', 'wait'] as const) {
    const parsed = parseSessionJudgment({ ...valid(), basis });
    assert.ok(parsed.ok);
    const body = renderSessionJudgment(parsed.value, SESSION);
    assert.ok(body.startsWith(`${claudeMark(SESSION)}\n`), body);
    assert.ok(body.includes('## セッションの判定'), body);
    assert.ok(body.includes(parsed.value.decision), 'decision');
    assert.ok(body.includes(parsed.value.reason), 'reason');
    const label = SESSION_JUDGMENT_BASIS_LABELS[basis];
    assert.ok(typeof label === 'string' && label.trim() !== '', `基準の言葉: ${basis}`);
    assert.ok(body.includes(label), `本文に基準の言葉: ${basis}`);
    assert.ok(body.includes('覆すなら'), body);
    assert.equal(body.split('```agent-session-judgment').length - 1, 1, 'ブロックは1つだけ');
    const b = extractBlock(body, 'agent-session-judgment');
    assert.ok(b.found && b.ok, JSON.stringify(b));
    assert.deepEqual(b.value, parsed.value);
  }
});

test('renderSessionJudgment：risk-only の覆し方は agent:hold を案内する。session が null なら ID の無い目印', () => {
  const parsed = parseSessionJudgment(valid());
  assert.ok(parsed.ok);
  const body = renderSessionJudgment(parsed.value, null);
  assert.ok(body.startsWith(`${CLAUDE_MARK}\n`), body);
  assert.ok(body.includes(LABELS.hold), body);
});

// ---- planReviewRiskOnly：真 ----

test('planReviewRiskOnly：想定 Risk（high・critical）だけで止まり files がどれにも触れない記録は真', () => {
  for (const risk of ['high', 'critical'] as const) {
    const record = stopped(plan({ risk }));
    assert.deepEqual(record.reasons, [`想定 Risk が ${risk} です`], '前提：Risk だけで止まった記録');
    assert.equal(record.planReviewOrigin, 'gate', '前提：出どころは App のゲート');
    const r = planReviewRiskOnly(record, cfg, opts());
    assert.equal(r.riskOnly, true, `${risk}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.remaining, []);
    assert.deepEqual(r.touches, []);
    assert.equal(r.origin, 'gate');
    assert.deepEqual(r.critique, { verdict: 'go', rounds: 1 });
  }
});

test('planReviewRiskOnly：批評が revise で mustRemaining が 0 か無いなら真', () => {
  for (const critique of [{ verdict: 'revise' as const, rounds: 2, mustRemaining: 0 }, { verdict: 'revise' as const, rounds: 2 }]) {
    const r = planReviewRiskOnly(stopped(plan({ critique })), cfg, opts());
    assert.equal(r.riskOnly, true, `${JSON.stringify(critique)}: ${JSON.stringify(r)}`);
  }
});

// ---- planReviewRiskOnly：ガードレールに触れる計画は偽（人に上げる）----

test('planReviewRiskOnly：files がガードレール・harness.config.json・delegateMergeExclude に触れる記録は偽で、touches に出る', () => {
  const cases: { name: string; record: Rec; touch: string; remains: boolean }[] = [
    { name: 'ガードレールだけで止まった', record: stopped(plan({ risk: 'low', files: ['harness/lib/x.ts'] })), touch: 'harness/lib/x.ts', remains: true },
    { name: 'Risk とガードレールで止まった', record: stopped(plan({ files: ['src/app/**', 'CLAUDE.md'] })), touch: 'CLAUDE.md', remains: true },
    { name: 'harness.config.json に触れる', record: stopped(plan({ files: ['src/app/**', 'harness.config.json'] })), touch: 'harness.config.json', remains: true },
    // 委任の除外はガードレールではないので、記録の理由は Risk だけになる。設定から直接見る touches で偽になる
    { name: 'delegateMergeExclude に重なる', record: stopped(plan({ files: ['src/payments/charge.ts'] })), touch: 'src/payments/charge.ts', remains: false },
  ];
  for (const c of cases) {
    const r = planReviewRiskOnly(c.record, cfg, opts());
    assert.equal(r.riskOnly, false, `${c.name}: ${JSON.stringify(r)}`);
    assert.ok(r.touches.includes(c.touch), `${c.name}: touches ${JSON.stringify(r.touches)}`);
    if (c.remains) {
      assert.ok(r.remaining.some((x: string) => x.startsWith('ガードレールに触れます')), `${c.name}: ガードレールの理由は除かずに残す ${JSON.stringify(r.remaining)}`);
      assert.ok(!r.remaining.some((x: string) => x.startsWith('想定 Risk が ')), `${c.name}: Risk の理由は除く`);
    }
  }
});

test('planReviewRiskOnly：記録の後に設定が変わって files がガードレールに当たるようになったら偽（記録の理由の文字列に頼らない）', () => {
  const record = stopped(plan());
  assert.deepEqual(record.reasons, ['想定 Risk が high です'], '前提：記録の時点では Risk だけ');
  const now: HarnessConfig = { ...cfg, guardrailPaths: [...cfg.guardrailPaths!, 'src/app/**'] };
  const r = planReviewRiskOnly(record, now, opts());
  assert.equal(r.riskOnly, false, JSON.stringify(r));
  assert.ok(r.touches.includes('src/app/**'), JSON.stringify(r.touches));
});

test('planReviewRiskOnly：設定に guardrailPaths か delegateMergeExclude が無いと、すべての files が当たって偽（安全側）', () => {
  const record = stopped(plan());
  for (const [name, c] of [
    ['guardrailPaths が無い', { ...cfg, guardrailPaths: undefined }],
    ['delegateMergeExclude が無い', { ...cfg, delegateMergeExclude: undefined }],
  ] as const) {
    const r = planReviewRiskOnly(record, c as HarnessConfig, opts());
    assert.equal(r.riskOnly, false, `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual([...r.touches].sort(), [...SAFE_FILES].sort(), name);
  }
});

test('planReviewRiskOnly：委任承認で通った記録は偽。写しの files がガードレールに触れれば touches に出る', () => {
  const p = plan({ files: ['harness/lib/x.ts'] });
  const record: Rec = {
    version: 1, planCommentId: PLAN_COMMENT, pass: true, reasons: [], plan: p,
    delegated: { skipped: ['想定 Risk が high です', 'ガードレールに触れます（人が実装して Merge する）: harness/lib/x.ts'], label: 'agent:delegate-plan', mode: 'plan', by: 'human', since: '2026-10-01T00:00:00.000Z' },
  };
  const r = planReviewRiskOnly(record, cfg, opts());
  assert.equal(r.riskOnly, false, JSON.stringify(r));
  assert.ok(r.notes.length > 0, '通過済みの理由');
  assert.ok(r.touches.includes('harness/lib/x.ts'), JSON.stringify(r.touches));
});

// ---- planReviewRiskOnly：そのほかの偽 ----

test('planReviewRiskOnly：記録が無い・通過済みなら偽で、notes に理由', () => {
  const none = planReviewRiskOnly(null, cfg, opts());
  assert.equal(none.riskOnly, false);
  assert.ok(none.notes.length > 0);
  const passed = planReviewRiskOnly({ version: 1, planCommentId: PLAN_COMMENT, pass: true, reasons: [], plan: plan({ risk: 'low' }) }, cfg, opts());
  assert.equal(passed.riskOnly, false);
  assert.ok(passed.notes.length > 0);
});

test('planReviewRiskOnly：App の記録の reasons に Risk 以外の理由があれば偽で、remaining に残す', () => {
  const resplit = 'この Issue は既に子課題に分けています（#1、#2）。分け直すか（既存の子課題をどうするか）は人が判断してください';
  const prior = `${PRIOR_PLAN_REVIEW_REASON_PREFIX}（Planner の申告か人が付けた印です。人が外すまで止めます）`;
  const noClaim = evaluateCritiqueGate(plan(), false).reasons;
  assert.equal(noClaim.length, 1, '前提：plan-critique の着手宣言が無い理由');
  const cases: { name: string; record: Rec; expect: (remaining: string[]) => boolean }[] = [
    { name: 'resplit', record: stopped(plan(), { extraReasons: [resplit] }), expect: (x) => x.includes(resplit) },
    { name: '前の印（人の印）', record: stopped(plan(), { extraReasons: [prior], labelBefore: true }), expect: (x) => x.includes(prior) },
    { name: '前の印（出どころは gate のまま）', record: { ...stopped(plan(), { extraReasons: [prior] }), planReviewOrigin: 'gate' }, expect: (x) => x.includes(prior) },
    { name: 'plan-critique の着手宣言が無い', record: stopped(plan(), { critiqueClaimed: false }), expect: (x) => x.includes(noClaim[0]!) },
    { name: 'files が無い', record: stopped(plan({ files: [] })), expect: (x) => x.some((r) => r.includes('files')) },
    { name: 'files の書式の誤り', record: stopped(plan({ files: ['../x.ts'] })), expect: (x) => x.some((r) => r.includes('../x.ts')) },
    { name: 'issue の不一致', record: stopped(plan({ issue: 341 })), expect: (x) => x.some((r) => r.includes('#341')) },
    { name: '批評の記録が無い', record: stopped(plan({ critique: undefined })), expect: (x) => x.some((r) => r.includes('critique')) },
    { name: 'needsHuman', record: stopped(plan({ needsHuman: true, needsHumanReasons: ['人が決める'] })), expect: (x) => x.length > 0 },
    { name: 'openQuestions', record: stopped(plan({ openQuestions: ['どちらにするか'] })), expect: (x) => x.length > 0 },
    { name: 'acChangeProposed', record: stopped(plan({ acChangeProposed: true })), expect: (x) => x.length > 0 },
  ];
  for (const c of cases) {
    const r = planReviewRiskOnly(c.record, cfg, opts());
    assert.equal(r.riskOnly, false, `${c.name}: ${JSON.stringify(r)}`);
    assert.ok(c.expect(r.remaining), `${c.name}: remaining ${JSON.stringify(r.remaining)}`);
    assert.ok(!r.remaining.includes('想定 Risk が high です'), `${c.name}: Risk の理由は除く`);
  }
});

test('planReviewRiskOnly：split の検査で止まった記録（split-invalid）は偽', () => {
  const p = plan({ files: [], split: [{ title: 'feat: a', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['src/a/**'], dependsOn: [] }] });
  const record = stopped(p);
  assert.ok(record.reasons.some((x) => x.startsWith('split は2件以上')), `前提：split の検査の理由 ${JSON.stringify(record.reasons)}`);
  const r = planReviewRiskOnly(record, cfg, opts());
  assert.equal(r.riskOnly, false, JSON.stringify(r));
  assert.ok(r.remaining.some((x: string) => x.startsWith('split は2件以上')));
});

test('planReviewRiskOnly：写しが split の計画なら、記録の Risk の理由を除かずに偽（split の計画は Risk の理由を出さない）', () => {
  const split = [
    { title: 'feat: a', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['src/a/**'], dependsOn: [] },
    { title: 'feat: b', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['src/b/**'], dependsOn: [0] },
  ];
  const record: Rec = { version: 1, planCommentId: PLAN_COMMENT, pass: false, reasons: ['想定 Risk が high です'], planReviewOrigin: 'gate', plan: plan({ files: [], split }) };
  const r = planReviewRiskOnly(record, cfg, opts());
  assert.equal(r.riskOnly, false, JSON.stringify(r));
  assert.deepEqual(r.remaining, ['想定 Risk が high です']);
});

test('planReviewRiskOnly：記録の Risk の理由が今のかけ直しと一致しなければ除かずに残して偽（安全側）', () => {
  // 記録は「high」、写しは critical：かけ直した skippable は「critical」なので記録の文字列は除かれない
  const record: Rec = { ...stopped(plan({ risk: 'critical' })), reasons: ['想定 Risk が high です'] };
  const r = planReviewRiskOnly(record, cfg, opts());
  assert.equal(r.riskOnly, false, JSON.stringify(r));
  assert.deepEqual(r.remaining, ['想定 Risk が high です']);
});

test('planReviewRiskOnly：Risk だけの記録でも、出どころ・写しの申告と批評・ラベル・計画コメントのどれかが外れれば偽', () => {
  const base = stopped(plan());
  const withCopy = (patch: Partial<Plan>): Rec => ({ ...base, plan: { ...plan(), ...patch } });
  const cases: { name: string; record: Rec; o?: ReturnType<typeof opts> }[] = [
    { name: '出どころが planner', record: { ...base, planReviewOrigin: 'planner' } },
    { name: '写しの acChangeProposed', record: withCopy({ acChangeProposed: true }) },
    { name: '写しの mustRemaining が 1', record: withCopy({ critique: { verdict: 'revise', rounds: 3, mustRemaining: 1 } }) },
    { name: '写しの mustRemaining が 2', record: withCopy({ critique: { verdict: 'revise', rounds: 3, mustRemaining: 2 } }) },
    { name: '写しに批評が無い', record: withCopy({ critique: undefined }) },
    { name: '写しの批評が split', record: withCopy({ critique: { verdict: 'split', rounds: 1 } }) },
    { name: '写しの批評が drop', record: withCopy({ critique: { verdict: 'drop', rounds: 1 } }) },
    { name: '写しが読めない', record: { ...base, plan: undefined } },
    { name: 'agent:hold が付いている', record: base, o: opts({ labels: [LABELS.planReview, LABELS.hold] }) },
    { name: '最新の計画コメントが記録と違う', record: base, o: opts({ latestPlanCommentId: PLAN_COMMENT + 1 }) },
    { name: '最新の計画コメントが無い', record: base, o: opts({ latestPlanCommentId: null }) },
  ];
  assert.equal(planReviewRiskOnly(base, cfg, opts()).riskOnly, true, '前提：外れなければ真');
  for (const c of cases) {
    const r = planReviewRiskOnly(c.record, cfg, c.o ?? opts());
    assert.equal(r.riskOnly, false, `${c.name}: ${JSON.stringify(r)}`);
  }
});

// ---- post-judgment の投稿の前の検査（judgmentPostable）----

test('judgmentPostable：basis が risk-only の判定は、riskOnly が真の結果があるときだけ投稿してよい', () => {
  const parsed = parseSessionJudgment(valid());
  assert.ok(parsed.ok);
  const guarded = planReviewRiskOnly(stopped(plan({ files: ['src/app/**', 'CLAUDE.md'] })), cfg, opts());
  assert.equal(guarded.riskOnly, false, '前提：ガードレールに触れる計画');
  const stop = judgmentPostable(parsed.value, guarded);
  assert.equal(stop.ok, false);
  assert.ok(stop.reasons.length > 0);
  const missing = judgmentPostable(parsed.value, null);
  assert.equal(missing.ok, false, '検査の結果が無ければ投稿しない');
  assert.ok(missing.reasons.length > 0);
  const ok = judgmentPostable(parsed.value, planReviewRiskOnly(stopped(plan()), cfg, opts()));
  assert.deepEqual(ok, { ok: true, reasons: [] });
});

test('judgmentPostable：risk-only でない判定は plan-review の検査を見ずに投稿してよい', () => {
  const guarded = planReviewRiskOnly(stopped(plan({ files: ['CLAUDE.md'] })), cfg, opts());
  for (const [stage, basis] of [['plan-review', 'fixable'], ['scope', 'fixable'], ['other', 'recorded'], ['area-limit', 'wait']]) {
    const parsed = parseSessionJudgment({ ...valid(), stage, basis });
    assert.ok(parsed.ok);
    assert.equal(judgmentPostable(parsed.value, guarded).ok, true, `${stage}/${basis} と偽の結果`);
    assert.equal(judgmentPostable(parsed.value, null).ok, true, `${stage}/${basis} と結果なし`);
  }
});

// ---- render-judgment のコマンド ----

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function fileWith(text: string): string {
  const d = mkdtempSync(join(tmpdir(), 'session-judgment-'));
  tmpDirs.push(d);
  const f = join(d, 'judgment.json');
  writeFileSync(f, text);
  return f;
}
function runAgent(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: 'owner/repo', AGENT_HARNESS_SESSION: SESSION };
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  return spawnSync(process.execPath, [agentPath, ...args], { cwd: root, encoding: 'utf8', env });
}

test('render-judgment：GitHub を読まずに本文を出す（目印にセッション ID、ブロックは記録と同じ値）', () => {
  const r = runAgent(['render-judgment', String(ISSUE), fileWith(JSON.stringify(valid()))]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`${claudeMark(SESSION)}\n`), r.stdout);
  assert.ok(r.stdout.includes('## セッションの判定'), r.stdout);
  const b = extractBlock(r.stdout, 'agent-session-judgment');
  assert.ok(b.found && b.ok, JSON.stringify(b));
  assert.deepEqual(b.value, valid());
});

test('render-judgment：target の不一致・書式の誤り・読めないファイルは終了コード 2', () => {
  const cases: [string, string, string][] = [
    ['target の不一致', String(ISSUE + 1), JSON.stringify(valid())],
    ['basis が gate-only', String(ISSUE), JSON.stringify({ ...valid(), basis: 'gate-only' })],
    ['decision が空', String(ISSUE), JSON.stringify({ ...valid(), decision: '' })],
    ['JSON でない', String(ISSUE), '{ not json'],
  ];
  for (const [name, target, text] of cases) {
    const r = runAgent(['render-judgment', target, fileWith(text)]);
    assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
    assert.ok(!r.stdout.includes('## セッションの判定'), `${name}: 本文を出さない`);
  }
});
