// queue の公開（publishQueue）が schedule・workflow_dispatch のときだけ走ること（publishesQueueOn・run.ts の呼び出し・gate.yml の cron）のテスト
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const runTs = readFileSync(join(root, 'harness', 'gates', 'run.ts'), 'utf8');
const yml = readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8');

/** publish-queue.ts の publishesQueueOn（まだ無いときも、ほかのテストが読み込みで巻き添えにならないよう動的に読む） */
async function loadPublishesQueueOn(): Promise<(eventName: string) => boolean> {
  const mod = (await import('../gates/publish-queue.ts')) as Record<string, unknown>;
  const fn = mod['publishesQueueOn'];
  assert.equal(typeof fn, 'function', 'publish-queue.ts が publishesQueueOn を export していません');
  return fn as (eventName: string) => boolean;
}

/** open の位置の `{` に対応する `}` の位置（文字列・コメントは考えない簡易版） */
function matchingBrace(src: string, open: number): number {
  assert.equal(src[open], '{');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

for (const eventName of ['schedule', 'workflow_dispatch']) {
  test(`publishesQueueOn：${eventName} では queue を公開する`, async () => {
    const publishesQueueOn = await loadPublishesQueueOn();
    assert.equal(publishesQueueOn(eventName), true);
  });
}

for (const eventName of ['issue_comment', 'issues', 'pull_request_target', 'push']) {
  test(`publishesQueueOn：${eventName} では queue を公開しない`, async () => {
    const publishesQueueOn = await loadPublishesQueueOn();
    assert.equal(publishesQueueOn(eventName), false);
  });
}

test('publishesQueueOn：未知のイベント・空文字では公開しない', async () => {
  const publishesQueueOn = await loadPublishesQueueOn();
  assert.equal(publishesQueueOn('unknown_event'), false);
  assert.equal(publishesQueueOn(''), false);
});

test('run.ts：publishQueue の呼び出しは1か所だけ', () => {
  const calls = runTs.match(/\bpublishQueue\s*\(/g) ?? [];
  assert.equal(calls.length, 1, `publishQueue( の呼び出しが ${calls.length} か所あります`);
});

test('run.ts：publishQueue の呼び出しは if (publishesQueueOn(ctx.eventName)) { … } の中にある', () => {
  const m = /if\s*\(\s*publishesQueueOn\(\s*ctx\.eventName\s*\)\s*\)\s*\{/.exec(runTs);
  assert.ok(m, 'run.ts に `if (publishesQueueOn(ctx.eventName)) {` がありません');
  const open = m.index + m[0].length - 1;
  const close = matchingBrace(runTs, open);
  assert.ok(close > open, 'if (publishesQueueOn(...)) の `{` に対応する `}` が見つかりません');
  const call = /\bpublishQueue\s*\(\s*ctx\s*\)/.exec(runTs);
  assert.ok(call, 'run.ts に publishQueue(ctx) の呼び出しがありません');
  assert.ok(call.index > open && call.index < close, 'publishQueue(ctx) が if (publishesQueueOn(ctx.eventName)) の中にありません');
});

test('run.ts：publishesQueueOn を publish-queue.ts から import している', () => {
  assert.match(runTs, /import\s*\{[^}]*\bpublishesQueueOn\b[^}]*\}\s*from\s*['"]\.\/publish-queue\.ts['"]/);
});

test('gate.yml：schedule の cron は1時間ごと（17 * * * *）', () => {
  const m = yml.match(/schedule:\s*\n\s+-\s*cron:\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'gate.yml の schedule の cron が読めません');
  assert.equal(m[1], '17 * * * *');
  const crons = [...yml.matchAll(/-\s*cron:\s*['"]([^'"]+)['"]/g)].map((c) => c[1]);
  assert.deepEqual(crons, ['17 * * * *'], `cron が1つだけではありません: ${crons.join(', ')}`);
});
