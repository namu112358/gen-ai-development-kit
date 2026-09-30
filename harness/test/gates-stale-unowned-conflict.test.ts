// Issue #371：定期実行（onSchedule）で、持ち主のいない衝突した Agent PR を「人の対応待ち」の節に「引き継ぐか決める」として出す
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import type { Claim } from '../lib/queue.ts';
import { onSchedule } from '../gates/stale.ts';
import { config, ctxFor, hoursAgo, pr, type FakeGitHub } from './support/gate-fixtures.ts';
import { scheduleStackFake } from './support/stack-fixtures.ts';

const STALE_HOURS = config.routine.humanClaimStaleHours;
const SESSION = '38ab2367-aaaa-bbbb-cccc';

/** 手動の着手宣言（session 付き）。作成者は OWNER */
function manualClaim(id: number, at: string) {
  const value: Claim = { by: 'manual', at, session: SESSION, stage: 'judge' };
  return {
    id, created_at: at, updated_at: '', html_url: `c${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' },
    body: [claudeMark(SESSION), '着手しました（手動、段階 judge）。', '', renderBlock('agent-claim', value)].join('\n'),
  };
}

/** PR #5（Closes #3。GraphQL の closingIssuesReferences も #3）を一覧に持つ定期実行の偽の GitHub */
function fake(state: { mergeable: string; prComments?: unknown[]; issueComments?: unknown[] }): FakeGitHub {
  return scheduleStackFake({ pr: pr({ title: 'feat: t', html_url: 'https://x/5', mergeable_state: state.mergeable }), prComments: state.prComments ?? [] })
    .on('GET', /\/issues\/3\/comments/, () => state.issueComments ?? []);
}

async function dashboard(f: FakeGitHub): Promise<{ body: string; waiting: string; conflicts: string }> {
  await onSchedule(ctxFor(f, 'schedule', {}), new Date());
  const patch = f.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1'));
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  const body = String(patch.body.body);
  const start = body.indexOf('### 人の対応待ち');
  const mid = body.indexOf('### コンフリクトしている Agent PR');
  const end = body.indexOf('### 停滞している Agent PR');
  assert.ok(start >= 0 && mid > start && end > mid, body);
  return { body, waiting: body.slice(start, mid), conflicts: body.slice(mid, end) };
}

test('定期実行：衝突していて宣言が期限切れの Agent PR は、人の対応待ちの節に「引き継ぐか決める」の行で出る', async () => {
  const at = hoursAgo(STALE_HOURS + 1);
  const { waiting, conflicts } = await dashboard(fake({ mergeable: 'dirty', prComments: [manualClaim(301, at)] }));
  assert.ok(waiting.startsWith('### 人の対応待ち（blocked / plan-review / 引き継ぐか決める）（1）'), waiting);
  const row = waiting.split('\n').find((l) => l.includes('引き継ぐか決める：'));
  assert.ok(row, waiting);
  assert.ok(row.startsWith('- [#5](https://x/5) feat: t（Issue #3）'), row);
  assert.ok(row.includes(`宣言 session 38ab2367・${at}（期限切れ）`), row);
  assert.ok(row.includes('「#5 を引き継いで sync」'), row);
  assert.ok(conflicts.includes('[#5]'), 'コンフリクトの節にも出る');
});

test('定期実行：衝突していて宣言の無い Agent PR は「宣言なし」の行で出る', async () => {
  const { waiting } = await dashboard(fake({ mergeable: 'dirty' }));
  assert.ok(waiting.includes('（1）'), waiting);
  assert.ok(waiting.includes('- [#5](https://x/5) feat: t（Issue #3）— 引き継ぐか決める：宣言なし。引き継ぐならどのセッションにでも「#5 を引き継いで sync」と言う'), waiting);
});

test('定期実行：衝突していても PR に期限内の宣言があれば出さない（コンフリクトの節には出る）', async () => {
  const { waiting, conflicts } = await dashboard(fake({ mergeable: 'dirty', prComments: [manualClaim(302, hoursAgo(1))] }));
  assert.ok(!waiting.includes('[#5]'), waiting);
  assert.ok(waiting.includes('（0）'), waiting);
  assert.ok(conflicts.includes('[#5]'), conflicts);
});

test('定期実行：衝突していても Issue に期限内の宣言があれば出さない（PR の宣言は期限切れ）', async () => {
  const { waiting, conflicts } = await dashboard(fake({
    mergeable: 'dirty',
    prComments: [manualClaim(303, hoursAgo(STALE_HOURS + 1))],
    issueComments: [manualClaim(304, hoursAgo(1))],
  }));
  assert.ok(!waiting.includes('[#5]'), waiting);
  assert.ok(conflicts.includes('[#5]'), conflicts);
});

test('定期実行：衝突していない PR は、宣言が無くても出さない', async () => {
  const { waiting, conflicts } = await dashboard(fake({ mergeable: 'clean' }));
  assert.ok(!waiting.includes('[#5]') && !waiting.includes('引き継ぐか決める：'), waiting);
  assert.ok(!conflicts.includes('[#5]'), conflicts);
});
