// Issue #786：判定の Routine の1回分の入力の検査（harness/lib/judge-routine.ts と、コマンド judge-routine-check の中身 runJudgeRoutineCheck）。
// (1) parseJudgeRoutineInput：壊れた JSON は理由つきで ok: false。コードブロックに入った JSON は読め、dryRun が無ければ false。
// (2) checkJudgeRoutineInput：PR が open でない（closed・merged）・base が違う・head も patch-id も違う、で skip と理由。
//     head が同じなら judge（samePatch を呼ばない）。head が違っても patch-id が同じなら judge（判定するのは今の head、inputHead に入力の head）。
// (3) runJudgeRoutineCheck を偽の GitHub（FakeGitHub）で通す：壊れた JSON・closed・404・head も patch-id も違う、で skip と理由。head が同じなら judge。
//     どの場合も GitHub に書き込まない（GET だけ）。patch-id の比べは差し替える（git fetch を流さない）。
// patch-id の分かれ道は (2) の純粋関数に寄せ、入力の形の細かい場合は代表（壊れた JSON）だけにする。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { GitHub, HttpError } from '../lib/github.ts';
import { checkJudgeRoutineInput, type JudgeRoutineInput, parseJudgeRoutineInput } from '../lib/judge-routine.ts';
import { FakeGitHub, HEAD, pr } from './support/gate-fixtures.ts';

const OTHER = 'c'.repeat(40);
const BROKEN = ['{ "pr": 5, "head": ', '', 'これは JSON ではない'];

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function inputFile(text: string): string {
  const d = mkdtempSync(join(tmpdir(), 'judge-routine-input-'));
  tmpDirs.push(d);
  const f = join(d, 'input.txt');
  writeFileSync(f, text);
  return f;
}
const inputText = (patch: Record<string, unknown> = {}) => JSON.stringify({ pr: 5, head: HEAD, base: 'main', ...patch });

// --- (1) 入力の形 ---

test('parseJudgeRoutineInput：壊れた JSON は ok: false と理由を返す', () => {
  for (const text of BROKEN) {
    const r = parseJudgeRoutineInput(text);
    assert.equal(r.ok, false, JSON.stringify(text));
    if (!r.ok) assert.ok(r.reason.length > 0, `理由が空（${JSON.stringify(text)}）`);
  }
});

test('parseJudgeRoutineInput：コードブロックに入った JSON を読み、dryRun が無ければ false', () => {
  const r = parseJudgeRoutineInput(['入力です。', '```json', inputText(), '```'].join('\n'));
  assert.deepEqual(r, { ok: true, value: { pr: 5, head: HEAD, base: 'main', dryRun: false } });
});

// --- (2) PR の状態・head・patch-id ---

const INPUT: JudgeRoutineInput = { pr: 5, head: HEAD, base: 'main', dryRun: true };
const openPr = { state: 'open', merged: false, headSha: HEAD, baseRef: 'main' };

test('checkJudgeRoutineInput：closed・merged・base の違い・head も patch-id も違う、は skip と理由', () => {
  const cases: { name: string; pr: typeof openPr; samePatch: boolean }[] = [
    { name: 'closed', pr: { ...openPr, state: 'closed' }, samePatch: true },
    { name: 'merged', pr: { ...openPr, state: 'closed', merged: true }, samePatch: true },
    { name: 'base が違う', pr: { ...openPr, baseRef: 'develop' }, samePatch: true },
    { name: 'head も patch-id も違う', pr: { ...openPr, headSha: OTHER }, samePatch: false },
  ];
  for (const c of cases) {
    const r = checkJudgeRoutineInput(INPUT, c.pr, () => c.samePatch);
    assert.equal(r.action, 'skip', c.name);
    if (r.action === 'skip') assert.ok(r.reason.length > 0, `${c.name}: 理由が空`);
  }
});

test('checkJudgeRoutineInput：head も patch-id も違う skip の理由に入力の head と今の head が入り、samePatch は入力の head で呼ばれる', () => {
  const asked: string[] = [];
  const r = checkJudgeRoutineInput(INPUT, { ...openPr, headSha: OTHER }, (h) => (asked.push(h), false));
  assert.equal(r.action, 'skip');
  if (r.action === 'skip') {
    assert.ok(r.reason.includes(HEAD), r.reason);
    assert.ok(r.reason.includes(OTHER), r.reason);
  }
  assert.deepEqual(asked, [HEAD]);
});

test('checkJudgeRoutineInput：head が同じなら samePatch を呼ばずに judge', () => {
  let called = 0;
  const r = checkJudgeRoutineInput(INPUT, openPr, () => (called++, false));
  assert.deepEqual(r, { action: 'judge', pr: 5, head: HEAD, inputHead: HEAD, dryRun: true });
  assert.equal(called, 0);
});

test('checkJudgeRoutineInput：head が違っても patch-id が同じなら、今の head を判定する judge（inputHead に入力の head）', () => {
  const r = checkJudgeRoutineInput({ ...INPUT, dryRun: false }, { ...openPr, headSha: OTHER }, () => true);
  assert.deepEqual(r, { action: 'judge', pr: 5, head: OTHER, inputHead: HEAD, dryRun: false });
});

// --- (3) コマンドの中身を偽の GitHub で ---

/** commands のファイルは cli.ts を import し、cli.ts は読み込み時に harness.config.json を読むので、使うときだけ読み込む */
const loadRun = async () => (await import('../scripts/agent/commands/judge-routine.ts')).runJudgeRoutineCheck;

function world(reply: 'missing' | ReturnType<typeof pr>) {
  return new FakeGitHub().on('GET', /\/pulls\/5$/, (_m, _b, opts) => {
    if (reply !== 'missing') return reply;
    if (opts.allow404) return null;
    throw new HttpError(404, 'GET /pulls/5 -> 404');
  });
}

async function check(t: TestContext, fake: FakeGitHub, text: string, samePatch: boolean) {
  const run = await loadRun();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  try {
    return await run(new GitHub(fake, 'o/r'), inputFile(text), () => samePatch);
  } finally {
    t.mock.restoreAll();
  }
}

test('runJudgeRoutineCheck：壊れた JSON・closed・merged・404・head も patch-id も違う、は skip と理由を返し、GitHub に書き込まない', async (t) => {
  const cases: { name: string; fake: FakeGitHub; text: string }[] = [
    { name: '壊れた JSON', fake: world(pr()), text: BROKEN[0]! },
    { name: 'closed', fake: world(pr({ state: 'closed' })), text: inputText() },
    { name: 'merged', fake: world(pr({ state: 'closed', merged: true })), text: inputText() },
    { name: 'PR が無い（404）', fake: world('missing'), text: inputText() },
    { name: 'head も patch-id も違う', fake: world(pr()), text: inputText({ head: OTHER }) },
  ];
  for (const c of cases) {
    const r = await check(t, c.fake, c.text, false);
    assert.equal(r.action, 'skip', c.name);
    if (r.action === 'skip') assert.ok(r.reason.length > 0, `${c.name}: 理由が空`);
    assert.deepEqual(c.fake.writes(), [], c.name);
    assert.ok(c.fake.calls.every((x) => x.method === 'GET' && x.path !== '/graphql'), `${c.name}: GET /pulls 以外を呼んだ: ${JSON.stringify(c.fake.calls)}`);
  }
});

test('runJudgeRoutineCheck：open の PR で head が同じなら judge（dryRun を引き継ぐ）', async (t) => {
  const fake = world(pr());
  const r = await check(t, fake, inputText({ dryRun: true }), false);
  assert.deepEqual(r, { action: 'judge', pr: 5, head: HEAD, inputHead: HEAD, dryRun: true });
  assert.deepEqual(fake.writes(), []);
});
