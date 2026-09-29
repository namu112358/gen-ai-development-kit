/**
 * 決定の記録の集計のテスト（Issue #151、harness/lib/report.ts の decisionRows・decisionAgreement・renderDecisionAgreement）。
 * shadow の plan-decision の記録（status: ok）ごとに、人がその後進めたか（App 以外が agent:plan-review を外した・Closes する PR を作った）、
 * 進めなかったか（計画を出し直した・PR 無しで閉じた）、未決かを決め、Jev の可否との 2×2 と一致率を集計・表示することを確かめる。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import type { IssueComment } from '../lib/github.ts';
import { decisionAgreement, decisionRows, renderDecisionAgreement, type DecisionRow } from '../lib/report.ts';
import { APP, config } from './support/gate-fixtures.ts';

const T0 = Date.parse('2026-09-27T00:00:00Z');
const HOUR = 3_600_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

function appRecord(id: number, kind: string, record: unknown, ms: number): IssueComment {
  return {
    id, body: `${appMark(kind)}\n記録\n${renderBlock('agent-app', record)}`, html_url: `c${id}`, created_at: at(ms), updated_at: at(ms),
    author_association: 'NONE', user: { login: APP, type: 'Bot' },
  } as IssueComment;
}

const gateRecord = (id: number, ms: number, pass = false) =>
  appRecord(id, 'plan-gate', { version: 1, planCommentId: id - 10, pass, reasons: [], planReviewOrigin: pass ? undefined : 'planner', plan: { files: ['docs/a.md'] } }, ms);

const decisionRecord = (id: number, ms: number, patch: Record<string, unknown> = {}) =>
  appRecord(id, 'plan-decision', { version: 1, decisionCommentId: id - 1, planCommentId: 80, mode: 'shadow', questionSet: 1, threshold: 0.9, status: 'ok', model: 'jev-test', answers: {}, pass: true, missing: [], regate: false, ...patch }, ms);

const unlabeled = (ms: number, login = 'me') => ({ event: 'unlabeled', created_at: at(ms), label: { name: 'agent:plan-review' }, actor: { login } });
const closed = (ms: number) => ({ event: 'closed', created_at: at(ms), actor: { login: 'me' } });


/** 計画ゲートの停止（0h）→ 決定の記録（1h、Jev は pass） */
const base = [gateRecord(90, 0), decisionRecord(101, HOUR)];

// ---- decisionRows ----

test('decisionRows：記録の後に App 以外が agent:plan-review を外したら進めた', () => {
  const rows = decisionRows(config, 3, base, [unlabeled(2 * HOUR)], []);
  assert.deepEqual(rows, [{ issue: 3, decisionCommentId: 100, recordedAt: at(HOUR), jevPass: true, humanProceeded: true }]);
});

test('decisionRows：App が外したのは人の判断に数えない', () => {
  const rows = decisionRows(config, 3, base, [unlabeled(2 * HOUR, APP)], []);
  assert.equal(rows[0]!.humanProceeded, null);
});

test('decisionRows：記録の後に Closes する PR が作られたら進めた（記録より前の PR は数えない）', () => {
  assert.equal(decisionRows(config, 3, base, [], [{ number: 5, createdAt: at(3 * HOUR) }])[0]!.humanProceeded, true);
  assert.equal(decisionRows(config, 3, base, [], [{ number: 5, createdAt: at(HOUR / 2) }])[0]!.humanProceeded, null);
});

test('decisionRows：進めないまま次の計画ゲートの記録が付いたら（出し直し）進めなかった', () => {
  const comments = [...base, gateRecord(91, 2 * HOUR)];
  assert.equal(decisionRows(config, 3, comments, [], [])[0]!.humanProceeded, false);
  // 次の計画ゲートの記録の後に外しても、この決定の判断には数えない
  assert.equal(decisionRows(config, 3, comments, [unlabeled(3 * HOUR)], [{ number: 5, createdAt: at(4 * HOUR) }])[0]!.humanProceeded, false);
});

test('decisionRows：PR 無しで Issue が閉じたら進めなかった', () => {
  const rows = decisionRows(config, 3, base, [closed(2 * HOUR)], []);
  assert.equal(rows[0]!.humanProceeded, false);
});

test('decisionRows：どちらでもなければ未決（null）', () => {
  assert.equal(decisionRows(config, 3, base, [], [])[0]!.humanProceeded, null);
});

test('decisionRows：shadow の status: ok の記録だけを数える（enforce・ineligible・invalid・skipped・error は数えない）', () => {
  const comments = [
    gateRecord(90, 0),
    decisionRecord(101, HOUR, { pass: false }),
    decisionRecord(103, HOUR + 1, { mode: 'enforce' }),
    decisionRecord(105, HOUR + 2, { status: 'ineligible' }),
    decisionRecord(107, HOUR + 3, { status: 'invalid' }),
    decisionRecord(109, HOUR + 4, { status: 'skipped' }),
    decisionRecord(111, HOUR + 5, { status: 'error' }),
  ];
  const rows = decisionRows(config, 3, comments, [unlabeled(2 * HOUR)], []);
  assert.deepEqual(rows, [{ issue: 3, decisionCommentId: 100, recordedAt: at(HOUR), jevPass: false, humanProceeded: true }]);
});

test('decisionRows：App 以外が書いた plan-decision の記録は数えない', () => {
  const forged = { ...decisionRecord(101, HOUR), user: { login: 'me', type: 'User' }, author_association: 'OWNER' } as IssueComment;
  assert.deepEqual(decisionRows(config, 3, [gateRecord(90, 0), forged], [], []), []);
});

// ---- decisionAgreement ----

const row = (jevPass: boolean | null, humanProceeded: boolean | null, issue = 3): DecisionRow => ({ issue, decisionCommentId: 100, recordedAt: at(HOUR), jevPass, humanProceeded });

test('decisionAgreement：未決を除いた Jev の可否×人の判断の 2×2 と一致率', () => {
  const rows = [
    row(true, true), row(true, true), row(true, true), // 一致
    row(false, false), row(false, false), // 一致
    row(true, false), // 不一致
    row(false, true), // 不一致
    row(true, true), // 一致
    row(true, null), row(false, null), row(null, true), // 未決（数えない）
  ];
  const s = decisionAgreement(rows);
  assert.deepEqual(
    { both: s.both, jevOnly: s.jevOnly, humanOnly: s.humanOnly, neither: s.neither },
    { both: 4, jevOnly: 1, humanOnly: 1, neither: 2 },
    'Jev 可×進めた・Jev 可×進めなかった・Jev 不可×進めた・Jev 不可×進めなかった',
  );
  assert.equal(s.decided, 8);
  assert.equal(s.undecided, 3);
  assert.equal(s.agreement, 0.75);
});

test('decisionAgreement：数えられる行が無ければ一致率は null', () => {
  const s = decisionAgreement([row(true, null)]);
  assert.equal(s.decided, 0);
  assert.equal(s.undecided, 1);
  assert.equal(s.agreement, null);
  assert.equal(decisionAgreement([]).agreement, null);
});

// ---- renderDecisionAgreement ----

test('renderDecisionAgreement：節の見出し・一致率・Issue ごとの表を出す', () => {
  const rows = [row(true, true, 12), row(true, true, 12), row(false, false, 13), row(true, false, 14), row(true, null, 15)];
  const text = renderDecisionAgreement(decisionAgreement(rows), rows);
  assert.match(text, /^## 人の決定の記録（Jev の判定と人の判断）$/m);
  assert.match(text, /一致率/);
  assert.match(text, /75(\.0+)?\s*%/, '一致率（3 / 4）を百分率で出す');
  for (const n of [12, 13, 14, 15]) assert.match(text, new RegExp(`#${n}\\b`), `#${n} の行`);
  assert.match(text, /^\|.*\|$/m, '表');
});

test('renderDecisionAgreement：行が無くても節を出す', () => {
  const text = renderDecisionAgreement(decisionAgreement([]), []);
  assert.match(text, /^## 人の決定の記録（Jev の判定と人の判断）$/m);
});
