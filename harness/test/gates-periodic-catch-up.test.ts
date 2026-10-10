// Issue #418：定期実行（schedule）が来ないとき、イベントで動いた gate が定期の仕事を1回補う処理（periodic-catch-up.ts）のテスト。
// ダッシュボードの印（前回の定期の仕事の時刻）の読み書き、空いているかの判断、重なりを避ける読み直し、補った理由のログ、しきい値の設定を確かめる。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appMark } from '../lib/blocks.ts';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import type { GateContext } from '../gates/context.ts';
import {
  catchUpDecision,
  catchUpPeriodic,
  DEFAULT_PERIODIC_CATCH_UP_MINUTES,
  periodicCatchUpMinutes,
  readPeriodicMark,
  renderPeriodicMark,
  replacePeriodicMark,
  type PeriodicMark,
} from '../gates/periodic-catch-up.ts';
import { APP, config, ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

const NOW = new Date('2026-10-10T12:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();
const QUEUE = '<!-- agent-harness:queue:start -->\nqueue の節\n<!-- agent-harness:queue:end -->';
const CONFIG = { ...config, periodicCatchUpMinutes: 90 } as HarnessConfig;

/** ダッシュボード（#1）だけを持つ偽の GitHub。body が null ならダッシュボードは無い（POST /issues で作られる） */
function dashboardFake(state: { body: string | null }): FakeGitHub {
  const dashboard = () => ({ number: 1, title: config.dashboardIssueTitle, html_url: 'd', state: 'open', user: { login: APP }, labels: [], body: state.body });
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&creator=/, () => (state.body === null ? [] : [dashboard()]))
    .on('GET', /\/issues\/1$/, () => {
      if (state.body === null) throw new Error('404 issues/1');
      return dashboard();
    })
    .on('PATCH', /\/issues\/1$/, (_m, body) => {
      state.body = String(body.body);
      return dashboard();
    })
    .on('POST', /\/issues$/, (_m, body) => {
      state.body = String(body.body);
      return dashboard();
    });
}

/** console.log・console.error と ctx.log のすべてを集める（どこに出してもログとして拾う） */
async function withLogs<T>(fn: (log: (msg: string) => void) => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    const result = await fn((msg) => lines.push(msg));
    return { result, logs: lines.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

/** 補う処理を、差し替えた work・sleep・now・runId で動かす */
async function runCatchUp(state: { body: string | null }, onSleep: () => void = () => {}) {
  const fake = dashboardFake(state);
  const worked: { now: Date }[] = [];
  const slept: number[] = [];
  const { result, logs } = await withLogs((log) => {
    const ctx: GateContext = ctxFor(fake, 'issue_comment', {}, { config: CONFIG, log });
    return catchUpPeriodic(ctx, {
      now: NOW,
      runId: 'run-mine',
      sleep: async (ms) => {
        slept.push(ms);
        onSleep();
      },
      work: async (_ctx, now) => void worked.push({ now }),
    });
  });
  return { result, logs, fake, worked, slept };
}

const bodyWith = (mark: PeriodicMark | null): string => [appMark('dashboard'), 'ダッシュボード', '', QUEUE, ...(mark ? ['', renderPeriodicMark(mark)] : [])].join('\n');

// --- (1)(2) しきい値以上空いた・前回の記録が無い：補う ---

test('catchUpPeriodic：前回の印が 120 分前（しきい値 90）なら、定期の仕事を1回行い、印を自分の run にし、前回の時刻・空いた分・しきい値をログに出す', async () => {
  const before = { at: minutesAgo(120), run: 'run-old', event: 'schedule' };
  const state = { body: bodyWith(before) as string | null };
  const { result, logs, worked } = await runCatchUp(state);
  assert.equal(result, 'ran');
  assert.equal(worked.length, 1);
  assert.equal(worked[0]!.now.getTime(), NOW.getTime());
  assert.equal(readPeriodicMark(state.body!)?.run, 'run-mine');
  assert.ok(state.body!.includes(QUEUE), 'queue の節を消さない');
  assert.ok(logs.includes(before.at), `前回の時刻がログに無い：${logs}`);
  assert.match(logs, /120\s*分/);
  assert.match(logs, /90\s*分/);
});

test('catchUpPeriodic：前回の印が無い（ダッシュボードに印が無い・ダッシュボードが無い）なら、定期の仕事を1回行い、前回の記録が無いことをログに出す', async () => {
  for (const [name, body] of [['印の無いダッシュボード', bodyWith(null)], ['ダッシュボードが無い', null]] as const) {
    const state = { body: body as string | null };
    const { result, logs, worked } = await runCatchUp(state);
    assert.equal(result, 'ran', name);
    assert.equal(worked.length, 1, name);
    assert.ok(state.body !== null, `${name}：ダッシュボードが作られていない`);
    assert.equal(readPeriodicMark(state.body!)?.run, 'run-mine', name);
    assert.match(logs, /前回の記録が無い/, name);
  }
});

// --- (3) 空いていない：重ねない ---

test('catchUpPeriodic：前回の印が 30 分前（しきい値 90）なら、定期の仕事を行わず、本文も書かず、補わない理由をログに出す', async () => {
  const state = { body: bodyWith({ at: minutesAgo(30), run: 'run-old', event: 'schedule' }) as string | null };
  const before = state.body;
  const { result, logs, worked, fake, slept } = await runCatchUp(state);
  assert.equal(result, 'not-due');
  assert.equal(worked.length, 0);
  assert.deepEqual(slept, []);
  assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET'), []);
  assert.equal(state.body, before);
  assert.match(logs, /30\s*分/);
  assert.match(logs, /90\s*分/);
});

// --- (4) 読み直したとき印がほかの run：譲る ---

test('catchUpPeriodic：印を書いて待つ間にほかの run が印を書き換えたら、定期の仕事を行わず yielded を返す', async () => {
  const state = { body: bodyWith({ at: minutesAgo(120), run: 'run-old', event: 'schedule' }) as string | null };
  const { result, worked, slept } = await runCatchUp(state, () => {
    state.body = replacePeriodicMark(state.body!, { at: NOW.toISOString(), run: 'run-other', event: 'issues' });
  });
  assert.equal(result, 'yielded');
  assert.equal(worked.length, 0);
  assert.equal(slept.length, 1);
});

// --- (5) 印の読み書き ---

test('readPeriodicMark・replacePeriodicMark：最後の印を読み、書くときは印を1つにまとめ、ほかの本文は残す', () => {
  const a = { at: minutesAgo(200), run: 'r1', event: 'schedule' };
  const b = { at: minutesAgo(100), run: 'r2', event: 'workflow_dispatch' };
  const c = { at: NOW.toISOString(), run: 'r3', event: 'issue_comment' };
  assert.deepEqual(readPeriodicMark(renderPeriodicMark(a)), a);
  // 印が本文の途中にあり、後ろに queue の節がある
  const body = ['頭', renderPeriodicMark(a), '中', renderPeriodicMark(b), '', QUEUE].join('\n');
  assert.deepEqual(readPeriodicMark(body), b);
  const replaced = replacePeriodicMark(body, c);
  assert.equal(replaced.split('agent-harness:periodic').length - 1, 1, replaced);
  assert.deepEqual(readPeriodicMark(replaced), c);
  for (const kept of ['頭', '中', QUEUE]) assert.ok(replaced.includes(kept), kept);
  // 印が無ければ足す
  const appended = replacePeriodicMark(`${appMark('dashboard')}\n本文\n\n`, c);
  assert.deepEqual(readPeriodicMark(appended), c);
  assert.ok(appended.includes('本文'));
  // 印が無い・時刻が読めない
  assert.equal(readPeriodicMark('本文だけ'), null);
  assert.equal(readPeriodicMark(renderPeriodicMark({ at: 'not-a-date', run: 'r', event: 'schedule' })), null);
});

// --- (6) 空いているかの判断 ---

test('catchUpDecision：しきい値以上・印が無い・5 分を超えて未来なら空いている、それ以外は空いていない', () => {
  const mark = (at: string): PeriodicMark => ({ at, run: 'r', event: 'schedule' });
  const cases: [string, PeriodicMark | null, boolean][] = [
    ['印が無い', null, true],
    ['120 分前', mark(minutesAgo(120)), true],
    ['ちょうど 90 分前', mark(minutesAgo(90)), true],
    ['89 分前', mark(minutesAgo(89)), false],
    ['30 分前', mark(minutesAgo(30)), false],
    ['3 分未来（時計のずれの範囲）', mark(minutesAgo(-3)), false],
    ['10 分未来', mark(minutesAgo(-10)), true],
  ];
  for (const [name, m, due] of cases) {
    const d = catchUpDecision(m, NOW, 90);
    assert.equal(d.due, due, name);
    assert.equal(typeof d.reason, 'string', name);
  }
  assert.equal(catchUpDecision(mark(minutesAgo(120)), NOW, 90).elapsedMinutes, 120);
  assert.equal(catchUpDecision(null, NOW, 90).elapsedMinutes, null);
});

// --- (7) しきい値の設定 ---

const REAL_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));

function loadWith(value: unknown): HarnessConfig {
  const raw = JSON.parse(readFileSync(REAL_PATH, 'utf8')) as Record<string, unknown>;
  if (value === undefined) delete raw.periodicCatchUpMinutes;
  else raw.periodicCatchUpMinutes = value;
  const dir = mkdtempSync(join(tmpdir(), 'periodic-catch-up-'));
  const path = join(dir, 'harness.config.json');
  writeFileSync(path, JSON.stringify(raw, null, 2));
  try {
    return loadConfig(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('periodicCatchUpMinutes：0・負は loadConfig の誤り、無ければ既定 90、あればその値', () => {
  for (const bad of [0, -1]) {
    assert.throws(() => loadWith(bad), (err: unknown) => err instanceof Error && err.message.includes('periodicCatchUpMinutes'), String(bad));
  }
  assert.equal(DEFAULT_PERIODIC_CATCH_UP_MINUTES, 90);
  assert.equal(periodicCatchUpMinutes(loadWith(undefined)), 90);
  assert.equal(periodicCatchUpMinutes(loadWith(45)), 45);
});
