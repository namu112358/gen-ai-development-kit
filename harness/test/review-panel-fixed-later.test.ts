import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { laterPassHead, panelComparison, panelPairs, renderPanelComparison } from '../lib/report.ts';
import type { PanelCompareInput, PanelPairRow } from '../lib/report.ts';
import { renderPanelRecord, type PanelRecord } from '../lib/review-panel.ts';
import type { BlockingFinding } from '../lib/verdict.ts';
import { APP, config, verdict } from './support/gate-fixtures.ts';

// 合体版のレビューの比較で、今の reviewer だけの指摘が後の合格の head で直されたかを数える（Issue #268）

const T0 = Date.parse('2026-09-01T00:00:00Z');
/** T0 から min 分 sec 秒後 */
const at = (min: number, sec = 0): string => new Date(T0 + min * 60_000 + sec * 1000).toISOString();
const sha = (c: string): string => c.repeat(40);

let nextId = 1000;
function comment(body: string, o: { at: string; login?: string; association?: string }): IssueComment {
  const id = nextId++;
  return {
    id,
    body,
    html_url: `u${id}`,
    created_at: o.at,
    updated_at: o.at,
    author_association: o.association ?? 'OWNER',
    user: { login: o.login ?? 'me', type: o.login === APP ? 'Bot' : 'User' },
  };
}

function record(pr: number, headSha: string, blocking: BlockingFinding[]): PanelRecord {
  return {
    version: 1,
    pr,
    headSha,
    mode: 'shadow',
    review: { pass: blocking.length === 0, blocking, nonBlocking: [], humanNotes: { concerns: [], checkPoints: [] } },
    findings: [],
    check: { exitCode: 0 },
    material: { pastPrs: 0, pastPrsWithoutComments: 0 },
    cost: { panel: { tokens: {}, totalUsd: 0.3, perModel: {} }, reviewer: { tokens: {}, totalUsd: 0.1, perModel: {} } },
  };
}

function verdictComment(pr: number, headSha: string, blocking: BlockingFinding[], createdAt: string): IssueComment {
  const v = verdict({ pr, headSha, review: { pass: blocking.length === 0, blocking, nonBlocking: [] } });
  return comment(`${CLAUDE_MARK}\n判定\n${renderBlock('agent-verdict', v)}`, { at: createdAt });
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

const f = (kind: BlockingFinding['kind'], file?: string, detail = `${kind} の指摘`): BlockingFinding => ({ kind, ...(file ? { file } : {}), detail });

const GUARD = '.claude/hooks/guard.ts';
const H = sha('a');
const L = sha('b');
const L2 = sha('c');

/**
 * 組になる head H の材料（10 分に記録、11 分に判定コメント、その1秒後に受け付け、今の reviewer が不合格なら2秒後に fix-request）。
 * 後の head の材料は addHead で足す。
 */
function pairInput(pr: number, reviewer: BlockingFinding[], panel: BlockingFinding[], extra: Partial<PanelCompareInput> = {}): PanelCompareInput {
  const rec = comment(renderPanelRecord(record(pr, H, panel)), { at: at(10) });
  const v = verdictComment(pr, H, reviewer, at(11));
  const a = acceptance(v, H, reviewer.length === 0);
  const fixRequestReviews = reviewer.length > 0 ? [fixRequest(H, at(11, 2), reviewer)] : [];
  return {
    pr,
    mergedAt: null,
    reverted: false,
    fixedBy: [],
    fixRequests: fixRequestReviews.length,
    comments: [rec, v, a.comment],
    acceptances: [a],
    fixRequestReviews,
    reviewComments: [],
    fixPrFiles: {},
    ...extra,
  };
}

/**
 * 記録の無い head の判定コメントと受け付けを足す（組にはならない）。受け付けは古い順に並べ直す。
 * pass が false なら不合格として受け付け、fixRequestFiles があればその head の fix-request も足す。
 */
function addHead(input: PanelCompareInput, head: string, minute: number, o: { pass: boolean; fixRequestFiles?: string[] }): void {
  const blocking = o.pass ? [] : [f('bug', 'later.ts')];
  const v = verdictComment(input.pr, head, blocking, at(minute));
  const a = acceptance(v, head, o.pass);
  input.comments.push(v, a.comment);
  input.acceptances.push(a);
  input.acceptances.sort((x, y) => Date.parse(x.comment.created_at) - Date.parse(y.comment.created_at));
  if (o.fixRequestFiles) {
    input.fixRequestReviews.push(fixRequest(head, at(minute, 2), o.fixRequestFiles.map((file) => f('bug', file, 'まだ直っていない'))));
    input.fixRequests++;
  }
}

/** #231 の形：H で今の reviewer が guard.ts にブロッキング、合体版は合格。後の head L が合格として受け付けられ、L までの変更に guard.ts がある */
function pr231(): PanelCompareInput {
  const input = pairInput(231, [f('bug', GUARD, 'ガードの抜け')], [], { laterHeadFiles: { [H]: [GUARD] } });
  addHead(input, L, 30, { pass: true });
  return input;
}

const rowsOf = (input: PanelCompareInput): PanelPairRow[] => panelPairs(config, input).rows;

// ---- 後の合格の head（laterPassHead） ----

test('後の合格の head：H の判定コメントより後に合格として受け付けられた別の head を返す（#231 の形）', () => {
  assert.equal(laterPassHead(pr231(), H), L);
});

test('後の合格の head：後の head が1つ目は不合格・2つ目は合格なら2つ目を返す', () => {
  const input = pairInput(231, [f('bug', GUARD)], []);
  addHead(input, L, 30, { pass: false });
  addHead(input, L2, 50, { pass: true });
  assert.equal(laterPassHead(input, H), L2);
});

test('後の合格の head：後の head が無い・不合格だけ・H の判定コメントより前の受け付けだけなら null', () => {
  const none = pairInput(231, [f('bug', GUARD)], []);
  assert.equal(laterPassHead(none, H), null, '後の head が無い');

  const failed = pairInput(231, [f('bug', GUARD)], []);
  addHead(failed, L, 30, { pass: false });
  assert.equal(laterPassHead(failed, H), null, '後の head が不合格');

  const before = pairInput(231, [f('bug', GUARD)], []);
  addHead(before, L, 1, { pass: true });
  assert.equal(laterPassHead(before, H), null, '受け付けが H の判定コメントより前');
});

test('後の合格の head：その head の最初の受け付けが不合格なら、同じ head の後の合格の受け付けは使わない', () => {
  const input = pairInput(231, [f('bug', GUARD)], []);
  addHead(input, L, 30, { pass: false });
  addHead(input, L, 40, { pass: true });
  assert.equal(laterPassHead(input, H), null);
});

test('後の合格の head：H の受け付けが無ければ null', () => {
  assert.equal(laterPassHead(pr231(), sha('z')), null);
});

// ---- 指摘の区分（AC1） ----

test('区分：#231 の形では今の reviewer だけの指摘が「後の head で直された」になり、裏付けは未確認のまま、基準 (2) には数えない', () => {
  const rows = rowsOf(pr231());
  assert.equal(rows.length, 1, '記録の無い後の head は組にならない');
  assert.deepEqual(rows[0]!.reviewerOnly.map((x) => [x.file, x.backing, x.evidence, x.fixedLater]), [[GUARD, 'unconfirmed', [], true]]);
  const s = panelComparison(rows);
  assert.equal(s.reviewerOnly, 1);
  assert.equal(s.reviewerOnlyBacked, 0);
  assert.equal(s.reviewerOnlyFixedLater, 1);
  assert.ok(!s.criteria.failed.includes('maxBackedReviewerOnly'), '後の head で直された指摘は基準 (2) に数えない');
});

// ---- 新しい区分にならない組（AC2） ----

/** 組の今の reviewer だけの指摘の fixedLater と、集計の reviewerOnlyFixedLater */
function fixedLaterOf(input: PanelCompareInput): { fixedLater: boolean[]; count: number } {
  const rows = rowsOf(input);
  return { fixedLater: rows.flatMap((r) => r.reviewerOnly.map((x) => x.fixedLater)), count: panelComparison(rows).reviewerOnlyFixedLater };
}

test('区分にならない：後の head までの変更に指摘のファイルが無い', () => {
  const input = pr231();
  input.laterHeadFiles = { [H]: ['other.ts'] };
  assert.deepEqual(fixedLaterOf(input), { fixedLater: [false], count: 0 });
});

test('区分にならない：laterHeadFiles が無い', () => {
  const input = pr231();
  delete input.laterHeadFiles;
  assert.deepEqual(fixedLaterOf(input), { fixedLater: [false], count: 0 });
});

test('区分にならない：後の head が無い', () => {
  const input = pairInput(231, [f('bug', GUARD)], [], { laterHeadFiles: { [H]: [GUARD] } });
  assert.deepEqual(fixedLaterOf(input), { fixedLater: [false], count: 0 });
});

test('区分にならない：後の head が不合格として受け付けられ、その後に合格の head が無い', () => {
  const input = pairInput(231, [f('bug', GUARD)], [], { laterHeadFiles: { [H]: [GUARD] } });
  addHead(input, L, 30, { pass: false });
  assert.deepEqual(fixedLaterOf(input), { fixedLater: [false], count: 0 });
});

test('区分にならない：後の head の受け付けが H の判定コメントより前', () => {
  const input = pairInput(231, [f('bug', GUARD)], [], { laterHeadFiles: { [H]: [GUARD] } });
  addHead(input, L, 1, { pass: true });
  assert.deepEqual(fixedLaterOf(input), { fixedLater: [false], count: 0 });
});

test('区分にならない：指摘にファイルが無い', () => {
  const input = pairInput(231, [f('ac-unmet')], [], { laterHeadFiles: { [H]: [GUARD] } });
  addHead(input, L, 30, { pass: true });
  assert.deepEqual(fixedLaterOf(input), { fixedLater: [false], count: 0 });
});

test('区分にならない：合体版だけの指摘は、後の合格の head がそのファイルを変えていても常に false', () => {
  const input = pairInput(232, [], [f('bug', 'p.ts')], { laterHeadFiles: { [H]: ['p.ts'] } });
  addHead(input, L, 30, { pass: true });
  const rows = rowsOf(input);
  assert.deepEqual(rows[0]!.panelOnly.map((x) => [x.file, x.fixedLater]), [['p.ts', false]]);
  assert.equal(panelComparison(rows).reviewerOnlyFixedLater, 0);
});

test('区分：後の head が1つ目は不合格・2つ目は合格なら、指摘は「後の head で直された」になる', () => {
  const input = pairInput(231, [f('bug', GUARD)], [], { laterHeadFiles: { [H]: [GUARD] } });
  addHead(input, L, 30, { pass: false });
  addHead(input, L2, 50, { pass: true });
  assert.deepEqual(fixedLaterOf(input), { fixedLater: [true], count: 1 });
});

test('区分：裏付けのある指摘は fixedLater でも reviewerOnlyFixedLater に数えず、基準 (2) は今までどおり満たさない', () => {
  const input = pairInput(231, [f('bug', GUARD)], [], { laterHeadFiles: { [H]: [GUARD] } });
  addHead(input, L, 30, { pass: false, fixRequestFiles: [GUARD] });
  addHead(input, L2, 50, { pass: true });
  const rows = rowsOf(input);
  assert.deepEqual(rows[0]!.reviewerOnly.map((x) => [x.backing, x.evidence, x.fixedLater]), [['backed', ['fix-request'], true]]);
  const s = panelComparison(rows);
  assert.equal(s.reviewerOnlyBacked, 1);
  assert.equal(s.reviewerOnlyFixedLater, 0);
  assert.ok(s.criteria.failed.includes('maxBackedReviewerOnly'));
});

// ---- 表示（AC3） ----

const render = (input: PanelCompareInput): string => {
  const rows = rowsOf(input);
  return renderPanelComparison(panelComparison(rows), rows, {});
};

test('表示：集計の表に「裏付けは無いが後の head で直された」の件数、指摘ごとの表に「未確認（後の head で直された）」が出る', () => {
  const text = render(pr231());
  assert.ok(text.includes('| 今の reviewer だけ（うち裏付けあり・裏付けは無いが後の head で直された） | 1（0・1） |'), text);
  assert.ok(text.includes('| 未確認（後の head で直された） |'), text);
});

test('表示：後の head で直された指摘が1件以上なら、基準の文の後に件数と「基準 (2) には数えない」を添える', () => {
  const text = render(pr231());
  assert.ok(text.includes('後の head で直された今の reviewer だけの指摘 1 件（基準 (2) には数えない。切り替えの前に人が確かめる）'), text);
});

test('表示：後の head で直された指摘が 0 件なら、基準の文に件数の文を添えず、指摘ごとの表は「未確認」のまま', () => {
  const input = pr231();
  delete input.laterHeadFiles;
  const text = render(input);
  assert.ok(!text.includes('件（基準 (2) には数えない'), text);
  assert.ok(!text.includes('後の head で直された今の reviewer だけの指摘'), text);
  assert.ok(text.includes('| 1（0・0） |'), text);
  assert.ok(text.includes('| 未確認 |'), text);
  assert.ok(!text.includes('未確認（後の head で直された）'), text);
});

test('表示：裏付けがあり後の head で直された指摘は「あり：…」に「・後の head で直された」を添える', () => {
  const input = pairInput(231, [f('bug', GUARD)], [], { laterHeadFiles: { [H]: [GUARD] } });
  addHead(input, L, 30, { pass: false, fixRequestFiles: [GUARD] });
  addHead(input, L2, 50, { pass: true });
  const text = render(input);
  assert.ok(text.includes('| あり：後の head の変更要求・後の head で直された |'), text);
  assert.ok(text.includes('| 1（1・0） |'), text);
});
