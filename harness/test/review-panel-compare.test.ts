import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { panelComparison, panelPairs, renderPanelComparison, REVIEW_PANEL_SWITCH_CRITERIA } from '../lib/report.ts';
import type { PanelCompareInput, PanelPairRow } from '../lib/report.ts';
import { renderPanelRecord, type CostSummary, type PanelRecord } from '../lib/review-panel.ts';
import type { BlockingFinding } from '../lib/verdict.ts';
import { APP, config, verdict } from './support/gate-fixtures.ts';

// 合体版のレビューの記録と今の判定を head ごとに組にして比べる集計と、切り替えの基準（Issue #150）

const T0 = Date.parse('2026-09-01T00:00:00Z');
/** T0 から min 分 sec 秒後 */
const at = (min: number, sec = 0): string => new Date(T0 + min * 60_000 + sec * 1000).toISOString();
const sha = (c: string): string => c.repeat(40);

let nextId = 1000;
function comment(body: string, o: { at: string; id?: number; association?: string; login?: string; updatedAt?: string }): IssueComment {
  const id = o.id ?? nextId++;
  return {
    id,
    body,
    html_url: `u${id}`,
    created_at: o.at,
    updated_at: o.updatedAt ?? o.at,
    author_association: o.association ?? 'OWNER',
    user: { login: o.login ?? 'me', type: o.login === APP ? 'Bot' : 'User' },
  };
}

const cost = (usd: number | null | undefined): CostSummary | null => (usd === null || usd === undefined ? null : { tokens: {}, totalUsd: usd, perModel: {} });

function record(pr: number, headSha: string, blocking: BlockingFinding[], o: { mode?: 'shadow' | 'enforce'; panelUsd?: number | null; reviewerUsd?: number | null } = {}): PanelRecord {
  return {
    version: 1,
    pr,
    headSha,
    mode: o.mode ?? 'shadow',
    review: { pass: blocking.length === 0, blocking, nonBlocking: [], humanNotes: { concerns: [], checkPoints: [] } },
    findings: [],
    check: { exitCode: 0 },
    material: { pastPrs: 0, pastPrsWithoutComments: 0 },
    cost: { panel: cost(o.panelUsd === undefined ? 0.3 : o.panelUsd), reviewer: cost(o.reviewerUsd === undefined ? 0.1 : o.reviewerUsd) },
  };
}

function verdictComment(pr: number, headSha: string, blocking: BlockingFinding[], o: { at: string; id?: number; updatedAt?: string }): IssueComment {
  const v = verdict({ pr, headSha, review: { pass: blocking.length === 0, blocking, nonBlocking: [] } });
  return comment(`${CLAUDE_MARK}\n判定\n${renderBlock('agent-verdict', v)}`, o);
}

function acceptance(v: IssueComment, headSha: string, reviewPass: boolean): { comment: IssueComment; value: Acceptance } {
  const value: Acceptance = {
    version: 1,
    verdictCommentId: v.id,
    verdictHeadSha: headSha,
    patchId: 'p'.repeat(40),
    reviewPass,
    riskLevel: 'critical',
    riskOk: false,
    scopeOk: true,
    outside: [],
    guardrail: [],
    autoEligible: false,
    reasons: ['理由'],
  };
  const t = new Date(Date.parse(v.created_at) + 1000).toISOString();
  return { comment: comment(`${appMark('acceptance')}\n受け付け\n${renderBlock('agent-app', value)}`, { at: t, login: APP, association: 'NONE' }), value };
}

/** App の fix-request のレビュー（harness/gates/on-comment.ts の renderBlockingReview と同じ行の形） */
function fixRequest(commitId: string, submittedAt: string, blocking: BlockingFinding[]): { commitId: string; submittedAt: string; body: string } {
  return {
    commitId,
    submittedAt,
    body: [
      '<!-- agent-harness:app kind=fix-request -->',
      'Reviewer のブロッキング指摘（修正 1 回目）。修正して push してください。',
      '',
      ...blocking.map((b) => `- **${b.kind}**${b.file ? ` \`${b.file}\`` : ''}: ${b.detail}`),
    ].join('\n'),
  };
}

function reviewComment(path: string, createdAt: string, o: { association?: string; login?: string; body?: string } = {}) {
  return { path, createdAt, authorAssociation: o.association ?? 'OWNER', login: o.login ?? 'me', body: o.body ?? 'ここを直してください' };
}

const f = (kind: BlockingFinding['kind'], file?: string, detail = `${kind} の指摘`): BlockingFinding => ({ kind, ...(file ? { file } : {}), detail });

interface PairSpec {
  head: string;
  /** 記録を書いた分（判定コメントはその1分後、受け付けはさらに1秒後、fix-request は2秒後） */
  minute: number;
  reviewer: BlockingFinding[];
  panel: BlockingFinding[];
  panelUsd?: number | null;
  reviewerUsd?: number | null;
}

/** 組ごとに「記録 → 判定コメント → 受け付け（→ 今の reviewer が不合格なら fix-request）」の順の材料を作る */
function prInput(pr: number, pairs: PairSpec[], extra: Partial<PanelCompareInput> = {}): PanelCompareInput {
  const comments: IssueComment[] = [];
  const acceptances: { comment: IssueComment; value: Acceptance }[] = [];
  const fixRequestReviews: { commitId: string; submittedAt: string; body: string }[] = [];
  for (const p of pairs) {
    comments.push(comment(renderPanelRecord(record(pr, p.head, p.panel, { panelUsd: p.panelUsd, reviewerUsd: p.reviewerUsd })), { at: at(p.minute) }));
    const v = verdictComment(pr, p.head, p.reviewer, { at: at(p.minute + 1) });
    comments.push(v);
    const a = acceptance(v, p.head, p.reviewer.length === 0);
    comments.push(a.comment);
    acceptances.push(a);
    if (p.reviewer.length > 0) fixRequestReviews.push(fixRequest(p.head, at(p.minute + 1, 2), p.reviewer));
  }
  return {
    pr,
    mergedAt: null,
    reverted: false,
    fixedBy: [],
    fixRequests: fixRequestReviews.length,
    comments,
    acceptances,
    fixRequestReviews,
    reviewComments: [],
    fixPrFiles: {},
    ...extra,
  };
}

/** 0 件の理由を除いた外した件数 */
const nonzero = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0));

/** 複数の PR の組の行と外した件数を合わせる（harness/scripts/report.ts と同じ足し方） */
function collect(inputs: PanelCompareInput[]): { rows: PanelPairRow[]; excluded: Record<string, number> } {
  const rows: PanelPairRow[] = [];
  const excluded: Record<string, number> = {};
  for (const input of inputs) {
    const r = panelPairs(config, input);
    rows.push(...r.rows);
    for (const [k, n] of Object.entries(r.excluded)) excluded[k] = (excluded[k] ?? 0) + n;
  }
  return { rows, excluded };
}

// ---- 基準の定数 ----

test('基準：REVIEW_PANEL_SWITCH_CRITERIA は計画で人が決めた5つの値', () => {
  assert.deepEqual({ ...REVIEW_PANEL_SWITCH_CRITERIA }, {
    minPairedPrs: 20,
    maxBackedReviewerOnly: 0,
    maxSuspectedFalsePositiveRatio: 0.5,
    maxProvisionalFixRatio: 1.5,
    maxCostMedianRatio: 3,
  });
});

// ---- 決まった材料からの集計（AC1） ----

const LONG_DETAIL = 'x'.repeat(119) + 'Y' + 'Z'.repeat(80);

/** 7件の PR・8つの組。期待値はテストの中のコメント */
function scenario(): PanelCompareInput[] {
  const later = at(500);
  return [
    // PR 1：両方合格
    prInput(1, [{ head: sha('1'), minute: 0, reviewer: [], panel: [], panelUsd: 0.3, reviewerUsd: null }]),
    // PR 2：組が2つ。B1 は x.ts が一致・合体版だけのファイルの無い claude-md。Merge 済みで裏付け無し → 誤検知の疑い
    prInput(
      2,
      [
        { head: sha('2'), minute: 10, reviewer: [f('bug', 'x.ts')], panel: [f('bug', 'x.ts'), f('claude-md')], panelUsd: 0.5, reviewerUsd: 0.2 },
        { head: sha('3'), minute: 20, reviewer: [], panel: [], panelUsd: null, reviewerUsd: 0.2 },
      ],
      { mergedAt: at(30) },
    ),
    // PR 3：ファイルの無い ac-unmet は種類で一致。今の reviewer だけの regression y.ts は後の head の fix-request で裏付けあり
    (() => {
      const input = prInput(3, [{ head: sha('4'), minute: 40, reviewer: [f('ac-unmet'), f('regression', 'y.ts')], panel: [f('ac-unmet')], panelUsd: 0.7, reviewerUsd: 0.2 }]);
      input.fixRequestReviews.push(fixRequest(sha('5'), at(60), [f('regression', 'y.ts', 'まだ直っていない')]));
      input.fixRequests = 2;
      return input;
    })(),
    // PR 4：合体版だけの p.ts（人のレビューコメント）・q.ts（fix の PR）は裏付けあり。r.ts は数えない材料だけなので誤検知の疑い
    prInput(4, [{ head: sha('6'), minute: 70, reviewer: [], panel: [f('bug', 'p.ts'), f('bug', 'q.ts'), f('regression', 'r.ts')], panelUsd: 0.2, reviewerUsd: 0.2 }], {
      mergedAt: at(90),
      fixedBy: [99],
      fixPrFiles: { 99: ['q.ts', 'other.ts'] },
      reviewComments: [
        reviewComment('p.ts', at(80)),
        // 以下は r.ts の裏付けにならない：Claude の目印・App・コラボレーターでない・判定コメントより前
        reviewComment('r.ts', at(80), { body: `${CLAUDE_MARK}\nセッションのコメント` }),
        reviewComment('r.ts', at(80), { login: APP, association: 'NONE' }),
        reviewComment('r.ts', at(80), { association: 'CONTRIBUTOR', login: 'someone' }),
        reviewComment('r.ts', at(70, 30)),
      ],
      // 別の head だが判定コメントより前に出た fix-request は「後の head」に当たらない
      fixRequestReviews: [fixRequest(sha('7'), at(70, 30), [f('regression', 'r.ts')])],
      fixRequests: 0,
    }),
    // PR 5：合体版だけの z.ts。revert されたので裏付けあり
    prInput(5, [{ head: sha('8'), minute: 100, reviewer: [], panel: [f('bug', 'z.ts')], panelUsd: 0.4, reviewerUsd: 0.2 }], { mergedAt: at(110), reverted: true }),
    // PR 6：合体版だけの u.ts。Merge されていないので未確認（疑いに数えない）。本文が長い
    prInput(6, [{ head: sha('9'), minute: 120, reviewer: [], panel: [f('bug', 'u.ts', LONG_DETAIL)], panelUsd: 0.6, reviewerUsd: 0.2 }]),
    // PR 7：今の reviewer だけの w.ts。裏付け無し・未 Merge → 未確認
    prInput(7, [{ head: sha('a'), minute: 140, reviewer: [f('bug', 'w.ts')], panel: [], panelUsd: 0.1, reviewerUsd: 0.2 }], { reviewComments: [reviewComment('w.ts', later, { association: 'NONE', login: 'x' })] }),
  ];
}

test('組：記録・受け付け・判定コメントから head ごとに組を作り、合否と指摘の一致を出す', () => {
  const { rows, excluded } = collect(scenario());
  assert.deepEqual(nonzero(excluded), {});
  assert.deepEqual(rows.map((r) => [r.pr, r.headSha]), [[1, sha('1')], [2, sha('2')], [2, sha('3')], [3, sha('4')], [4, sha('6')], [5, sha('8')], [6, sha('9')], [7, sha('a')]]);

  const b1 = rows[1]!;
  assert.equal(b1.reviewerPass, false);
  assert.equal(b1.panelPass, false);
  assert.deepEqual(b1.reviewerBlocking.map((b) => b.file), ['x.ts']);
  assert.equal(b1.matched, 1);
  assert.deepEqual(b1.reviewerOnly, []);
  assert.deepEqual(b1.panelOnly.map((x) => [x.kind, x.file, x.backing]), [['claude-md', undefined, 'suspected']]);

  const c = rows[3]!;
  assert.equal(c.matched, 1, 'ファイルの無い ac-unmet 同士は種類で一致');
  assert.deepEqual(c.reviewerOnly.map((x) => [x.kind, x.file, x.backing, x.evidence]), [['regression', 'y.ts', 'backed', ['fix-request']]]);
  assert.deepEqual(c.panelOnly, []);
});

test('裏付け：後の head の fix-request・人のレビューコメント・fix の PR・revert のどれかで「裏付けあり」、無ければ Merge 済みは誤検知の疑い、未 Merge は未確認', () => {
  const { rows } = collect(scenario());
  const byPr = (pr: number) => rows.find((r) => r.pr === pr)!;
  assert.deepEqual(byPr(4).panelOnly.map((x) => [x.file, x.backing, x.evidence]), [
    ['p.ts', 'backed', ['human-review']],
    ['q.ts', 'backed', ['fix-pr']],
    ['r.ts', 'suspected', []],
  ]);
  assert.deepEqual(byPr(5).panelOnly.map((x) => [x.file, x.backing, x.evidence]), [['z.ts', 'backed', ['revert']]]);
  assert.deepEqual(byPr(6).panelOnly.map((x) => [x.file, x.backing]), [['u.ts', 'unconfirmed']]);
  assert.deepEqual(byPr(7).reviewerOnly.map((x) => [x.file, x.backing]), [['w.ts', 'unconfirmed']], 'コラボレーターでない人のコメントは裏付けにならない');
});

test('集計：組の数・2×2・一致・裏付け・誤検知の疑い・修正の往復・料金の中央値・基準', () => {
  const s = panelComparison(collect(scenario()).rows);
  assert.equal(s.pairedPrs, 7);
  assert.equal(s.pairs, 8);
  assert.deepEqual(s.passMatrix, {
    reviewerPass: { panelPass: 2, panelFail: 3 },
    reviewerFail: { panelPass: 1, panelFail: 2 },
  });
  assert.equal(s.matched, 2);
  assert.equal(s.reviewerOnly, 2);
  assert.equal(s.reviewerOnlyBacked, 1);
  assert.equal(s.panelOnly, 6);
  assert.equal(s.panelOnlyBacked, 3);
  assert.equal(s.suspectedFalsePositives, 2);
  // 実際＝組になった PR の fixRequests の合計（PR 2 の 1・PR 3 の 2・PR 7 の 1）、仮＝合体版が不合格の組、参考＝今の reviewer が不合格の組
  assert.deepEqual(s.fixRounds, { actual: 4, provisional: 5, reviewerFailPairs: 3 });
  // 合体版は null を除く 7 件 0.1〜0.7 の中央値、今の reviewer は PR 1 の null を除く 7 件
  assert.deepEqual(s.costMedianUsd, { panel: 0.4, reviewer: 0.2 });
  assert.deepEqual(s.costMissing, { panel: 1, reviewer: 1 });
  assert.equal(s.criteria.met, false);
  assert.deepEqual([...s.criteria.failed].sort(), ['maxBackedReviewerOnly', 'minPairedPrs']);
});

test('一致：前から順に1対1で対応させ、使った相手は再び使わない。ファイルの有る指摘と無い指摘は種類が同じでも一致しない', () => {
  const { rows } = collect([
    prInput(1, [{ head: sha('1'), minute: 0, reviewer: [f('bug', 'a.ts'), f('regression', 'a.ts')], panel: [f('bug', 'a.ts')] }]),
    prInput(2, [{ head: sha('2'), minute: 10, reviewer: [f('bug')], panel: [f('bug', 'k.ts')] }]),
  ]);
  assert.equal(rows[0]!.matched, 1);
  assert.deepEqual(rows[0]!.reviewerOnly.map((x) => [x.kind, x.file]), [['regression', 'a.ts']]);
  assert.deepEqual(rows[0]!.panelOnly, []);
  assert.equal(rows[1]!.matched, 0);
  assert.deepEqual(rows[1]!.reviewerOnly.map((x) => [x.kind, x.file]), [['bug', undefined]]);
  assert.deepEqual(rows[1]!.panelOnly.map((x) => [x.kind, x.file]), [['bug', 'k.ts']]);
});

test('今の reviewer の指摘：同じ head の App の fix-request を判定コメントより優先して読み、別の head の fix-request は使わない', () => {
  const input = prInput(1, [{ head: sha('1'), minute: 0, reviewer: [f('bug', 'v.ts')], panel: [f('bug', 'f.ts')] }]);
  input.fixRequestReviews = [fixRequest(sha('9'), at(0, 30), [f('bug', 'old.ts')]), fixRequest(sha('1'), at(1, 2), [f('bug', 'f.ts')])];
  const { rows } = collect([input]);
  assert.deepEqual(rows[0]!.reviewerBlocking.map((b) => b.file), ['f.ts']);
  assert.equal(rows[0]!.matched, 1);
});

test('今の reviewer の指摘：不合格で fix-request が無いときは未編集の判定コメントの review.blocking を使う', () => {
  const input = prInput(1, [{ head: sha('1'), minute: 0, reviewer: [f('bug', 'm.ts')], panel: [f('bug', 'm.ts')] }]);
  input.fixRequestReviews = [];
  input.fixRequests = 0;
  const { rows, excluded } = collect([input]);
  assert.deepEqual(nonzero(excluded), {});
  assert.deepEqual(rows[0]!.reviewerBlocking.map((b) => b.file), ['m.ts']);
  assert.equal(rows[0]!.matched, 1);
});

test('今の reviewer の指摘：不合格で fix-request が無く、判定コメントが編集済み・見つからないときは組を外して reviewer-unknown で数える', () => {
  const edited = prInput(1, [{ head: sha('1'), minute: 0, reviewer: [f('bug', 'm.ts')], panel: [] }]);
  edited.fixRequestReviews = [];
  const v = edited.comments.find((c) => c.id === edited.acceptances[0]!.value.verdictCommentId)!;
  v.updated_at = at(5);

  const missing = prInput(2, [{ head: sha('2'), minute: 10, reviewer: [f('bug', 'm.ts')], panel: [] }]);
  missing.fixRequestReviews = [];
  missing.comments = missing.comments.filter((c) => c.id !== missing.acceptances[0]!.value.verdictCommentId);

  const { rows, excluded } = collect([edited, missing]);
  assert.deepEqual(rows, []);
  assert.deepEqual(nonzero(excluded), { 'reviewer-unknown': 2 });
});

// ---- 基準の境目（AC1） ----

/** 両方合格の組だけの PR を n 件 */
const passingPrs = (n: number, start = 1, usd: { panel?: number | null; reviewer?: number | null } = {}): PanelCompareInput[] =>
  Array.from({ length: n }, (_, i) =>
    prInput(start + i, [{ head: sha('1'), minute: i * 10, reviewer: [], panel: [], panelUsd: usd.panel === undefined ? 0.1 : usd.panel, reviewerUsd: usd.reviewer === undefined ? 0.1 : usd.reviewer }]),
  );

const failedOf = (inputs: PanelCompareInput[]): string[] => panelComparison(collect(inputs).rows).criteria.failed;

test('基準：組になった PR は 19 件では満たさず、20 件で満たす（ほかの項目もすべて満たす）', () => {
  assert.deepEqual(failedOf(passingPrs(19)), ['minPairedPrs']);
  const s = panelComparison(collect(passingPrs(20)).rows);
  assert.equal(s.pairedPrs, 20);
  assert.deepEqual(s.criteria.failed, []);
  assert.equal(s.criteria.met, true);
});

test('基準：今の reviewer だけで裏付けのあるブロッキングが1件でもあれば満たさない（未確認なら満たす）', () => {
  const unconfirmed = prInput(21, [{ head: sha('2'), minute: 0, reviewer: [f('bug', 'w.ts')], panel: [] }], { fixRequests: 1 });
  assert.ok(!failedOf([...passingPrs(20), unconfirmed]).includes('maxBackedReviewerOnly'));
  const backed = prInput(21, [{ head: sha('2'), minute: 0, reviewer: [f('bug', 'w.ts')], panel: [] }], { fixRequests: 1, mergedAt: at(5), reverted: true });
  assert.ok(failedOf([...passingPrs(20), backed]).includes('maxBackedReviewerOnly'));
});

test('基準：合体版だけのうち誤検知の疑いがちょうど半分なら満たし、半分を超えると満たさない', () => {
  const suspected = prInput(21, [{ head: sha('2'), minute: 0, reviewer: [], panel: [f('bug', 's.ts')] }], { mergedAt: at(5), fixRequests: 1 });
  const backed = prInput(22, [{ head: sha('3'), minute: 0, reviewer: [], panel: [f('bug', 't.ts')] }], { mergedAt: at(5), reverted: true, fixRequests: 1 });
  const suspected2 = prInput(22, [{ head: sha('3'), minute: 0, reviewer: [], panel: [f('bug', 't.ts')] }], { mergedAt: at(5), fixRequests: 1 });
  assert.ok(!failedOf([...passingPrs(20), suspected, backed]).includes('maxSuspectedFalsePositiveRatio'));
  assert.ok(failedOf([...passingPrs(20), suspected, suspected2]).includes('maxSuspectedFalsePositiveRatio'));
});

test('基準：合体版の仮の往復は実際のちょうど 1.5 倍なら満たし、超えると満たさない。実際が 0 で仮が 1 以上なら満たさない', () => {
  /** 合体版だけが不合格の組（未 Merge なので誤検知の疑いには数えない） */
  const panelFail = (pr: number, fixRequests: number) => prInput(pr, [{ head: sha('2'), minute: 0, reviewer: [], panel: [f('bug', 'k.ts')] }], { fixRequests });
  const key = 'maxProvisionalFixRatio';
  // 実際 2・仮 3
  assert.ok(!failedOf([...passingPrs(20), panelFail(21, 2), panelFail(22, 0), panelFail(23, 0)]).includes(key));
  // 実際 2・仮 4
  assert.ok(failedOf([...passingPrs(20), panelFail(21, 2), panelFail(22, 0), panelFail(23, 0), panelFail(24, 0)]).includes(key));
  // 実際 0・仮 1
  assert.ok(failedOf([...passingPrs(20), panelFail(21, 0)]).includes(key));
  // 実際 0・仮 0
  assert.ok(!failedOf(passingPrs(20)).includes(key));
});

test('基準：料金の中央値が今の reviewer のちょうど 3 倍なら満たし、超えると満たさない。どちらかの値が1つも無ければ満たさない', () => {
  const key = 'maxCostMedianRatio';
  assert.ok(!failedOf(passingPrs(20, 1, { panel: 0.3, reviewer: 0.1 })).includes(key));
  assert.ok(failedOf(passingPrs(20, 1, { panel: 0.31, reviewer: 0.1 })).includes(key));
  assert.ok(failedOf(passingPrs(20, 1, { panel: null, reviewer: 0.1 })).includes(key));
  assert.ok(failedOf(passingPrs(20, 1, { panel: 0.1, reviewer: null })).includes(key));
  const s = panelComparison(collect(passingPrs(20, 1, { panel: null, reviewer: 0.1 })).rows);
  assert.equal(s.costMedianUsd.panel, null);
  assert.equal(s.costMissing.panel, 20);
});

// ---- 表示（AC1） ----

test('表示：見出し・n / 20・申告の注記・事実と申告の列・外した件数・基準の行が出て、指摘の本文は 120 字で切る', () => {
  const { rows } = collect(scenario());
  const text = renderPanelComparison(panelComparison(rows), rows, { edited: 2, 'after-verdict': 1 });
  assert.match(text, /^## 合体版のレビュー（記録だけの期間の比較）$/m);
  assert.ok(text.includes('7 / 20'), '組になった PR n / 20');
  assert.ok(text.includes('セッションの申告'));
  assert.ok(text.includes('偽れる'));
  assert.ok(text.includes('App・GitHub の事実'));
  assert.ok(text.includes('edited') && text.includes('after-verdict'), '外した理由');
  assert.ok(text.includes('基準'));
  assert.ok(text.includes(LONG_DETAIL.slice(0, 120)), '120 字までは載せる');
  assert.ok(!text.includes('YZ'), '121 字目からは載せない');
  for (const file of ['p.ts', 'q.ts', 'r.ts', 'z.ts', 'u.ts', 'y.ts', 'w.ts']) assert.ok(text.includes(file), `一覧に ${file}`);
});

// ---- 数える記録の絞り込み（AC2） ----

const H = sha('1');

/** 判定コメント（10 分）と受け付けのある PR 5 に、記録のコメントを足す */
function baseInput(): { input: PanelCompareInput; verdictComment: IssueComment } {
  const v = verdictComment(5, H, [], { at: at(10) });
  const a = acceptance(v, H, true);
  return {
    verdictComment: v,
    input: {
      pr: 5,
      mergedAt: null,
      reverted: false,
      fixedBy: [],
      fixRequests: 0,
      comments: [v, a.comment],
      acceptances: [a],
      fixRequestReviews: [],
      reviewComments: [],
      fixPrFiles: {},
    },
  };
}

test('絞り込み：コラボレーターでない・目印が無い・読めない・編集済み・別の PR・enforce・head の不一致・判定コメントより後の記録を理由ごとに外す', () => {
  const { input } = baseInput();
  const valid = renderPanelRecord(record(5, H, [f('bug', 'valid.ts')]));
  const withoutMark = valid.replace(CLAUDE_MARK, '');
  input.comments.push(
    comment(valid, { at: at(5) }),
    comment(valid, { at: at(1), association: 'CONTRIBUTOR', login: 'someone' }),
    comment(valid, { at: at(1), association: 'NONE', login: 'someone' }),
    comment(withoutMark, { at: at(1) }),
    comment(`${CLAUDE_MARK}\n\`\`\`agent-review-panel\n{壊れた JSON\n\`\`\``, { at: at(1) }),
    comment(`${CLAUDE_MARK}\nagent-review-panel の記録はあとで書きます`, { at: at(1) }),
    comment(valid, { at: at(1), updatedAt: at(2) }),
    comment(renderPanelRecord(record(999, H, [])), { at: at(1) }),
    comment(renderPanelRecord(record(5, H, [], { mode: 'enforce' })), { at: at(1) }),
    comment(renderPanelRecord(record(5, sha('e'), [])), { at: at(1) }),
    comment(valid, { at: at(11) }),
    // App のコメントは候補にしない（どの理由にも数えない）
    comment(valid, { at: at(1), login: APP, association: 'NONE' }),
  );
  const { rows, excluded } = panelPairs(config, input);
  assert.deepEqual(nonzero(excluded), {
    'not-collaborator': 2,
    'no-mark': 1,
    unreadable: 2,
    edited: 1,
    'other-pr': 1,
    enforce: 1,
    'head-mismatch': 1,
    'after-verdict': 1,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.panelBlocking.map((b) => b.file), ['valid.ts'], '残った1つの記録で組を作る');
});

test('絞り込み：判定コメントと同じ秒の記録は comment id で前後を決める', () => {
  const { input, verdictComment: v } = baseInput();
  input.comments.push(
    comment(renderPanelRecord(record(5, H, [f('bug', 'before.ts')])), { at: v.created_at, id: v.id - 1 }),
    comment(renderPanelRecord(record(5, H, [f('bug', 'after.ts')])), { at: v.created_at, id: v.id + 100000 }),
  );
  const { rows, excluded } = panelPairs(config, input);
  assert.deepEqual(nonzero(excluded), { 'after-verdict': 1 });
  assert.deepEqual(rows[0]!.panelBlocking.map((b) => b.file), ['before.ts']);
});

test('絞り込み：同じ head の数える記録が2つ以上なら判定コメントの直前の1つを使い、残りを duplicate で数える', () => {
  const { input } = baseInput();
  input.comments.push(
    comment(renderPanelRecord(record(5, H, [f('bug', 'first.ts')])), { at: at(3) }),
    comment(renderPanelRecord(record(5, H, [])), { at: at(5) }),
    comment(renderPanelRecord(record(5, H, [f('bug', 'last.ts')])), { at: at(7) }),
  );
  const { rows, excluded } = panelPairs(config, input);
  assert.deepEqual(nonzero(excluded), { duplicate: 2 });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.panelBlocking.map((b) => b.file), ['last.ts']);
});

test('絞り込み：同じ head の受け付けが2つあれば最初の受け付けだけで組を作り、その判定コメントより後の記録は after-verdict', () => {
  const { input } = baseInput();
  const v2 = verdictComment(5, H, [], { at: at(20) });
  const a2 = acceptance(v2, H, true);
  input.comments.push(v2, a2.comment);
  input.acceptances.push(a2);
  input.comments.push(
    comment(renderPanelRecord(record(5, H, [f('bug', 'early.ts')])), { at: at(5) }),
    comment(renderPanelRecord(record(5, H, [f('bug', 'between.ts')])), { at: at(15) }),
  );
  const { rows, excluded } = panelPairs(config, input);
  assert.deepEqual(nonzero(excluded), { 'after-verdict': 1 });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.panelBlocking.map((b) => b.file), ['early.ts']);
});

test('絞り込み：数える記録が無い受け付けは組にならず、組になった PR にも数えない', () => {
  const { input } = baseInput();
  const { rows, excluded } = panelPairs(config, input);
  assert.deepEqual(rows, []);
  assert.deepEqual(nonzero(excluded), {});
  assert.equal(panelComparison(rows).pairedPrs, 0);
});
