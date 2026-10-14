// Issue #1097：判定の Routine の skip の条件と、判定の routine の印。
// (1) 純粋関数の表：checkJudgeRoutineInput は Draft でない PR を skip（not-draft）。judgedSkip は最新の判定の head が今の head と同じ・
//     patch-id が同じなら skip（already-judged）、判定が無い・patch-id が違えば null。checkoutDecision は HEAD が既定ブランチの祖先でない・
//     PR の head と同じなら skip（head-checkout）、どちらでもなければ null。skip の理由は「識別子: 説明」の形。
// (2) runJudgeRoutineCheck（入力あり）で、git の確かめが祖先でないと返せば skip（head-checkout）になり、GitHub に書き込まない（配線の確かめ。
//     not-draft・already-judged の配線は (1) と judge-routine-input.test.ts の judge の 1 件に任せる）。
// (3) judgedByFor：routine＋URL は routine:<URL>、routine＋URL 無しは routine、引数無しは今のまま（URL か「付き添いのセッション」）。
//     parseComposeArgs は --judged-by routine を受け、--judged-by x・値の欠けを誤りにし、無ければ judgedBy の欄が無い。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GitHub } from '../lib/github.ts';
import { checkJudgeRoutineInput, checkoutDecision, judgedSkip, type JudgeRoutineDecision, type JudgeRoutineInput } from '../lib/judge-routine.ts';
import { judgedByFor, parseComposeArgs } from '../lib/session-inputs.ts';
import { FakeGitHub, HEAD, pr } from './support/gate-fixtures.ts';

const OTHER = 'c'.repeat(40);
const CHECKOUT = 'd'.repeat(40);
const INPUT: JudgeRoutineInput = { pr: 5, head: HEAD, base: 'main', dryRun: false };
const openPr = { state: 'open', merged: false, headSha: HEAD, baseRef: 'main', draft: true };

// --- (1) 純粋関数の表 ---

test('not-draft・already-judged・head-checkout：skip の条件に当たれば「識別子: 説明」の理由、当たらなければ null（judge）', () => {
  const cases: { name: string; got: JudgeRoutineDecision | null; want: string | null }[] = [
    { name: 'Draft でない PR', got: checkJudgeRoutineInput(INPUT, { ...openPr, draft: false }, () => true), want: 'not-draft' },
    { name: 'Draft なら今どおり judge', got: checkJudgeRoutineInput(INPUT, openPr, () => false), want: null },
    { name: '最新の判定の head が今の head と同じ', got: judgedSkip(HEAD, HEAD, () => false), want: 'already-judged' },
    { name: '最新の判定と patch-id が同じ', got: judgedSkip(HEAD, OTHER, () => true), want: 'already-judged' },
    { name: '最新の判定と head も patch-id も違う', got: judgedSkip(HEAD, OTHER, () => false), want: null },
    { name: '判定が無い', got: judgedSkip(HEAD, null, () => true), want: null },
    { name: 'HEAD が既定ブランチの祖先でない', got: checkoutDecision({ headIsAncestorOfDefault: false, checkoutHead: CHECKOUT, prHead: HEAD }), want: 'head-checkout' },
    { name: 'HEAD が PR の head と同じ', got: checkoutDecision({ headIsAncestorOfDefault: true, checkoutHead: HEAD, prHead: HEAD }), want: 'head-checkout' },
    { name: 'HEAD が既定ブランチの祖先で PR の head と違う', got: checkoutDecision({ headIsAncestorOfDefault: true, checkoutHead: CHECKOUT, prHead: HEAD }), want: null },
  ];
  for (const c of cases) {
    if (c.want === null) {
      assert.ok(c.got === null || c.got.action === 'judge', `${c.name}: skip になった（${JSON.stringify(c.got)}）`);
      continue;
    }
    assert.equal(c.got?.action, 'skip', c.name);
    if (c.got?.action === 'skip') assert.ok(c.got.reason.startsWith(`${c.want}: `) && c.got.reason.length > c.want.length + 2, `${c.name}: 理由が「${c.want}: 説明」でない: ${c.got.reason}`);
  }
});

// --- (2) コマンドの配線（head-checkout） ---

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

test('runJudgeRoutineCheck：入力があっても、checkout の HEAD が既定ブランチの祖先でなければ skip（head-checkout）で書き込まない', async (t) => {
  const run = (await import('../scripts/agent/commands/judge-routine.ts')).runJudgeRoutineCheck;
  const d = mkdtempSync(join(tmpdir(), 'judge-routine-skip-'));
  tmpDirs.push(d);
  const file = join(d, 'input.txt');
  writeFileSync(file, JSON.stringify({ pr: 5, head: HEAD, base: 'main' }));
  const fake = new FakeGitHub().on('GET', /\/pulls\/5$/, () => pr()).on('GET', /\/issues\/5\/comments/, () => []);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  let r: JudgeRoutineDecision;
  try {
    const git = { fetchUnshallow: () => {}, headSha: () => CHECKOUT, isAncestorOfDefault: () => false };
    r = await run(new GitHub(fake, 'o/r'), file, { samePatch: () => false, git, age: { now: new Date(), humanClaimStaleHours: 24, routineClaimTakeoverMinutes: 60 }, defaultBranch: 'main' });
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(r.action, 'skip');
  if (r.action === 'skip') assert.ok(r.reason.startsWith('head-checkout: '), r.reason);
  assert.deepEqual(fake.writes(), []);
});

// --- (3) 判定の印 ---

const URL = 'https://claude.ai/code/session_01ABCDEFGHxyz';
const BASE = ['5', 'r.json', 'k.json', '--judge-input', 'in.txt'];

test('judgedByFor：routine＋URL は routine:<URL>、routine＋URL 無しは routine、引数無しは今のまま', () => {
  const cases: [string, 'routine' | undefined, string | null, string][] = [
    ['routine＋URL', 'routine', URL, `routine:${URL}`],
    ['routine＋URL 無し', 'routine', null, 'routine'],
    ['引数無し＋URL', undefined, URL, URL],
    ['引数無し＋URL 無し', undefined, null, '付き添いのセッション'],
  ];
  for (const [name, judgedBy, url, want] of cases) assert.equal(judgedByFor(judgedBy, url), want, name);
});

test('parseComposeArgs：--judged-by routine を受け、routine 以外・値の欠けは誤り、無ければ judgedBy の欄が無い', () => {
  const ok = parseComposeArgs([...BASE, '--judged-by', 'routine']);
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.join(' / '));
  assert.equal(ok.value.judgedBy, 'routine');
  for (const [name, extra] of [['routine 以外', ['--judged-by', 'x']], ['大文字', ['--judged-by', 'Routine']], ['値の欠け', ['--judged-by']]] as [string, string[]][]) {
    assert.equal(parseComposeArgs([...BASE, ...extra]).ok, false, name);
  }
  const none = parseComposeArgs(BASE);
  assert.ok(none.ok && !('judgedBy' in none.value), 'judgedBy の欄がある');
});
