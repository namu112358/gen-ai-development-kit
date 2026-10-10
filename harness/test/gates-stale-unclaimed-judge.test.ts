// Issue #493：定期実行（onSchedule）で、宣言の無い判定待ちの Agent PR を「担当のいない判定待ちの PR」の節に出す（条件の細部は unclaimed-judge.test.ts）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import type { Claim } from '../lib/queue.ts';
import { onSchedule } from '../gates/stale.ts';
import { ctxFor, HEAD, pr, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, scheduleStackFake } from './support/stack-fixtures.ts';

const NOW = new Date();
const SESSION = '38ab2367-aaaa-bbbb-cccc';
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const COMMIT_PATH = new RegExp(`/commits/${HEAD}$`);
const HEADING = '### 担当のいない判定待ちの PR（宣言なしで 60 分動きなし）';

/** 手動の judge の着手宣言（session 付き）。作成者は OWNER */
function judgeClaim(id: number, at: string) {
  const value: Claim = { by: 'manual', at, session: SESSION, stage: 'judge' };
  return {
    id, created_at: at, updated_at: '', html_url: `c${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' },
    body: [claudeMark(SESSION), '着手しました（手動、段階 judge）。', '', renderBlock('agent-claim', value)].join('\n'),
  };
}

/** PR #5 を一覧に持つ定期実行の偽の GitHub。head の commit の時刻は headAt。差分（compare の raw）は support の DIFF */
function fake(prComments: unknown[], headAt: string): FakeGitHub {
  return scheduleStackFake({ pr: pr({ title: 'feat: t', html_url: 'https://x/5' }), prComments })
    .on('GET', COMMIT_PATH, () => ({ sha: HEAD, commit: { committer: { date: headAt } } }));
}

/** ダッシュボードの本文から節を切り出す（「止まっていそうな着手宣言」の後、「停滞している Issue」の前にあることも確かめる） */
async function unclaimedSection(f: FakeGitHub): Promise<string> {
  await onSchedule(ctxFor(f, 'schedule', {}), NOW);
  const patch = f.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1'));
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  const body = String(patch.body.body);
  const prev = body.indexOf('### 止まっていそうな着手宣言');
  const start = body.indexOf(HEADING);
  const end = body.indexOf('### 停滞している Issue');
  assert.ok(prev >= 0 && start > prev && end > start, body);
  const next = body.indexOf('\n### ', start + 1);
  return body.slice(start, next > start && next < end ? next : end);
}

test('定期実行：宣言も今の差分の受け付けも無く、head の commit から 120 分動きの無い PR は、節に PR 番号・経過時間で出る', async () => {
  const section = await unclaimedSection(fake([], minutesAgo(120)));
  assert.ok(section.startsWith(`${HEADING}（1）`), section);
  assert.ok(section.includes('- [#5](https://x/5) feat: t — 宣言なし・2時間0分動きなし。引き継ぐかは人が決める'), section);
});

test('定期実行：今の差分の受け付けがある PR（判定済み）と judge の宣言がある PR は節に出ない', async () => {
  const cases: { name: string; prComments: unknown[] }[] = [
    { name: '今の patch-id の受け付けあり', prComments: [acceptanceComment()] },
    { name: 'judge の宣言あり', prComments: [judgeClaim(501, minutesAgo(120))] },
  ];
  for (const c of cases) {
    const section = await unclaimedSection(fake(c.prComments, minutesAgo(120)));
    assert.ok(section.startsWith(`${HEADING}（0）`), `${c.name}: ${section}`);
    assert.ok(section.includes('なし') && !section.includes('[#5]'), `${c.name}: ${section}`);
  }
});
