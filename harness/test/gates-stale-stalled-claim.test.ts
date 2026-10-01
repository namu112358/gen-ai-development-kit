// Issue #391：定期実行（onSchedule）で、judge・fix・sync の宣言のまま設定の時間動きの無い Agent PR を「止まっていそうな着手宣言」の節に出す
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import type { Claim, ClaimStage } from '../lib/queue.ts';
import type { HarnessConfig } from '../lib/config.ts';
import { onSchedule } from '../gates/stale.ts';
import { config, ctxFor, HEAD, pr, verdictComment, type FakeGitHub } from './support/gate-fixtures.ts';
import { scheduleStackFake } from './support/stack-fixtures.ts';

const NOW = new Date();
const SESSION = '38ab2367-aaaa-bbbb-cccc';
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const COMMIT_PATH = new RegExp(`/commits/${HEAD}$`);

/** 手動の着手宣言（session 付き）。作成者は OWNER */
function manualClaim(id: number, at: string, stage: ClaimStage = 'judge') {
  const value: Claim = { by: 'manual', at, session: SESSION, stage };
  return {
    id, created_at: at, updated_at: '', html_url: `c${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' },
    body: [claudeMark(SESSION), `着手しました（手動、段階 ${stage}）。`, '', renderBlock('agent-claim', value)].join('\n'),
  };
}

/** PR #5 を一覧に持つ定期実行の偽の GitHub。head の commit の時刻は headAt（'fail' なら API が失敗する） */
function fake(state: { prComments: unknown[]; headAt: string | 'fail' }): FakeGitHub {
  return scheduleStackFake({ pr: pr({ title: 'feat: t', html_url: 'https://x/5' }), prComments: state.prComments })
    .on('GET', COMMIT_PATH, () => {
      if (state.headAt === 'fail') throw new Error('500 commits');
      return { sha: HEAD, commit: { committer: { date: state.headAt } } };
    });
}

/** 節の見出しと本文（「停滞している Agent PR」の次、「停滞している Issue」の前） */
async function stalledSection(f: FakeGitHub, cfg: HarnessConfig = config): Promise<string> {
  await onSchedule(ctxFor(f, 'schedule', {}, { config: cfg }), NOW);
  const patch = f.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1'));
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  const body = String(patch.body.body);
  const prev = body.indexOf('### 停滞している Agent PR');
  const start = body.indexOf('### 止まっていそうな着手宣言');
  const end = body.indexOf('### 停滞している Issue');
  assert.ok(prev >= 0 && start > prev && end > start, body);
  return body.slice(start, end);
}

const withMinutes = (minutes: number | undefined): HarnessConfig => {
  const cfg = structuredClone(config);
  const routine = cfg.routine as HarnessConfig['routine'] & { stalledClaimMinutes?: number };
  if (minutes === undefined) delete routine.stalledClaimMinutes;
  else routine.stalledClaimMinutes = minutes;
  return cfg;
};

test('定期実行：judge の宣言のまま 60 分を過ぎて動きの無い PR は、節に PR 番号・段階・短い ID・経過時間で出る', async () => {
  const at = minutesAgo(120);
  const section = await stalledSection(fake({ prComments: [manualClaim(401, at)], headAt: minutesAgo(180) }));
  assert.ok(section.startsWith('### 止まっていそうな着手宣言（judge・fix・sync で 60 分動きなし）（1）'), section);
  assert.ok(section.includes(`- [#5](https://x/5) feat: t — 段階 judge・session 38ab2367・2時間0分動きなし（宣言 ${at}）。引き継ぐかは人が決める`), section);
});

test('定期実行：出ない場合（判定コメントが後にある・head の commit が新しい・plan の段階・時間の前）は節が「なし」', async () => {
  const cases: { name: string; prComments: unknown[]; headAt: string }[] = [
    { name: '宣言の後に判定コメント', prComments: [manualClaim(402, minutesAgo(120)), verdictComment()], headAt: minutesAgo(180) },
    { name: 'head の commit が新しい', prComments: [manualClaim(403, minutesAgo(120))], headAt: minutesAgo(10) },
    { name: 'plan の段階', prComments: [manualClaim(404, minutesAgo(120), 'plan')], headAt: minutesAgo(180) },
    { name: '宣言が時間の前', prComments: [manualClaim(405, minutesAgo(30))], headAt: minutesAgo(180) },
  ];
  for (const c of cases) {
    const f = fake({ prComments: c.prComments, headAt: c.headAt });
    const section = await stalledSection(f);
    assert.ok(section.startsWith('### 止まっていそうな着手宣言（judge・fix・sync で 60 分動きなし）（0）'), `${c.name}: ${section}`);
    assert.ok(section.includes('なし') && !section.includes('[#5]'), `${c.name}: ${section}`);
  }
});

test('定期実行：plan の段階の宣言では head の commit を読まない', async () => {
  const f = fake({ prComments: [manualClaim(406, minutesAgo(120), 'plan')], headAt: minutesAgo(180) });
  await stalledSection(f);
  assert.equal(f.calls.filter((c) => c.method === 'GET' && COMMIT_PATH.test(c.path)).length, 0);
});

test('定期実行：head の commit を読めない（API の失敗）PR は出ず、ダッシュボードは更新される', async () => {
  const f = fake({ prComments: [manualClaim(407, minutesAgo(120))], headAt: 'fail' });
  const section = await stalledSection(f);
  assert.ok(section.includes('（0）') && !section.includes('[#5]'), section);
  assert.ok(f.calls.some((c) => c.method === 'GET' && COMMIT_PATH.test(c.path)), 'commit を読もうとしていません');
});

test('定期実行：stalledClaimMinutes を変えると見出しと判定に効く', async () => {
  const section = await stalledSection(fake({ prComments: [manualClaim(408, minutesAgo(20))], headAt: minutesAgo(30) }), withMinutes(15));
  assert.ok(section.startsWith('### 止まっていそうな着手宣言（judge・fix・sync で 15 分動きなし）（1）'), section);
  assert.ok(section.includes('[#5]'), section);
});

test('定期実行：設定に stalledClaimMinutes が無ければ 60 分で動く（59 分は出ない・61 分は出る）', async () => {
  for (const [minutes, want] of [[59, 0], [61, 1]] as const) {
    const section = await stalledSection(fake({ prComments: [manualClaim(409, minutesAgo(minutes))], headAt: minutesAgo(180) }), withMinutes(undefined));
    assert.ok(section.startsWith(`### 止まっていそうな着手宣言（judge・fix・sync で 60 分動きなし）（${want}）`), `${minutes}: ${section}`);
  }
});
