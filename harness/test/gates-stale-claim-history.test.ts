// Issue #655：停滞の判定は updated_at に加えて宣言の history の最新の時刻を動きに数える（書き換えは updated_at を進めないことがある）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onSchedule } from '../gates/stale.ts';
import { ctxFor, pr } from './support/gate-fixtures.ts';
import { scheduleStackFake } from './support/stack-fixtures.ts';
import { CLAIM_SESSION, claimComment } from './support/claim-fixtures.ts';

const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/** PR #5（updated_at は staleHours より古い）に history の宣言を置いたときの「停滞している Agent PR」の節 */
async function stalePrSection(lastAt: string): Promise<string> {
  const created = minutesAgo(72 * 60);
  const value = { by: 'manual' as const, session: CLAIM_SESSION, at: lastAt, stage: 'implement' as const, history: [{ stage: 'plan' as const, at: created }, { stage: 'implement' as const, at: lastAt, after: 400 }] };
  const f = scheduleStackFake({ pr: pr({ title: 'feat: t', html_url: 'https://x/5' }), prComments: [claimComment(400, value, created)] });
  await onSchedule(ctxFor(f, 'schedule', {}), NOW);
  const patch = f.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1'));
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  const body = String(patch.body.body);
  const start = body.indexOf('### 停滞している Agent PR');
  const end = body.indexOf('### 止まっていそうな着手宣言');
  assert.ok(start >= 0 && end > start, body);
  return body.slice(start, end);
}

test('定期実行：history の最後の段階が staleHours 以内なら、updated_at が古くても停滞している Agent PR に出ない（古ければ出る）', async () => {
  assert.ok(!(await stalePrSection(minutesAgo(5))).includes('[#5]'));
  assert.ok((await stalePrSection(minutesAgo(48 * 60))).includes('[#5]'));
});
