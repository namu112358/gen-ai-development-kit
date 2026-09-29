import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../lib/blocks.ts';
import { onComment } from '../gates/on-comment.ts';
import { HEAD, acceptanceFake, ctxFor, pr, verdict, verdictEvent } from './support/gate-fixtures.ts';

/**
 * 判定した head と今の PR の head が違っても、PR 自身の差分（compare の base...head の patch-id）が同じなら App が受け付ける。
 * gates-verdict.test.ts の「差分が変わった後の判定は受け付けない」と対。App の受け付け条件をテストで固定する。
 */

const CURRENT = 'c'.repeat(40);
const drifted = () => pr({ head: { ref: 'claude/issue-3', sha: CURRENT, repo: { full_name: 'o/r' } } });

test('判定の headSha が今の head と違っても、compare の diff（patch-id）が同じなら受け付ける', async () => {
  const fake = acceptanceFake({ pr: drifted(), dashboardLabels: [] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict({ headSha: HEAD })))));
  const w = fake.writes();
  assert.ok(w.includes('comment:acceptance'), JSON.stringify(w));
  assert.ok(!w.includes('comment:verdict-rejected'));
  const compared = fake.calls.filter((c) => c.method === 'GET' && c.path.includes('/compare/')).map((c) => c.path);
  assert.ok(compared.some((p) => p.endsWith(`...${HEAD}`)), '判定した head の差分を取って比べる');
  assert.ok(compared.some((p) => p.endsWith(`...${CURRENT}`)), '今の head の差分を取って比べる');
});

test('判定の headSha が今の head と違い、判定した head の差分が取れなければ受け付けない', async () => {
  const fake = acceptanceFake({ pr: drifted(), dashboardLabels: [] })
    .on('GET', /\/compare\/main\.\.\.a+$/, (_m, _b, o) => {
      if (o.raw) throw new Error('404');
      return { behind_by: 0 };
    });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict({ headSha: HEAD })))));
  assert.deepEqual(fake.writes(), ['comment:verdict-rejected']);
});
