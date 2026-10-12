// review-api の手元の確かめ用の送り手（review-api/scripts/send-webhook.ts）が組む Webhook の署名を、
// 受け口の verifySignature（review-api/src/webhook.ts）が受け入れ、送り先に接続できないと理由を出して 0 以外で終わることを、
// 外部のネットワークを呼ばずに確かめる（Issue #920）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildWebhookRequest } from '../../review-api/scripts/send-webhook.ts';
import { verifySignature } from '../../review-api/src/webhook.ts';

const SCRIPT = fileURLToPath(new URL('../../review-api/scripts/send-webhook.ts', import.meta.url));
const SECRET = 'test-secret-for-send-webhook-920';

// 開いてすぐ閉じたポート（接続できない送り先）
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('ポートが取れない'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

test('buildWebhookRequest の署名を verifySignature が同じ秘密で受け入れ、違う秘密では受け入れない。本文と event は入力どおり', async () => {
  const { body, headers } = buildWebhookRequest({
    action: 'opened',
    fullName: 'owner/repo',
    pr: 12,
    headSha: 'abc123',
    ref: 'claude/issue-12-x',
    closes: 34,
    secret: SECRET,
  });
  const signature = headers['x-hub-signature-256'] ?? null;
  assert.equal(await verifySignature(SECRET, body, signature), true);
  assert.equal(await verifySignature(SECRET + 'x', body, signature), false);
  assert.equal(headers['x-github-event'], 'pull_request');

  const event = JSON.parse(body);
  assert.equal(event.action, 'opened');
  assert.equal(event.repository.full_name, 'owner/repo');
  assert.equal(event.pull_request.number, 12);
  assert.equal(event.pull_request.head.sha, 'abc123');
  assert.equal(event.pull_request.body, 'Closes #34');
});

test('送り先に接続できないと、送り先の URL と「送れませんでした」を標準エラーに出して 0 以外で終わり、秘密を出さない', async () => {
  // 手元に review-api/.dev.vars があるとその秘密が先に使われ、GITHUB_INSTALLATION_ID が残っていても、この確かめはどれも成り立つ
  const url = `http://127.0.0.1:${await closedPort()}/webhook`;
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_WEBHOOK_SECRET: SECRET };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [SCRIPT, 'opened', 'owner/repo', '1', 'abc', '--url', url], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.notEqual(r.status, null, `時間切れか signal で終わった：${r.signal}`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(r.stderr, /送れませんでした/);
  assert.equal(r.stdout.includes(SECRET), false);
  assert.equal(r.stderr.includes(SECRET), false);
});
