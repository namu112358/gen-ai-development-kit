// Issue #391：judge・fix・sync の着手宣言のまま、設定の時間（既定 60 分）動きの無い PR を選び、ダッシュボードの行にする（lib/stalled-claim.ts）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Claim, ClaimStage } from '../lib/queue.ts';
import {
  DEFAULT_STALLED_CLAIM_MINUTES,
  renderStalledClaimLine,
  stalledCandidate,
  stalledClaimMinutes,
  stalledClaims,
  type StalledClaimInput,
} from '../lib/stalled-claim.ts';

const NOW = new Date('2026-09-30T12:00:00Z');
const MIN = 60;
const SESSION = '38ab2367-aaaa-bbbb-cccc';
const ago = (minutes: number, seconds = 0) => new Date(NOW.getTime() - minutes * 60_000 - seconds * 1000).toISOString();
const PR = { number: 383, title: 'feat: t', html_url: 'https://x/383' };

function claim(patch: Partial<Claim> & { stage?: ClaimStage } = {}): Claim {
  return { by: 'manual', at: ago(120), session: SESSION, stage: 'judge', ...patch } as Claim;
}

const input = (c: Claim | null, headCommitAt: string | null = ago(180), pr = PR): StalledClaimInput => ({ pr, claim: c, headCommitAt });

test('stalledClaimMinutes：設定に無ければ 60、あればその値', () => {
  assert.equal(DEFAULT_STALLED_CLAIM_MINUTES, 60);
  assert.equal(stalledClaimMinutes({}), 60);
  assert.equal(stalledClaimMinutes({ stalledClaimMinutes: 15 }), 15);
});

test('judge・fix・sync の宣言で、宣言も head の commit も時間を過ぎていれば出る（last は新しいほう）', () => {
  for (const stage of ['judge', 'fix', 'sync'] as const) {
    const c = claim({ stage });
    assert.equal(stalledCandidate(c, NOW, MIN), true, stage);
    const rows = stalledClaims([input(c, ago(180))], NOW, MIN);
    assert.equal(rows.length, 1, stage);
    assert.equal(rows[0]!.pr, PR);
    assert.equal(rows[0]!.claim, c);
    assert.equal(new Date(rows[0]!.last).getTime(), new Date(ago(120)).getTime(), `${stage}：宣言のほうが新しい`);
  }
  // head の commit のほうが新しければ last はそちら
  const rows = stalledClaims([input(claim({ at: ago(180) }), ago(90))], NOW, MIN);
  assert.equal(new Date(rows[0]!.last).getTime(), new Date(ago(90)).getTime());
});

test('境目：最後の動きから 59 分は出ず、60 分は出る（宣言の時刻・head の commit の時刻のどちらでも）', () => {
  const cases: { name: string; at: string; head: string; want: number }[] = [
    { name: '宣言 59 分', at: ago(59), head: ago(180), want: 0 },
    { name: '宣言 60 分', at: ago(60), head: ago(180), want: 1 },
    { name: 'commit 59 分', at: ago(180), head: ago(59), want: 0 },
    { name: 'commit 60 分', at: ago(180), head: ago(60), want: 1 },
  ];
  for (const c of cases) assert.equal(stalledClaims([input(claim({ at: c.at }), c.head)], NOW, MIN).length, c.want, c.name);
  assert.equal(stalledCandidate(claim({ at: ago(59) }), NOW, MIN), false);
  assert.equal(stalledCandidate(claim({ at: ago(60) }), NOW, MIN), true);
});

test('plan・plan-critique・plan-gate・implement・段階なしの宣言は出ない', () => {
  for (const stage of ['plan', 'plan-critique', 'plan-gate', 'implement', undefined] as const) {
    const c = claim({ stage });
    if (stage === undefined) delete (c as { stage?: ClaimStage }).stage;
    assert.equal(stalledCandidate(c, NOW, MIN), false, String(stage));
    assert.deepEqual(stalledClaims([input(c)], NOW, MIN), [], String(stage));
  }
});

test('宣言なし（null）・解除済み・時刻の読めない宣言は出ない', () => {
  const cases: [string, Claim | null][] = [
    ['null', null],
    ['解除済み', claim({ released: true })],
    ['時刻が不正', claim({ at: 'not-a-date' })],
  ];
  for (const [name, c] of cases) {
    assert.equal(stalledCandidate(c, NOW, MIN), false, name);
    assert.deepEqual(stalledClaims([input(c)], NOW, MIN), [], name);
  }
});

test('head の commit の時刻が読めない（null・不正な日付）なら出ない', () => {
  for (const head of [null, 'not-a-date']) assert.deepEqual(stalledClaims([input(claim(), head)], NOW, MIN), [], String(head));
});

test('minutes を変えると効き、出るものは入力の順のまま返す', () => {
  const a = input(claim({ at: ago(20) }), ago(30), { number: 2, title: 'a', html_url: 'u2' });
  const b = input(claim({ at: ago(40) }), ago(50), { number: 1, title: 'b', html_url: 'u1' });
  assert.deepEqual(stalledClaims([a, b], NOW, 60), []);
  assert.deepEqual(stalledClaims([a, b], NOW, 15).map((r) => r.pr.number), [2, 1]);
});

test('行の書き方：session あり・なし、1時間未満は「59分」、以上は「4時間12分」（分は切り捨て）', () => {
  const at = '2026-09-30T07:33:00Z';
  const cases: { name: string; c: Claim; last: string; want: string }[] = [
    {
      name: 'session あり・4時間12分（30 秒は切り捨て）',
      c: claim({ at }),
      last: ago(4 * 60 + 12, 30),
      want: `- [#383](https://x/383) feat: t — 段階 judge・session 38ab2367・4時間12分動きなし（宣言 ${at}）。引き継ぐかは人が決める`,
    },
    {
      name: 'session なし・59分（59 秒は切り捨て）',
      c: { by: 'manual', at, stage: 'fix' },
      last: ago(59, 59),
      want: `- [#383](https://x/383) feat: t — 段階 fix・59分動きなし（宣言 ${at}）。引き継ぐかは人が決める`,
    },
    {
      name: 'Routine の session は短い ID',
      c: { by: 'routine', session: 'https://claude.ai/code/session_01ABCDEFGHxyz', at, stage: 'sync' },
      last: ago(61),
      want: `- [#383](https://x/383) feat: t — 段階 sync・session 01ABCDEF・1時間1分動きなし（宣言 ${at}）。引き継ぐかは人が決める`,
    },
  ];
  for (const { name, c, last, want } of cases) assert.equal(renderStalledClaimLine({ pr: PR, claim: c, last }, NOW), want, name);
});
