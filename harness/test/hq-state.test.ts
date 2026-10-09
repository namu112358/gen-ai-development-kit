// Issue #409：hq の控え（hq-fleets.json）と、hq がいない間の fleet の質問の控え（pending）の置き場所・読み方・足し方と、
// CLI（harness/scripts/hq-state.ts）の往復（ledger-save → ledger、pending-add → pending → pending-answer → pending --all → pending-remove）を確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HQ_STATE_COMMANDS, addPending, answerPending, hqStateDir, ledgerPath, parseLedger, parsePending, pendingPath, removePending, renderPending,
  type PendingFile,
} from '../scripts/hq-state.ts';

const root = join(import.meta.dirname, '..', '..');
const NOW = '2026-09-30T00:00:00.000Z';
const LATER = '2026-09-30T00:05:00.000Z';

const q = (issue: number, patch: Partial<{ stage: string; question: string; options: string[]; messageId: string | null }> = {}) => ({
  issue, stage: 'plan', question: `#${issue} の質問`, options: ['進める', 'やめる'], messageId: null, ...patch,
});

// ---- 定数・置き場所 ----

test('HQ_STATE_COMMANDS：CLI のコマンドの一覧', () => {
  assert.deepEqual([...HQ_STATE_COMMANDS], ['path', 'ledger', 'ledger-save', 'pending', 'pending-add', 'pending-answer', 'pending-remove', 'heartbeat-save']);
});

test('hqStateDir・ledgerPath・pendingPath：git の共通ディレクトリの agent-harness/hq の下', () => {
  const common = join('x', '.git');
  assert.equal(hqStateDir(common), join(common, 'agent-harness', 'hq'));
  assert.equal(ledgerPath(common), join(common, 'agent-harness', 'hq', 'hq-fleets.json'));
  assert.equal(pendingPath(common, 'sess-1_A'), join(common, 'agent-harness', 'hq', 'pending', 'sess-1_A.json'));
});

test('pendingPath：セッション ID が英数字・_・- でなければ throw（パスの外に書かない）', () => {
  for (const bad of ['', '../x', 'a/b', 'a b', 'a.b', 'a\\b']) {
    assert.throws(() => pendingPath('c', bad), Error, JSON.stringify(bad));
  }
});

// ---- parseLedger ----

const ledger = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1, runId: 'run-1', hqHandle: 'term-hq', hqSession: 'sess-hq', paneHandles: ['p1'], fleets: [{ session: 'sess-1' }], updatedAt: NOW, ...patch,
});

test('parseLedger：正しい形は読み、ほかのキーは残し、updatedAt が無ければ null', () => {
  const v = parseLedger(ledger({ extra: 'x' }));
  assert.ok(v);
  assert.equal(v.runId, 'run-1');
  assert.equal(v.hqHandle, 'term-hq');
  assert.equal(v.hqSession, 'sess-hq');
  assert.deepEqual(v.paneHandles, ['p1']);
  assert.deepEqual(v.fleets, [{ session: 'sess-1' }]);
  assert.equal(v.extra, 'x');
  const noUpdated = ledger();
  delete noUpdated.updatedAt;
  assert.equal(parseLedger(noUpdated)?.updatedAt, null);
  assert.ok(parseLedger(ledger({ runId: null, hqHandle: null, hqSession: null, paneHandles: [], fleets: [] })));
});

test('parseLedger：形が違えば null', () => {
  const bad: unknown[] = [
    null, 'x', 1, [], ledger({ version: 2 }), ledger({ runId: 1 }), ledger({ hqHandle: {} }), ledger({ hqSession: 3 }),
    ledger({ paneHandles: 'p1' }), ledger({ paneHandles: [1] }), ledger({ fleets: {} }), ledger({ fleets: ['x'] }), ledger({ fleets: [null] }),
  ];
  for (const b of bad) assert.equal(parseLedger(b), null, JSON.stringify(b));
});

// ---- pending ----

test('addPending：無い控えから作り、同じ issue は置き換えて答えを null に戻し、引数を変えない', () => {
  const a = addPending(null, 'sess-1', q(1, { messageId: 'm1' }), NOW);
  assert.equal(a.version, 1);
  assert.equal(a.session, 'sess-1');
  assert.deepEqual(a.questions, [{ issue: 1, stage: 'plan', question: '#1 の質問', options: ['進める', 'やめる'], messageId: 'm1', askedAt: NOW, answer: null, answeredAt: null }]);
  const b = addPending(a, 'sess-1', q(2), NOW);
  assert.deepEqual(b.questions.map((x) => x.issue), [1, 2]);
  assert.equal(a.questions.length, 1, '引数を変えない');
  const answered = answerPending(b, 1, '進める', LATER);
  const replaced = addPending(answered, 'sess-1', q(1, { question: '聞き直し' }), LATER);
  const one = replaced.questions.filter((x) => x.issue === 1);
  assert.equal(one.length, 1, '同じ issue は1つだけ');
  assert.equal(one[0]!.question, '聞き直し');
  assert.equal(one[0]!.answer, null);
  assert.equal(one[0]!.answeredAt, null);
  assert.equal(answered.questions.find((x) => x.issue === 1)!.answer, '進める', '引数を変えない');
});

test('answerPending：答えと時刻を入れ、無い issue は throw', () => {
  const a = addPending(null, 'sess-1', q(1), NOW);
  const b = answerPending(a, 1, 'やめる', LATER);
  assert.equal(b.questions[0]!.answer, 'やめる');
  assert.equal(b.questions[0]!.answeredAt, LATER);
  assert.equal(a.questions[0]!.answer, null, '引数を変えない');
  assert.throws(() => answerPending(a, 9, 'x', LATER));
  assert.throws(() => answerPending(null, 1, 'x', LATER));
});

test('removePending：その issue を外し、無ければそのまま', () => {
  const a = addPending(addPending(null, 'sess-1', q(1), NOW), 'sess-1', q(2), NOW);
  assert.deepEqual(removePending(a, 'sess-1', 1).questions.map((x) => x.issue), [2]);
  assert.deepEqual(removePending(a, 'sess-1', 9).questions.map((x) => x.issue), [1, 2]);
  assert.equal(a.questions.length, 2, '引数を変えない');
  assert.deepEqual(removePending(null, 'sess-1', 1).questions, []);
});

test('parsePending：addPending の結果は読め、形が違えば null', () => {
  const a = answerPending(addPending(null, 'sess-1', q(1), NOW), 1, '進める', LATER);
  assert.deepEqual(parsePending(JSON.parse(JSON.stringify(a))), a);
  const bad: unknown[] = [
    null, 'x', [], { version: 2, session: 's', questions: [] }, { version: 1, session: 1, questions: [] }, { version: 1, session: 's', questions: {} },
    { version: 1, session: 's', questions: [{ issue: 'x' }] },
  ];
  for (const b of bad) assert.equal(parsePending(b), null, JSON.stringify(b));
});

test('renderPending：答えの無い質問が無ければ空', () => {
  assert.deepEqual(renderPending(null), []);
  assert.deepEqual(renderPending({ version: 1, session: 's', questions: [] }), []);
  assert.deepEqual(renderPending(answerPending(addPending(null, 's', q(1), NOW), 1, '進める', LATER)), []);
});

test('renderPending：見出し、#番号・段階・質問、選択肢（先頭に「（おすすめ）」）を出し、答え済みは出さない', () => {
  let f: PendingFile = addPending(null, 's', q(409, { stage: 'plan-critique', question: '進めてよいか', options: ['進める', '直す', 'やめる'] }), NOW);
  f = answerPending(addPending(f, 's', q(500, { question: '答え済みの質問' }), NOW), 500, '進める', LATER);
  const lines = renderPending(f);
  assert.ok(lines[0]!.includes('hq がいない間の質問（fleet のタブで答える）'), lines[0]);
  const text = lines.join('\n');
  const head = lines.find((l) => l.includes('#409'));
  assert.ok(head, '#409 の行がありません');
  assert.ok(head.includes('plan-critique') && head.includes('進めてよいか'), head);
  assert.ok(lines.some((l) => l.includes('（おすすめ）') && l.includes('進める')), '先頭の選択肢に（おすすめ）がありません');
  for (const o of ['直す', 'やめる']) assert.ok(text.includes(o), o);
  assert.ok(!text.includes('#500') && !text.includes('答え済みの質問'), '答え済みの質問は出さない');
});

// ---- CLI ----

const cli = (dir: string, args: string[]) =>
  spawnSync(process.execPath, ['harness/scripts/hq-state.ts', args[0]!, '--common-dir', dir, ...args.slice(1)], { cwd: root, encoding: 'utf8' });
const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-state-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('CLI path：dir・ledger・pendingDir を JSON で出す', () => withDir((dir) => {
  const r = cli(dir, ['path']);
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.dir, hqStateDir(dir));
  assert.equal(v.ledger, ledgerPath(dir));
  assert.equal(v.pendingDir, join(hqStateDir(dir), 'pending'));
}));

test('CLI ledger：無い・壊れていれば null（終了コード 0）', () => withDir((dir) => {
  const r = cli(dir, ['ledger']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), null);
  mkdirSync(hqStateDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), '{壊れた');
  const broken = cli(dir, ['ledger']);
  assert.equal(broken.status, 0, broken.stderr);
  assert.equal(JSON.parse(broken.stdout), null);
}));

test('CLI ledger-save → ledger：updatedAt を今にして書き、読み直せる', () => withDir((dir) => {
  const src = join(dir, 'in.json');
  writeFileSync(src, JSON.stringify(ledger({ updatedAt: null, extra: 'x' })));
  const before = Date.now();
  const saved = cli(dir, ['ledger-save', src]);
  assert.equal(saved.status, 0, saved.stderr);
  const out = JSON.parse(saved.stdout);
  assert.equal(out.runId, 'run-1');
  assert.ok(typeof out.updatedAt === 'string' && Date.parse(out.updatedAt) >= before - 1000, String(out.updatedAt));
  assert.ok(existsSync(ledgerPath(dir)));
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath(dir), 'utf8')), out);
  const read = cli(dir, ['ledger']);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), out);
  assert.equal(JSON.parse(read.stdout).extra, 'x');
}));

test('CLI ledger-save：壊れた・形の違う JSON は終了コード 1 で書かない', () => withDir((dir) => {
  const src = join(dir, 'in.json');
  writeFileSync(src, JSON.stringify(ledger({ version: 2 })));
  const r = cli(dir, ['ledger-save', src]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.trim() !== '', '標準エラーに理由がありません');
  writeFileSync(src, '{壊れた');
  assert.equal(cli(dir, ['ledger-save', src]).status, 1);
  assert.ok(!existsSync(ledgerPath(dir)), '書かない');
}));

test('CLI pending：add → pending → answer → pending --all → remove の往復', () => withDir((dir) => {
  assert.equal(JSON.parse(cli(dir, ['pending', '--session', 'sess-1']).stdout), null);
  assert.deepEqual(JSON.parse(cli(dir, ['pending', '--all']).stdout), []);

  const added = cli(dir, ['pending-add', '--session', 'sess-1', '--issue', '409', '--stage', 'plan', '--question', '進めてよいか', '--option', '進める', '--option', 'やめる', '--message-id', 'm1']);
  assert.equal(added.status, 0, added.stderr);
  const a = JSON.parse(added.stdout);
  assert.equal(a.session, 'sess-1');
  assert.equal(a.questions[0].issue, 409);
  assert.deepEqual(a.questions[0].options, ['進める', 'やめる']);
  assert.equal(a.questions[0].messageId, 'm1');
  assert.ok(existsSync(pendingPath(dir, 'sess-1')));

  const got = cli(dir, ['pending', '--session', 'sess-1']);
  assert.equal(got.status, 0, got.stderr);
  assert.deepEqual(JSON.parse(got.stdout), a);

  const ans = cli(dir, ['pending-answer', '--session', 'sess-1', '--issue', '409', '--answer', '進める']);
  assert.equal(ans.status, 0, ans.stderr);
  assert.equal(JSON.parse(ans.stdout).questions[0].answer, '進める');

  cli(dir, ['pending-add', '--session', 'sess-2', '--issue', '5', '--stage', 'judge', '--question', 'q', '--option', 'o']);
  const all = cli(dir, ['pending', '--all']);
  assert.equal(all.status, 0, all.stderr);
  const list = JSON.parse(all.stdout) as PendingFile[];
  assert.deepEqual(list.map((x) => x.session).sort(), ['sess-1', 'sess-2']);
  assert.equal(list.find((x) => x.session === 'sess-1')!.questions[0]!.answer, '進める');

  const rm = cli(dir, ['pending-remove', '--session', 'sess-1', '--issue', '409']);
  assert.equal(rm.status, 0, rm.stderr);
  assert.deepEqual(JSON.parse(cli(dir, ['pending', '--session', 'sess-1']).stdout).questions, []);
}));

test('CLI：引数の誤りは終了コード 0 にならない', () => withDir((dir) => {
  const cases: string[][] = [
    ['pending-add', '--session', 's', '--issue', '1', '--stage', 'plan', '--question', 'q'], // --option が無い
    ['pending-add', '--session', 's', '--issue', 'x', '--stage', 'plan', '--question', 'q', '--option', 'o'], // issue が整数でない
    ['pending-add', '--session', '../s', '--issue', '1', '--stage', 'plan', '--question', 'q', '--option', 'o'], // session の形
    ['pending-answer', '--session', 's', '--issue', '9', '--answer', 'a'], // 無い質問
    ['pending'], // --session も --all も無い
    ['ledger-save'], // ファイルが無い
    ['no-such-command'],
  ];
  for (const c of cases) {
    const r = cli(dir, c);
    assert.ok(r.status !== 0 && r.status !== null, `${c.join(' ')}：終了コード ${r.status}`);
  }
}));
