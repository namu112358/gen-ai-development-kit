// Issue #805：セッションの判定（```agent-session-judgment）を期間で集め、基準ごとの件数と抜き取りの一覧を出す集計（digestSessionJudgments）と、
// 引数（parseDigestArgs）・週1回の手元の状態（parseDigestState・weeklyPeriod）、コマンド session-judgment-digest が GitHub に書かないことを確かめる。
//
// このテストが前提にする公開の形（harness/lib/session-judgment.ts）：
// - digestSessionJudgments(comments: (IssueComment & { issue_url?: string })[], period: { since: Date; until: Date }, opts: { sample: number }):
//     { since: string; until: string; total: number; counts: Record<basis, number>; samples: Record<basis, Sample[]>; unreadable: number; lines: string[] }
//     Sample は { target, stage, decision, url（コメントの html_url）, createdAt }。作成時刻が [since, until) で、コラボレーターの、目印のある、
//     ブロックを持つコメントだけを数える。読めないブロックは unreadable にだけ数える。抜き取りは基準ごとに新しい順（同じ時刻は ID の大きい順）で sample 件まで。
//     lines は基準ごとの見出し「<basis>: N 件（抜き取り M 件）」と、抜き取りごとの「- #<target> <stage>: <decision>（<url>）」。
// - parseDigestArgs(args, now)：--days・--since・--until（qa-retro と同じ読み方。既定は直近 7 日）・--sample（既定 3）・--weekly・--state
// - parseDigestState(text)：無い・空なら state は null。weeklyPeriod(state, now)：前回の終わりから 7 日未満なら { due: false, nextAt }、それ以外は { due: true, since, until: now }
// コマンド：node harness/scripts/agent.ts session-judgment-digest --weekly --state <path>（出力は JSON。due が偽なら GitHub を読まない）
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import type { GitHub, IssueComment } from '../lib/github.ts';
import {
  digestSessionJudgments,
  parseDigestArgs,
  parseDigestState,
  SESSION_JUDGMENT_BASES,
  weeklyPeriod,
} from '../lib/session-judgment.ts';

/** commands/session-judgment.ts は cli.ts を通して harness.config.json を読むので、使うときだけ読み込む */
const loadCommands = () => import('../scripts/agent/commands/session-judgment.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-12T00:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 7 * DAY);
const PERIOD = { since: SINCE, until: NOW };
const SESSION = '805a0b1c-2d3e-4f50-8a9b-0123456789ab';

type Basis = (typeof SESSION_JUDGMENT_BASES)[number];
type Comment = IssueComment & { issue_url?: string };

/** 期間の中の時刻（since から h 時間後） */
const at = (h: number): string => new Date(SINCE.getTime() + h * 60 * 60 * 1000).toISOString();

const judgment = (target: number, basis: Basis, decision = `#${target} の決めたこと`) => ({
  version: 1,
  target,
  stage: 'plan-review',
  basis,
  decision,
  reason: '理由',
});

/** セッションの判定のコメント。kind は Issue か PR（URL だけが変わる） */
function comment(
  id: number,
  createdAt: string,
  o: { target?: number; basis?: Basis; decision?: string; body?: string; assoc?: string; kind?: 'issues' | 'pull' } = {},
): Comment {
  const target = o.target ?? 10;
  const body = o.body ?? `${claudeMark(SESSION)}\n## セッションの判定\n\n${renderBlock('agent-session-judgment', judgment(target, o.basis ?? 'risk-only', o.decision))}`;
  return {
    id,
    body,
    html_url: `https://github.com/o/r/${o.kind ?? 'issues'}/${target}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/o/r/issues/${target}`,
    created_at: createdAt,
    updated_at: createdAt,
    author_association: o.assoc ?? 'OWNER',
    user: { login: 'me', type: 'User' },
  };
}

const zeros = (): Record<Basis, number> => Object.fromEntries(SESSION_JUDGMENT_BASES.map((b) => [b, 0])) as Record<Basis, number>;

// ---- 集計（digestSessionJudgments）----

test('digestSessionJudgments：基準が混ざった記録を基準ごとに数え、0 件の基準も counts に 0 で出る', () => {
  const comments = [
    comment(1, at(1), { basis: 'risk-only' }),
    comment(2, at(2), { basis: 'risk-only' }),
    comment(3, at(3), { basis: 'fixable' }),
    comment(4, at(4), { basis: 'recorded' }),
  ];
  const d = digestSessionJudgments(comments, PERIOD, { sample: 3 });
  assert.deepEqual(d.counts, { ...zeros(), 'risk-only': 2, fixable: 1, recorded: 1 });
  assert.equal(d.total, 4);
  assert.equal(d.unreadable, 0);
  assert.deepEqual(d.samples.wait, []);
  assert.equal(d.since, SINCE.toISOString());
  assert.equal(d.until, NOW.toISOString());
});

test('digestSessionJudgments：期間の境界・信頼しないコメント・目印やブロックの無いコメントは数えず、読めないブロックは unreadable にだけ数える', () => {
  const mark = claudeMark(SESSION);
  const cases: { name: string; c: Comment; counted: number; unreadable: number }[] = [
    { name: 'since ちょうどは入る', c: comment(1, SINCE.toISOString()), counted: 1, unreadable: 0 },
    { name: 'since の 1ms 前は入らない', c: comment(1, new Date(SINCE.getTime() - 1).toISOString()), counted: 0, unreadable: 0 },
    { name: 'until の 1ms 前は入る', c: comment(1, new Date(NOW.getTime() - 1).toISOString()), counted: 1, unreadable: 0 },
    { name: 'until ちょうどは入らない', c: comment(1, NOW.toISOString()), counted: 0, unreadable: 0 },
    { name: 'コラボレーターでない', c: comment(1, at(1), { assoc: 'NONE' }), counted: 0, unreadable: 0 },
    { name: '目印が無い', c: comment(1, at(1), { body: renderBlock('agent-session-judgment', judgment(10, 'risk-only')) }), counted: 0, unreadable: 0 },
    { name: 'ブロックが無い', c: comment(1, at(1), { body: `${mark}\n## セッションの判定\n\n本文だけ` }), counted: 0, unreadable: 0 },
    { name: 'ブロックの JSON が壊れている', c: comment(1, at(1), { body: `${mark}\n\`\`\`agent-session-judgment\n{ 壊れた\n\`\`\`` }), counted: 0, unreadable: 1 },
    { name: 'ブロックの書式の誤り（知らない基準）', c: comment(1, at(1), { body: `${mark}\n${renderBlock('agent-session-judgment', { ...judgment(10, 'risk-only'), basis: 'human' })}` }), counted: 0, unreadable: 1 },
  ];
  for (const { name, c, counted, unreadable } of cases) {
    const d = digestSessionJudgments([c], PERIOD, { sample: 3 });
    const sum = Object.values(d.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, counted, `${name}: counts ${JSON.stringify(d.counts)}`);
    assert.equal(d.unreadable, unreadable, `${name}: unreadable`);
    for (const b of SESSION_JUDGMENT_BASES) assert.equal(d.samples[b].length, b === 'risk-only' ? counted : 0, `${name}: samples.${b}`);
  }
});

test('digestSessionJudgments：抜き取りは基準ごとに新しい順で sample 件まで（同じ時刻は ID の大きい順）。sample 以下ならすべて', () => {
  const comments = [
    comment(1, at(1), { target: 1 }),
    comment(2, at(5), { target: 2 }),
    comment(3, at(3), { target: 3 }),
    comment(7, at(4), { target: 7 }),
    comment(8, at(4), { target: 8 }),
    comment(20, at(2), { target: 20, basis: 'fixable' }),
    comment(21, at(6), { target: 21, basis: 'fixable', kind: 'pull' }),
  ];
  const d = digestSessionJudgments(comments, PERIOD, { sample: 3 });
  assert.equal(d.counts['risk-only'], 5);
  assert.deepEqual(d.samples['risk-only'].map((s) => s.target), [2, 8, 7]);
  assert.deepEqual(d.samples.fixable.map((s) => s.target), [21, 20]);
  assert.deepEqual(d.samples.fixable[0], {
    target: 21,
    stage: 'plan-review',
    decision: '#21 の決めたこと',
    url: 'https://github.com/o/r/pull/21#issuecomment-21',
    createdAt: at(6),
  });
});

test('digestSessionJudgments：lines に基準ごとの見出しと、抜き取りごとに #target・決めたこと・URL の1行が出る（Issue と PR のコメント）', () => {
  const comments = [
    comment(31, at(1), { target: 31, basis: 'risk-only', decision: '進める' }),
    comment(32, at(2), { target: 32, basis: 'fixable', decision: '計画を出し直す', kind: 'pull' }),
  ];
  const d = digestSessionJudgments(comments, PERIOD, { sample: 3 });
  const issueUrl = 'https://github.com/o/r/issues/31#issuecomment-31';
  const prUrl = 'https://github.com/o/r/pull/32#issuecomment-32';
  for (const want of [
    'risk-only: 1 件（抜き取り 1 件）',
    `- #31 plan-review: 進める（${issueUrl}）`,
    'fixable: 1 件（抜き取り 1 件）',
    `- #32 plan-review: 計画を出し直す（${prUrl}）`,
    'recorded: 0 件（抜き取り 0 件）',
    'wait: 0 件（抜き取り 0 件）',
  ]) {
    assert.ok(d.lines.includes(want), `lines に「${want}」がありません: ${JSON.stringify(d.lines)}`);
  }
  assert.equal(d.lines.length, SESSION_JUDGMENT_BASES.length + 2, '見出し4行と抜き取り2行だけ');
});

test('digestSessionJudgments：記録が0件なら全基準 0 件・抜き取りなし', () => {
  const d = digestSessionJudgments([], PERIOD, { sample: 3 });
  assert.deepEqual(d.counts, zeros());
  assert.equal(d.total, 0);
  assert.equal(d.unreadable, 0);
  for (const b of SESSION_JUDGMENT_BASES) assert.deepEqual(d.samples[b], [], b);
  assert.equal(d.lines.length, SESSION_JUDGMENT_BASES.length);
});

// ---- 引数（parseDigestArgs）----

test('parseDigestArgs：既定は直近 7 日・抜き取り 3 件。--until はその日を含み、--sample と --weekly・--state を読む', () => {
  const def = parseDigestArgs([], NOW);
  assert.ok(def.ok, JSON.stringify(def));
  assert.deepEqual(def.value, { since: SINCE, until: NOW, sample: 3, weekly: false, state: null });

  const range = parseDigestArgs(['--since', '2026-10-01', '--until', '2026-10-03', '--sample', '5'], NOW);
  assert.ok(range.ok, JSON.stringify(range));
  assert.equal(range.value.since.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(range.value.until.toISOString(), '2026-10-04T00:00:00.000Z');
  assert.equal(range.value.sample, 5);

  const weekly = parseDigestArgs(['--weekly', '--state', '/tmp/x.json'], NOW);
  assert.ok(weekly.ok, JSON.stringify(weekly));
  assert.equal(weekly.value.weekly, true);
  assert.equal(weekly.value.state, '/tmp/x.json');
});

test('parseDigestArgs：--weekly と期間の同時指定、正の整数でない --sample は誤り', () => {
  const cases: string[][] = [
    ['--weekly', '--days', '3'],
    ['--weekly', '--since', '2026-10-01'],
    ['--weekly', '--until', '2026-10-01'],
    ['--sample', '0'],
    ['--sample', '-1'],
    ['--sample', '1.5'],
    ['--sample', 'x'],
    ['--sample'],
  ];
  for (const args of cases) {
    const r = parseDigestArgs(args, NOW);
    assert.equal(r.ok, false, args.join(' '));
    if (!r.ok) assert.ok(r.errors.length > 0, args.join(' '));
  }
});

// ---- 週1回の状態（parseDigestState・weeklyPeriod）----

test('weeklyPeriod：状態なしは直近 7 日、前回から 7 日未満は due でなく nextAt、7 日以上は前回の終わりから now まで', () => {
  const none = weeklyPeriod(null, NOW);
  assert.deepEqual(none, { due: true, since: SINCE, until: NOW });

  const recent = new Date(NOW.getTime() - 7 * DAY + 1);
  const notDue = weeklyPeriod({ version: 1, lastUntil: recent.toISOString() }, NOW);
  assert.equal(notDue.due, false);
  if (!notDue.due) assert.equal(new Date(notDue.nextAt).getTime(), recent.getTime() + 7 * DAY);

  for (const days of [7, 10]) {
    const last = new Date(NOW.getTime() - days * DAY);
    assert.deepEqual(weeklyPeriod({ version: 1, lastUntil: last.toISOString() }, NOW), { due: true, since: last, until: NOW }, `${days} 日前`);
  }
});

test('parseDigestState：無い・空は null、正しい状態は読み、書式の誤りはエラー', () => {
  for (const text of [null, '']) assert.deepEqual(parseDigestState(text), { ok: true, state: null }, JSON.stringify(text));
  const good = { version: 1, lastUntil: '2026-10-05T00:00:00.000Z' };
  assert.deepEqual(parseDigestState(JSON.stringify(good)), { ok: true, state: good });
  for (const text of ['壊れた', '[]', '{"version":2,"lastUntil":"2026-10-05T00:00:00.000Z"}', '{"version":1}', '{"version":1,"lastUntil":"abc"}']) {
    const r = parseDigestState(text);
    assert.equal(r.ok, false, text);
    if (!r.ok) assert.ok(r.errors.length > 0, text);
  }
});

// ---- コマンド（session-judgment-digest）----

/** answers に挙げたメソッドだけに答え、呼び出しを calls に残す偽の GitHub。ほかのメソッド（書き込みを含む）は呼ばれたら投げる */
function fakeGh(calls: string[], answers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}): GitHub {
  return new Proxy(answers, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'string' && prop in target) {
        return (...args: unknown[]) => {
          calls.push(`${prop} ${JSON.stringify(args)}`);
          return target[prop]!(...args);
        };
      }
      throw new Error(`偽の GitHub：想定外の呼び出し ${String(prop)}`);
    },
  }) as unknown as GitHub;
}

async function runDigest(t: import('node:test').TestContext, args: string[], gh: () => GitHub): Promise<Record<string, unknown>> {
  const logs: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  t.mock.method(process, 'exit', (code?: number) => {
    throw new Error(`process.exit(${code}): ${errors.join('\n')}`);
  });
  const { commands } = await loadCommands();
  const cmd = commands.find((c) => c.name === 'session-judgment-digest');
  assert.ok(cmd, 'session-judgment-digest のコマンドがある');
  await cmd.run(args, { counter: null, gh });
  t.mock.restoreAll();
  assert.equal(logs.length, 1, `出力は JSON 1つ: ${logs.join('\n')} ${errors.join('\n')}`);
  return JSON.parse(logs[0]!) as Record<string, unknown>;
}

test('session-judgment-digest --weekly：due でなければ GitHub を読まずに due: false と nextAt を出し、状態を変えない', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  const state = JSON.stringify({ version: 1, lastUntil: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  writeFileSync(statePath, state);
  let ghCalls = 0;
  const calls: string[] = [];
  const out = await runDigest(t, ['--weekly', '--state', statePath], () => {
    ghCalls++;
    return fakeGh(calls);
  });
  assert.equal(out.due, false, JSON.stringify(out));
  assert.equal(typeof out.nextAt, 'string');
  assert.equal(ghCalls, 0, 'GitHub の窓口を作らない');
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(statePath, 'utf8'), state, '状態のファイルは変わらない');
});

test('session-judgment-digest --weekly：due なら REST のコメントを読むだけで集計を出し（書き込みの呼び出しが無い）、状態の lastUntil を進める', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  const last = new Date(Date.now() - 8 * DAY);
  writeFileSync(statePath, JSON.stringify({ version: 1, lastUntil: last.toISOString() }));
  const inRange = new Date(last.getTime() + DAY).toISOString();
  const before = new Date(last.getTime() - DAY).toISOString();
  const calls: string[] = [];
  const started = Date.now();
  const out = await runDigest(t, ['--weekly', '--state', statePath], () =>
    fakeGh(calls, {
      async paginate(path) {
        assert.match(String(path), /^\/issues\/comments\?/, 'リポジトリのコメントの一覧を読む');
        assert.match(String(path), /since=/, 'since で絞る');
        return [comment(1, inRange, { basis: 'fixable' }), comment(2, before, { basis: 'fixable' })];
      },
    }),
  );
  assert.equal(out.due, true, JSON.stringify(out));
  assert.deepEqual(out.counts, { ...zeros(), fixable: 1 });
  assert.ok(Array.isArray(out.lines));
  assert.ok(calls.length >= 1 && calls.every((c) => c.startsWith('paginate ')), `読むのは paginate だけ: ${calls.join('\n')}`);
  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { version: number; lastUntil: string };
  assert.equal(saved.version, 1);
  assert.ok(new Date(saved.lastUntil).getTime() >= started, `lastUntil が今に進む: ${saved.lastUntil}`);
});
