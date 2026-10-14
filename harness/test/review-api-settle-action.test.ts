// review-api のレビューの段階（review-api/src/pipeline.ts の runReview）が、settle で待つかを PR のイベントの action で決めること：
// 既定（trigger.settleActions を省く）では synchronize だけ trigger.settleSeconds 秒 deps.sleep で待ち、opened・reopened・converted_to_draft は待たずに始め、
// params に action が無ければ今どおり待つこと、設定の settleActions で待つ action を変えられること（[] ならどれも待たない）、
// 待たなかったときも fetch-pr で head が違えば superseded になること（shouldSettle の単体もあわせて）、
// 設定（review.config.json・loadReviewConfig）の trigger.settleActions が ["synchronize"] で、鍵が無ければ既定の ["synchronize"]、[] は通り、
// 文字列の配列でないものは鍵のパスつきの誤りになることを確かめる（Issue #1067）。superseded の記録の鍵は review-api-settle.test.ts が見る
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MessagesClient } from '../../review-api/src/claude.ts';
import { loadReviewConfig, type ReviewConfig } from '../../review-api/src/config.ts';
import { runReview, shouldSettle } from '../../review-api/src/pipeline.ts';
import { answer, baseConfig, fakeGitHub, HEAD, NOW, OTHER, params, REVIEW_KEY, REVIEW_OK, RISK_OK } from './support/review-api-pipeline.ts';

const SETTLE = 30;

// settleSeconds を 30 にし、settleActions を渡せば置く（undefined なら鍵を置かない）
const configWith = (settleActions: string[] | undefined): ReviewConfig => {
  const c = baseConfig();
  return { ...c, trigger: { ...c.trigger, settleSeconds: SETTLE, ...(settleActions === undefined ? {} : { settleActions }) } };
};

// sleep を記録する deps で runReview を1回回す。prHead は fetch-pr が返す PR の head
async function runWith(opts: { action: string | undefined; settleActions?: string[]; prHead?: string }) {
  const { gh, posted } = fakeGitHub({ pr: { state: 'open', head: opts.prHead ?? HEAD }, comments: [] });
  const responses = [answer(REVIEW_OK), answer(RISK_OK)];
  let claudeCount = 0;
  const claude: MessagesClient = {
    async create() {
      const r = responses[claudeCount++];
      if (r === undefined) throw new Error('偽の Claude の応答が足りない');
      return r;
    },
  };
  const sleeps: number[] = [];
  const kv = new Map<string, string>();
  const result = await runReview(
    {
      github: { reader: async () => gh, writer: async () => gh },
      claude,
      kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
      now: () => NOW,
      log: () => {},
      sleep: async (ms) => void sleeps.push(ms),
    },
    { ...params(configWith(opts.settleActions)), ...(opts.action === undefined ? {} : { action: opts.action }) },
  );
  const raw = kv.get(REVIEW_KEY);
  return { result, sleeps, posted, claudeCount, record: raw === undefined ? null : (JSON.parse(raw) as { outcome: string }) };
}

test('action と settleActions の組み合わせで、待つ（sleep が settleSeconds*1000 で1回）か待たないかが決まり、どちらも投稿まで進む', async () => {
  const waits = [SETTLE * 1000];
  const cases: [string | undefined, string[] | undefined, number[]][] = [
    // settleActions を省く（既定 ["synchronize"]）
    ['opened', undefined, []],
    ['reopened', undefined, []],
    ['converted_to_draft', undefined, []],
    ['synchronize', undefined, waits],
    [undefined, undefined, waits],
    // 設定で待つ action を変える
    ['opened', ['opened', 'synchronize'], waits],
    ['reopened', ['opened', 'synchronize'], []],
    ['synchronize', ['opened', 'synchronize'], waits],
    // [] ならどの action も待たない。action が無ければ待つ
    ['synchronize', [], []],
    ['opened', [], []],
    [undefined, [], waits],
  ];
  for (const [action, settleActions, expected] of cases) {
    const name = `action=${action ?? '(無し)'} settleActions=${settleActions === undefined ? '(省略)' : JSON.stringify(settleActions)}`;
    const r = await runWith({ action, settleActions });
    assert.deepEqual(r.sleeps, expected, `${name}: sleep`);
    assert.equal(r.result.outcome, 'posted', name);
    assert.equal(r.claudeCount, 2, `${name}: review と risk`);
    assert.equal(r.posted.length, 1, `${name}: 投稿`);
  }
});

test('opened で待たなかったときも fetch-pr で PR を取り直し、head が違えば Claude を呼ばず投稿せずに superseded', async () => {
  const r = await runWith({ action: 'opened', prHead: OTHER });
  assert.deepEqual(r.sleeps, [], '待たない');
  assert.equal(r.result.outcome, 'superseded');
  assert.equal(r.claudeCount, 0);
  assert.equal(r.posted.length, 0);
  assert.equal(r.record?.outcome, 'superseded');
});

test('shouldSettle は action が無ければ真、あれば settleActions（省略なら ["synchronize"]）に含まれるときだけ真', () => {
  const cases: [string[] | undefined, string | undefined, boolean][] = [
    [undefined, undefined, true],
    [undefined, 'synchronize', true],
    [undefined, 'opened', false],
    [['opened'], 'opened', true],
    [['opened'], 'synchronize', false],
    [[], 'synchronize', false],
    [[], undefined, true],
  ];
  for (const [settleActions, action, expected] of cases) {
    const trigger = settleActions === undefined ? {} : { settleActions };
    assert.equal(shouldSettle(trigger, action), expected, `${JSON.stringify(settleActions)} ${action}`);
  }
});

const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
const readRaw = (): Record<string, any> => JSON.parse(readFileSync(configPath, 'utf8'));

// message に鍵のパスが入る Error かを見る検証関数（文言全体は固定しない）
const errorWith = (path: string) => (error: unknown) => {
  assert.ok(error instanceof Error, 'Error を投げる');
  assert.ok(error.message.includes(path), `message に ${path} がない: ${error.message}`);
  return true;
};

test('review.config.json の trigger.settleActions は ["synchronize"]、鍵が無ければ既定の ["synchronize"]、[] も通る', () => {
  assert.deepEqual(loadReviewConfig(readRaw()).trigger.settleActions, ['synchronize']);
  const missing = readRaw();
  delete missing.trigger.settleActions;
  assert.deepEqual(loadReviewConfig(missing).trigger.settleActions, ['synchronize']);
  const empty = readRaw();
  empty.trigger.settleActions = [];
  assert.deepEqual(loadReviewConfig(empty).trigger.settleActions, []);
});

test('trigger.settleActions の数・文字列・数を含む配列・空文字を含む配列は trigger.settleActions を含む誤りになる', () => {
  const cases: [string, unknown][] = [
    ['数', 1],
    ['文字列', 'synchronize'],
    ['数を含む配列', ['synchronize', 1]],
    ['空文字を含む配列', ['synchronize', '']],
  ];
  for (const [name, value] of cases) {
    const raw = readRaw();
    raw.trigger.settleActions = value;
    assert.throws(() => loadReviewConfig(raw), errorWith('trigger.settleActions'), name);
  }
});
