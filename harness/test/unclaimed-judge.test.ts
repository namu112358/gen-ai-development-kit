// Issue #493：宣言の無い判定待ちの Agent PR で、設定の時間（既定 60 分）動きの無いものを選び、ダッシュボードの行にする（lib/unclaimed-judge.ts）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Claim } from '../lib/queue.ts';
import {
  lastActivity,
  renderUnclaimedJudgeLine,
  unclaimedJudgeCandidate,
  unclaimedJudgePrs,
  type UnclaimedJudgeInput,
} from '../lib/unclaimed-judge.ts';

const NOW = new Date('2026-09-30T12:00:00Z');
const MIN = 60;
const ago = (minutes: number, seconds = 0) => new Date(NOW.getTime() - minutes * 60_000 - seconds * 1000).toISOString();
const PR = { number: 367, title: 'feat: t', html_url: 'https://x/367' };
const JUDGE_CLAIM: Claim = { by: 'manual', at: ago(120), session: '38ab2367-aaaa-bbbb-cccc', stage: 'judge' };

/** 既定は「宣言なし・受け付けなし・ラベルなし・衝突なし・head の commit 61 分前・Claude のコメントなし」（出る） */
const input = (patch: Partial<UnclaimedJudgeInput> = {}): UnclaimedJudgeInput => ({
  pr: PR, claim: null, labels: [], conflicted: false, headCommitAt: ago(61), lastClaudeAt: null, accepted: false, ...patch,
});

test('出る・出ないの条件（宣言・受け付け・時間・ラベル・衝突・Claude のコメント・commit の時刻）', () => {
  const cases: { name: string; input: UnclaimedJudgeInput; want: boolean }[] = [
    { name: '宣言なし・受け付けなし・61 分', input: input(), want: true },
    { name: 'ちょうど 60 分', input: input({ headCommitAt: ago(60) }), want: true },
    { name: '59 分', input: input({ headCommitAt: ago(59) }), want: false },
    { name: '宣言あり（judge）', input: input({ claim: JUDGE_CLAIM }), want: false },
    { name: '受け付けあり（判定済み）', input: input({ accepted: true }), want: false },
    { name: '受け付けを読んでいない（null）', input: input({ accepted: null }), want: false },
    { name: 'agent:hold', input: input({ labels: ['agent:hold'] }), want: false },
    { name: 'agent:blocked', input: input({ labels: ['agent:blocked'] }), want: false },
    { name: '衝突', input: input({ conflicted: true }), want: false },
    { name: 'commit は古いが Claude のコメント（解除・判定）が新しい', input: input({ headCommitAt: ago(180), lastClaudeAt: ago(10) }), want: false },
    { name: 'commit も Claude のコメントも古い', input: input({ headCommitAt: ago(180), lastClaudeAt: ago(90) }), want: true },
    { name: 'Claude のコメントの時刻が不正なら commit の時刻だけを使う', input: input({ lastClaudeAt: 'not-a-date' }), want: true },
    { name: 'commit の時刻が null', input: input({ headCommitAt: null }), want: false },
    { name: 'commit の時刻が不正', input: input({ headCommitAt: 'not-a-date', lastClaudeAt: ago(90) }), want: false },
  ];
  for (const c of cases) {
    const rows = unclaimedJudgePrs([c.input], NOW, MIN);
    assert.equal(rows.length, c.want ? 1 : 0, c.name);
    if (c.want) assert.equal(rows[0]!.pr, PR, c.name);
    // 受け付けを読む前の候補の判断は accepted に依らない
    if (c.input.accepted === false) assert.equal(unclaimedJudgeCandidate({ ...c.input, accepted: null }, NOW, MIN), c.want, `${c.name}（候補）`);
  }
  // last は commit と Claude のコメントの新しいほう
  assert.equal(new Date(lastActivity(ago(180), ago(90))!).getTime(), new Date(ago(90)).getTime());
  assert.equal(lastActivity(null, ago(90)), null);
  const rows = unclaimedJudgePrs([input({ headCommitAt: ago(180), lastClaudeAt: ago(90) })], NOW, MIN);
  assert.equal(new Date(rows[0]!.last).getTime(), new Date(ago(90)).getTime());
});

test('行の書き方：番号・リンク・題・経過時間（1時間未満は「59分」、以上は「4時間12分」、分は切り捨て）', () => {
  const cases: { last: string; want: string }[] = [
    { last: ago(4 * 60 + 12, 30), want: '- [#367](https://x/367) feat: t — 宣言なし・4時間12分動きなし。引き継ぐかは人が決める' },
    { last: ago(59, 59), want: '- [#367](https://x/367) feat: t — 宣言なし・59分動きなし。引き継ぐかは人が決める' },
  ];
  for (const { last, want } of cases) assert.equal(renderUnclaimedJudgeLine({ pr: PR, last }, NOW), want, last);
});
