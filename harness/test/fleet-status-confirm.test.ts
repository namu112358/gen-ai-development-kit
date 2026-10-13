/**
 * fleet-status の表の確認事項の扱い（Issue #954）：答えの無い確認事項の行は次にやること none・confirmWait（確認事項の時刻と URL）で、
 * selectFleet が選ばずに待つ理由を付け（同じファイルを触るほかの Issue を待たせない）、humanWaitOf の since が確認事項の時刻になる。
 * 答えのそろった行は、次にやることが再開の段階（resume）になり、段階は変えない。文言は固定せず、値で確かめる。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, humanWaitOf, selectFleet, type FleetFacts } from '../lib/fleet.ts';
import { CONFIRM_AT, NOW, SESSION, confirmAnswer, confirmFact, fleetIssue, planOkFacts } from './support/step-fixtures.ts';

const config = loadConfig();
const LIMIT = 120;

test('答え待ちの行は none・confirmWait・選ばれず・humanWaitOf の since が確認事項の時刻、答えのそろった行は次にやることが resume', () => {
  const PENDING = 1;
  const RESUME_IMPLEMENT = 2;
  const RESUME_PLAN = 3;
  const pending = confirmFact({ url: 'https://github.com/o/r/issues/1#issuecomment-900', confirm: { target: PENDING } });
  const facts: FleetFacts = {
    issues: [
      // 答え待ちの行は、答えのそろった行と同じファイルを触る（並び順も先）
      fleetIssue(planOkFacts({ number: PENDING, title: 't1' }), { planFiles: ['harness/lib/a.ts'], confirms: [pending] }),
      fleetIssue(planOkFacts({ number: RESUME_IMPLEMENT, title: 't2' }), {
        planFiles: ['harness/lib/a.ts'],
        confirms: [confirmFact({ confirm: { target: RESUME_IMPLEMENT, stage: 'implement', resume: 'implement' }, answer: confirmAnswer() })],
      }),
      fleetIssue(planOkFacts({ number: RESUME_PLAN, title: 't3' }), {
        planFiles: ['harness/lib/b.ts'],
        confirms: [confirmFact({ confirm: { target: RESUME_PLAN, stage: 'implement', resume: 'plan' }, answer: confirmAnswer() })],
      }),
    ],
    prConflicts: [],
  };
  const rows = fleetStatus(facts);
  const row = (n: number) => rows.find((r) => r.issue === n)!;

  // 答え待ち
  assert.equal(row(PENDING).next, 'none');
  assert.equal(row(PENDING).stage, 'plan-ok', '段階は変えない');
  assert.deepEqual(row(PENDING).confirmWait, { since: CONFIRM_AT, url: pending.url });
  const sel = selectFleet(config, facts, rows, null, SESSION, null, { limitMinutes: LIMIT, now: NOW });
  assert.equal(sel.selected.includes(PENDING), false, '答え待ちの行は選ばない');
  assert.ok((sel.excluded.get(PENDING) ?? '') !== '', '待つ理由が付く');
  const hw = humanWaitOf(row(PENDING), facts.issues[0]!.facts, NOW, LIMIT);
  assert.equal(hw?.since, CONFIRM_AT);
  assert.equal(hw?.minutes, Math.floor((NOW.getTime() - Date.parse(CONFIRM_AT)) / 60000));
  assert.equal(hw?.overdue, true, `${LIMIT} 分を超えた`);

  // 答えのそろった行：次にやることが resume（段階はそのまま）。答え待ちの行と同じファイルでも待たない
  for (const [n, next] of [[RESUME_IMPLEMENT, 'implement'], [RESUME_PLAN, 'plan']] as const) {
    assert.equal(row(n).next, next, `#${n}`);
    assert.equal(row(n).stage, 'plan-ok', `#${n}`);
    assert.equal(row(n).confirmWait, undefined, `#${n}`);
    assert.equal(sel.selected.includes(n), true, `#${n} を選ぶ`);
  }
});
