// agent.ts api-review（harness/scripts/agent/commands/api-review.ts の apiReview）を偽の GitHub と差し替えた時計で確かめる（Issue #1042）。
// 設定（reviewSource）が無い・mode local なら GitHub を一度も読まずに disabled、記録が無いまま waitMinutes を過ぎたら timeout（0 なら読み直さない）、
// review-api の posted の記録があれば Reviewer・Risk のファイルを書き、そのファイルを composeVerdict に渡すとサブエージェントを呼ばずに判定コメントが組めることを見る
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { renderShadowComment } from '../../review-api/src/record.ts';
import { composeShadowVerdict, type RiskOutput } from '../../review-api/src/verdict.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { GitHub, IssueComment } from '../lib/github.ts';
import { composeVerdict, renderJudgeInput } from '../lib/session-inputs.ts';
import { RISK_QUESTIONS } from '../lib/verdict.ts';
import { config } from './support/gate-fixtures.ts';

/** commands/api-review.ts は cli.ts を通して harness.config.json を読むので、使うときだけ読み込む */
const loadCommand = () => import('../scripts/agent/commands/api-review.ts');

const PR = 5;
const HEAD = 'a'.repeat(40);
const APP = 'review-api[bot]';
const MODELS = { review: 'claude-opus-5-5', risk: 'claude-sonnet-5-5' };
const RISK: RiskOutput = {
  level: 'low',
  answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as RiskOutput['answers'],
  rationale: 'docs のみ',
  facts: { references: 'none', tests: 'none', fileKinds: 'docs' },
};

const withSource = (reviewSource: unknown): HarnessConfig => ({ ...config, reviewSource } as unknown as HarnessConfig);
const withoutSource = (): HarnessConfig => {
  const { reviewSource: _drop, ...rest } = config as HarnessConfig & { reviewSource?: unknown };
  return rest as HarnessConfig;
};

/** judge-input のファイル（PR は open、前回の判定なし） */
function judgeInputFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'api-review-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'judge-input.txt');
  writeFileSync(file, renderJudgeInput(config, { pr: { number: PR, headSha: HEAD, body: '' }, issues: [], prComments: [], checkRuns: [], prState: { state: 'open', draft: true } }));
  return file;
}

const postedComment = (): IssueComment => ({
  id: 7,
  body: renderShadowComment({
    version: 1, pr: PR, headSha: HEAD,
    verdict: composeShadowVerdict({ pr: PR, headSha: HEAD, reviewer: { pass: true, blocking: [], nonBlocking: ['命名'] }, risk: RISK, model: MODELS.review }),
    models: MODELS, usage: {}, usd: null, durationSec: 1,
  }),
  html_url: 'https://example.test/c7',
  created_at: '2026-10-13T00:00:00Z',
  updated_at: '',
  author_association: 'NONE',
  user: { login: APP, type: 'Bot' },
});

/** get('/pulls/5') と listComments(5) だけに答える偽の GitHub。呼び出しを数え、ほかのメソッドは呼ばれたら投げる */
function fakeGh(comments: () => IssueComment[]): { gh: GitHub; calls: string[] } {
  const calls: string[] = [];
  const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async get(path) {
      calls.push(`get ${String(path)}`);
      assert.equal(path, `/pulls/${PR}`);
      return { number: PR, state: 'open', draft: true, head: { ref: 'claude/issue-1-x', sha: HEAD }, base: { ref: 'main', sha: 'c'.repeat(40) } };
    },
    async listComments(n) {
      calls.push(`listComments ${String(n)}`);
      assert.equal(n, PR);
      return comments();
    },
  };
  const gh = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (prop === 'then') return undefined;
      throw new Error(`偽の GitHub：想定外の呼び出し ${String(prop)}`);
    },
  }) as unknown as GitHub;
  return { gh, calls };
}

/** どのメソッドに触れても数えて投げる偽の GitHub */
function untouchableGh(): { gh: GitHub; touched: string[] } {
  const touched: string[] = [];
  const gh = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      touched.push(String(prop));
      throw new Error(`GitHub を読んだ：${String(prop)}`);
    },
  }) as unknown as GitHub;
  return { gh, touched };
}

/** 差し替えた時計：sleep で進む。読み直しが止まらないときのために回数の上限で投げる */
function fakeClock() {
  let now = Date.UTC(2026, 9, 13);
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length > 100) throw new Error('読み直しが止まらない');
      now += ms;
    },
  };
}

const noPatch = () => assert.fail('samePatch は呼ばない（head の違う記録が無い）');

test('api-review：reviewSource が無い・mode local なら GitHub を一度も読まずに disabled', async (t) => {
  const { apiReview } = await loadCommand();
  const file = judgeInputFile(t);
  for (const [name, cfg] of [
    ['reviewSource が無い', withoutSource()],
    ['mode local', withSource({ mode: 'local' })],
  ] as const) {
    const { gh, touched } = untouchableGh();
    const clock = fakeClock();
    const out = await apiReview(gh, cfg, PR, file, { now: clock.now, sleep: clock.sleep, samePatch: noPatch });
    assert.deepEqual(out, { action: 'local', reason: 'disabled' }, name);
    assert.deepEqual(touched, [], `${name}: GitHub を読んだ`);
    assert.deepEqual(clock.sleeps, [], `${name}: 待った`);
  }
});

test('api-review：記録が無いまま waitMinutes を過ぎたら timeout（30 秒おきに読み直す。0 なら読み直さない）', async (t) => {
  const { apiReview } = await loadCommand();
  const file = judgeInputFile(t);

  const waiting = fakeGh(() => []);
  const clock = fakeClock();
  const out = await apiReview(waiting.gh, withSource({ mode: 'api', waitMinutes: 1, appLogin: APP }), PR, file, { now: clock.now, sleep: clock.sleep, samePatch: noPatch });
  assert.deepEqual(out, { action: 'local', reason: 'timeout' });
  assert.ok(clock.sleeps.length >= 1 && clock.sleeps.length <= 3, `sleep の回数 ${clock.sleeps.length}`);
  assert.ok(clock.sleeps.every((ms) => ms === 30_000), `sleep の長さ ${clock.sleeps.join(',')}`);
  assert.ok(waiting.calls.filter((c) => c.startsWith('listComments')).length >= 2, '読み直していない');

  const once = fakeGh(() => []);
  const clock0 = fakeClock();
  const out0 = await apiReview(once.gh, withSource({ mode: 'api', waitMinutes: 0, appLogin: APP }), PR, file, { now: clock0.now, sleep: clock0.sleep, samePatch: noPatch });
  assert.deepEqual(out0, { action: 'local', reason: 'timeout' });
  assert.deepEqual(clock0.sleeps, [], 'waitMinutes 0 で待った');
  assert.equal(once.calls.filter((c) => c.startsWith('listComments')).length, 1, 'waitMinutes 0 で読み直した');
});

test('api-review：posted の記録から Reviewer・Risk のファイルを書き、composeVerdict に渡すと判定コメントが組める', async (t) => {
  const { apiReview } = await loadCommand();
  const file = judgeInputFile(t);
  const { gh } = fakeGh(() => [postedComment()]);
  const clock = fakeClock();
  const out = await apiReview(gh, withSource({ mode: 'api', waitMinutes: 8, appLogin: APP }), PR, file, { now: clock.now, sleep: clock.sleep, samePatch: noPatch });
  assert.equal(out.action, 'api');
  const { reviewer, risk, recordUrl, recordHead, models } = out as { reviewer: string; risk: string; recordUrl: string; recordHead: string; models: unknown };
  t.after(() => {
    for (const p of [reviewer, risk]) rmSync(dirname(p), { recursive: true, force: true });
  });
  assert.equal(basename(reviewer), `api-reviewer-${PR}-${HEAD.slice(0, 7)}.json`);
  assert.equal(basename(risk), `api-risk-${PR}-${HEAD.slice(0, 7)}.json`);
  assert.equal(recordUrl, 'https://example.test/c7');
  assert.equal(recordHead, HEAD);
  assert.deepEqual(models, MODELS);
  assert.deepEqual(clock.sleeps, [], '記録があるのに待った');

  const composed = composeVerdict({
    pr: PR,
    judgedHead: recordHead,
    currentHead: recordHead,
    reviewer: JSON.parse(readFileSync(reviewer, 'utf8')),
    risk: JSON.parse(readFileSync(risk, 'utf8')),
    meta: { model: MODELS.review, judgedBy: '付き添いのセッション' },
  });
  assert.ok(composed.ok, composed.ok ? '' : composed.errors.join(' / '));
  assert.ok(composed.value.includes('```agent-verdict'), composed.value);
});
