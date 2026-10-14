// Issue #1098：判定の Routine の1日の上限（harness/lib/judge-routine-budget.ts と、コマンドの中身 runJudgeRoutineBudget）。
// (1) countRoutineVerdicts：信頼できる目印つきの agent-verdict で metrics.judgedBy が routine で始まり、直近24時間（now-24h 以上 now 以下）のものだけ数える。
//     壊れたブロック・metrics 無し・judgedBy が URL や付き添いのセッション・信頼できない投稿者・now より後・24時間より前・時刻が読めない、は数えない。
// (2) judgeRoutineBudget：limit が null なら ok、truncated なら ok: false（truncated: true）、それ以外は count < limit。
// (3) parseJudgeDailyLimit：オブジェクトでない・キー無しは null、安全な正の整数は limit、0・負・小数・文字列・真偽値は誤り。
// (4) runJudgeRoutineBudget を偽の GitHub で：上限に達したら ok: false（GET 1回・書き込み無し）、上限 null は GitHub を読まない、
//     誤った上限は終了コード 2 で GitHub を読まない、20ページすべて埋まっていれば truncated。
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import { GitHub } from '../lib/github.ts';
import { countRoutineVerdicts, DAY_MS, judgeRoutineBudget, parseJudgeDailyLimit } from '../lib/judge-routine-budget.ts';
import { FakeGitHub, HEAD } from './support/gate-fixtures.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3600_000;

/** 判定コメントの偽物。metrics は judgedBy を入れる（null なら metrics 無し） */
function verdictBody(judgedBy: unknown | null, mark = CLAUDE_MARK): string {
  const v = { version: 1, pr: 5, headSha: HEAD, ...(judgedBy === null ? {} : { metrics: { judgedBy } }) };
  return `${mark}\n判定しました。\n\n${renderBlock('agent-verdict', v as never)}`;
}
function comment(patch: { body?: string; association?: string; createdAt?: string } = {}) {
  return { id: 1, body: patch.body ?? verdictBody('routine'), author_association: patch.association ?? 'OWNER', created_at: patch.createdAt ?? ago(HOUR) };
}

test('countRoutineVerdicts：信頼できる直近24時間の routine の判定だけ数える', () => {
  const cases: { name: string; c: ReturnType<typeof comment>; n: number }[] = [
    { name: 'routine', c: comment(), n: 1 },
    { name: 'routine:xxx（routine で始まる）', c: comment({ body: verdictBody('routine:abc') }), n: 1 },
    { name: 'ちょうど24時間前', c: comment({ createdAt: ago(DAY_MS) }), n: 1 },
    { name: 'ちょうど now', c: comment({ createdAt: NOW.toISOString() }), n: 1 },
    { name: '24時間より前', c: comment({ createdAt: ago(DAY_MS + 1) }), n: 0 },
    { name: 'now より後', c: comment({ createdAt: new Date(NOW.getTime() + 1).toISOString() }), n: 0 },
    { name: '時刻が読めない', c: comment({ createdAt: 'いつか' }), n: 0 },
    { name: '信頼できない投稿者（NONE）', c: comment({ association: 'NONE' }), n: 0 },
    { name: '目印が無い', c: comment({ body: verdictBody('routine', '') }), n: 0 },
    { name: 'metrics 無し', c: comment({ body: verdictBody(null) }), n: 0 },
    { name: 'judgedBy が URL', c: comment({ body: verdictBody('https://claude.ai/code/session_1') }), n: 0 },
    { name: 'judgedBy が付き添いのセッション', c: comment({ body: verdictBody('付き添いのセッション') }), n: 0 },
    { name: 'judgedBy が文字列でない', c: comment({ body: verdictBody(5) }), n: 0 },
    { name: '壊れたブロック', c: comment({ body: `${CLAUDE_MARK}\n\`\`\`agent-verdict\n{ "pr": \n\`\`\`` }), n: 0 },
  ];
  for (const x of cases) assert.equal(countRoutineVerdicts([x.c], NOW), x.n, x.name);
  assert.equal(countRoutineVerdicts(cases.map((x) => x.c), NOW), cases.reduce((a, x) => a + x.n, 0));
});

test('judgeRoutineBudget：limit が null なら ok、truncated なら ok: false、それ以外は count < limit', () => {
  const cases: { name: string; input: { count: number; limit: number | null; truncated: boolean }; want: unknown }[] = [
    { name: 'limit null', input: { count: 99, limit: null, truncated: false }, want: { ok: true, count: 99, limit: null } },
    { name: '上限の手前', input: { count: 2, limit: 3, truncated: false }, want: { ok: true, count: 2, limit: 3 } },
    { name: '上限ちょうど', input: { count: 3, limit: 3, truncated: false }, want: { ok: false, count: 3, limit: 3 } },
    { name: '上限を超える', input: { count: 4, limit: 3, truncated: false }, want: { ok: false, count: 4, limit: 3 } },
    { name: 'truncated', input: { count: 0, limit: 3, truncated: true }, want: { ok: false, count: 0, limit: 3, truncated: true } },
  ];
  for (const c of cases) assert.deepEqual(judgeRoutineBudget(c.input), c.want, c.name);
});

test('parseJudgeDailyLimit：オブジェクトでない・キー無しは null、安全な正の整数は limit、それ以外は誤り', () => {
  const cases: { name: string; input: unknown; ok: boolean; limit?: number | null }[] = [
    { name: 'undefined', input: undefined, ok: true, limit: null },
    { name: 'null', input: null, ok: true, limit: null },
    { name: '文字列', input: 'x', ok: true, limit: null },
    { name: 'キー無し', input: {}, ok: true, limit: null },
    { name: '3', input: { judgeDailyLimit: 3 }, ok: true, limit: 3 },
    { name: '0', input: { judgeDailyLimit: 0 }, ok: false },
    { name: '-1', input: { judgeDailyLimit: -1 }, ok: false },
    { name: '1.5', input: { judgeDailyLimit: 1.5 }, ok: false },
    { name: '"3"', input: { judgeDailyLimit: '3' }, ok: false },
    { name: 'true', input: { judgeDailyLimit: true }, ok: false },
  ];
  for (const c of cases) {
    const r = parseJudgeDailyLimit(c.input);
    assert.equal(r.ok, c.ok, c.name);
    if (r.ok) assert.equal(r.limit, c.limit, c.name);
    else assert.ok(r.error.length > 0, `${c.name}: 理由が空`);
  }
});

// --- (4) コマンドの中身を偽の GitHub で ---

/** commands のファイルは cli.ts を import し、cli.ts は読み込み時に harness.config.json を読むので、使うときだけ読み込む */
const loadMod = () => import('../scripts/agent/commands/judge-routine-budget.ts');

const commentsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ ...comment(), id: i + 1 }));

/** page ごとの応答を返す偽の GitHub（since つきの GET /issues/comments） */
function world(pages: (page: number) => unknown[]) {
  return new FakeGitHub().on('GET', /\/issues\/comments\?(.*)$/, (m) => pages(Number(new URLSearchParams(m[1]!).get('page') ?? '1')));
}

const silence = (t: TestContext) => {
  const errors: string[] = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', (...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  return errors;
};

test('runJudgeRoutineBudget：上限 3 に routine の判定が 3 件なら ok: false（GET は1回・書き込み無し）', async (t) => {
  const { runJudgeRoutineBudget } = await loadMod();
  const fake = world((page) => (page === 1 ? commentsOf(3) : []));
  silence(t);
  const r = await runJudgeRoutineBudget(new GitHub(fake, 'o/r'), { judgeDailyLimit: 3 }, NOW);
  assert.deepEqual(r, { ok: false, count: 3, limit: 3 });
  assert.deepEqual(fake.writes(), []);
  const gets = fake.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/repos/o/r/issues/comments?since='));
  assert.equal(gets.length, 1);
  assert.equal(fake.calls.length, 1);
  assert.ok(gets[0]!.path.includes(encodeURIComponent(new Date(NOW.getTime() - DAY_MS).toISOString())), gets[0]!.path);
});

test('runJudgeRoutineBudget：上限 null なら GitHub を読まず ok: true・limit: null・count: 0', async (t) => {
  const { runJudgeRoutineBudget } = await loadMod();
  const fake = world(() => []);
  silence(t);
  const r = await runJudgeRoutineBudget(new GitHub(fake, 'o/r'), {}, NOW);
  assert.deepEqual(r, { ok: true, count: 0, limit: null });
  assert.deepEqual(fake.calls, []);
});

test('runJudgeRoutineBudget：誤った上限（0）は理由を出して終了コード 2 で止まり、GitHub を読まない', async (t) => {
  const { runJudgeRoutineBudget } = await loadMod();
  const fake = world(() => []);
  const errors = silence(t);
  const codes: (number | undefined)[] = [];
  t.mock.method(process, 'exit', (code?: number) => {
    codes.push(code);
    throw new Error(`process.exit(${code})`);
  });
  await assert.rejects(runJudgeRoutineBudget(new GitHub(fake, 'o/r'), { judgeDailyLimit: 0 }, NOW), /process\.exit\(2\)/);
  assert.deepEqual(codes, [2]);
  assert.ok(errors.join('\n').length > 0, '理由が出ていない');
  assert.deepEqual(fake.calls, []);
});

test('runJudgeRoutineBudget：20ページすべてが100件で埋まっていれば ok: false・truncated: true', async (t) => {
  const { runJudgeRoutineBudget, MAX_PAGES } = await loadMod();
  assert.equal(MAX_PAGES, 20);
  const fake = world((page) => (page >= 1 && page <= 20 ? commentsOf(100) : []));
  silence(t);
  const r = await runJudgeRoutineBudget(new GitHub(fake, 'o/r'), { judgeDailyLimit: 1_000_000 }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.truncated, true);
  assert.deepEqual(fake.writes(), []);
});
