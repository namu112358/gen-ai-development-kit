// PR を作る前に、手元の変更を計画の files と照らすコマンド（scope-check）の中身を確かめる（Issue #290・#300）。
// 終了コードは 0（両方の照合に計画があり範囲の外が無い）・1（範囲の外がある）・3（外は無いが照合できる計画が無い）で、2 は使わない。
// 照合は App の範囲照合と同じ関数（issuePlannedFiles・issueDelegateFiles と checkScope）で行い、
// 手元の変更の集め方（localChangedFiles）は merge-base からの差分と未追跡のファイルを拾う。
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { GitHub } from '../lib/github.ts';
import { checkScope } from '../lib/scope.ts';
import { localChangedFiles, scopeCheck } from '../lib/scope-check.ts';
import { issueDelegateFiles, issuePlannedFiles, plannedFilesForDelegate, plannedFilesForPr } from '../lib/state.ts';
import { APP, config, FakeGitHub, pr } from './support/gate-fixtures.ts';
import { sandbox } from './support/git-sandbox.ts';

const ISSUE = 290;
const PLANNED = ['harness/lib/scope-check.ts', 'harness/lib/state.ts', 'docs/**'];
const GATE_MISSING = `#${ISSUE} に計画ゲートを通過した計画がありません`;
const DELEGATE_MISSING = `#${ISSUE} に委任承認で照合できる計画がありません（ゲートを通ったか、ゲートの停止で止まった計画だけを使う）`;

let nextId = 100;

/** App の plan-gate 記録コメント（agent-app ブロック） */
function gateRecord(record: { pass: boolean; planReviewOrigin?: 'gate' | 'planner'; files?: string[] | null }) {
  const id = nextId++;
  const value: Record<string, unknown> = { version: 1, planCommentId: 80, pass: record.pass, reasons: record.pass ? [] : ['止めた理由'] };
  if (record.planReviewOrigin) value.planReviewOrigin = record.planReviewOrigin;
  if (record.files !== null) value.plan = { files: record.files ?? PLANNED };
  return {
    id, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: `u${id}`, author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark('plan-gate')}\n${record.pass ? '通過' : '停止'}\n${renderBlock('agent-app', value)}`,
  };
}

/** Issue #290 のコメントだけを返す偽の GitHub（書き込みは経路が無いので、呼べば unrouted で落ちる） */
function issueFake(comments: unknown[]): FakeGitHub {
  return new FakeGitHub().on('GET', new RegExp(`/issues/${ISSUE}/comments`), () => comments);
}

function run(comments: unknown[], files: { changed: string[]; untracked: string[] }) {
  const fake = issueFake(comments);
  return { fake, report: scopeCheck(new GitHub(fake, 'o/r'), config, ISSUE, files) };
}

// --- scopeCheck ---

test('範囲内: ゲートを通った計画の files に収まる変更は ok で終了コード 0', async () => {
  const { fake, report } = run([gateRecord({ pass: true })], { changed: ['harness/lib/state.ts', 'docs/a.md'], untracked: ['harness/lib/scope-check.ts'] });
  const r = await report;
  assert.equal(r.issue, ISSUE);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.scope, { ok: true, outside: [] });
  assert.deepEqual(r.delegate, { usable: true, ok: true, outside: [] });
  assert.deepEqual(r.changed, ['docs/a.md', 'harness/lib/scope-check.ts', 'harness/lib/state.ts'], 'changed は追跡・未追跡を合わせてソートしたもの');
  assert.deepEqual(r.untracked, ['harness/lib/scope-check.ts']);
  assert.deepEqual(r.problems, [], '問題は無い');
  assert.deepEqual(fake.writes(), [], 'GitHub には書き込まない');
  assert.ok(fake.calls.every((c) => c.method === 'GET'), 'GET だけを呼ぶ');
});

test('範囲外: 計画の外のファイル（未追跡のファイルも）を outside に出し、終了コード 1', async () => {
  const { fake, report } = run([gateRecord({ pass: true })], { changed: ['harness/lib/state.ts', 'harness/gates/run.ts'], untracked: ['notes.txt'] });
  const r = await report;
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.scope, { ok: false, outside: ['harness/gates/run.ts', 'notes.txt'] });
  assert.deepEqual(r.delegate, { usable: true, ok: false, outside: ['harness/gates/run.ts', 'notes.txt'] });
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'outside', files: ['harness/gates/run.ts', 'notes.txt'] },
    { check: 'delegate', kind: 'outside', files: ['harness/gates/run.ts', 'notes.txt'] },
  ]);
  assert.deepEqual(fake.writes(), []);
});

test('範囲外: 未追跡のファイルだけが外れていても 0 以外で終わる', async () => {
  const r = await run([gateRecord({ pass: true })], { changed: ['docs/a.md'], untracked: ['scratch.ts'] }).report;
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.delegate, { usable: true, ok: false, outside: ['scratch.ts'] });
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'outside', files: ['scratch.ts'] },
    { check: 'delegate', kind: 'outside', files: ['scratch.ts'] },
  ]);
});

test('Planner の申告で止まった計画: 照合できる計画が無いことを出し、最新の計画に照らした範囲の外も出す', async () => {
  const comments = [gateRecord({ pass: true }), gateRecord({ pass: false, planReviewOrigin: 'planner', files: ['docs/**'] })];
  const { fake, report } = run(comments, { changed: ['docs/a.md', 'harness/lib/state.ts'], untracked: [] });
  const r = await report;
  assert.deepEqual(r.scope, { missing: GATE_MISSING }, '最新の記録（停止）で判断する');
  assert.deepEqual(r.delegate, { usable: false, reason: DELEGATE_MISSING, latestPlanOutside: ['harness/lib/state.ts'] });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1, '範囲の外があれば、計画が無くても終了コード 1');
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'no-plan', reason: GATE_MISSING },
    { check: 'delegate', kind: 'no-plan', reason: DELEGATE_MISSING },
    { check: 'delegate', kind: 'outside', files: ['harness/lib/state.ts'] },
  ], 'scope → delegate の順、各照合の中は no-plan → outside');
  assert.deepEqual(fake.writes(), []);
});

test('Planner の申告で止まった計画: 範囲に収まっていれば、照合できる計画が無いことを終了コード 3 で示す', async () => {
  const r = await run([gateRecord({ pass: false, planReviewOrigin: 'planner' })], { changed: ['docs/a.md'], untracked: [] }).report;
  assert.deepEqual(r.delegate, { usable: false, reason: DELEGATE_MISSING, latestPlanOutside: [] });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'no-plan', reason: GATE_MISSING },
    { check: 'delegate', kind: 'no-plan', reason: DELEGATE_MISSING },
  ], 'latestPlanOutside が空なら delegate の outside は出さない');
});

test('出どころの欄が無い古い停止の記録は、委任承認で照合できない（範囲内なら終了コード 3）', async () => {
  const r = await run([gateRecord({ pass: false })], { changed: ['docs/a.md'], untracked: [] }).report;
  assert.deepEqual(r.scope, { missing: GATE_MISSING });
  assert.equal(r.delegate.usable, false);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'no-plan', reason: GATE_MISSING },
    { check: 'delegate', kind: 'no-plan', reason: DELEGATE_MISSING },
  ]);
});

test('計画ゲートの記録が無い: 照合できないことを出し、latestPlanOutside は null', async () => {
  const humanComment = { id: 1, created_at: '', updated_at: '', html_url: 'h', author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: 'こんにちは' };
  const r = await run([humanComment], { changed: ['docs/a.md'], untracked: [] }).report;
  assert.deepEqual(r.scope, { missing: GATE_MISSING });
  assert.deepEqual(r.delegate, { usable: false, reason: DELEGATE_MISSING, latestPlanOutside: null });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'no-plan', reason: GATE_MISSING },
    { check: 'delegate', kind: 'no-plan', reason: DELEGATE_MISSING },
  ], 'latestPlanOutside が null でも delegate の no-plan を出す');
});

test('App 以外が書いた plan-gate の記録は使わない', async () => {
  const forged = { ...gateRecord({ pass: true }), author_association: 'OWNER', user: { login: 'me', type: 'User' } };
  const r = await run([forged], { changed: ['docs/a.md'], untracked: [] }).report;
  assert.deepEqual(r.scope, { missing: GATE_MISSING });
  assert.deepEqual(r.delegate, { usable: false, reason: DELEGATE_MISSING, latestPlanOutside: null });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'no-plan', reason: GATE_MISSING },
    { check: 'delegate', kind: 'no-plan', reason: DELEGATE_MISSING },
  ]);
});

test('ゲートの停止（planReviewOrigin: gate）で止まった計画: 委任承認の照合には使えるが、agent/scope では計画なしなので終了コード 3', async () => {
  const r = await run([gateRecord({ pass: false, planReviewOrigin: 'gate' })], { changed: ['docs/a.md', 'harness/lib/state.ts'], untracked: [] }).report;
  assert.deepEqual(r.scope, { missing: GATE_MISSING });
  assert.deepEqual(r.delegate, { usable: true, ok: true, outside: [] });
  assert.equal(r.ok, false, 'agent/scope で計画なしになるので ok ではない');
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.problems, [{ check: 'scope', kind: 'no-plan', reason: GATE_MISSING }], 'delegate は使えるので scope の no-plan だけ');
});

test('ゲートの停止で止まった計画でも、範囲の外があれば終了コード 1', async () => {
  const r = await run([gateRecord({ pass: false, planReviewOrigin: 'gate' })], { changed: ['README.md'], untracked: [] }).report;
  assert.deepEqual(r.delegate, { usable: true, ok: false, outside: ['README.md'] });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'no-plan', reason: GATE_MISSING },
    { check: 'delegate', kind: 'outside', files: ['README.md'] },
  ]);
});

test('終了コードは 0・1・3 のどれかで、2（引数・git のエラーの fail()）にはならない', async () => {
  const human = { id: 2, created_at: '', updated_at: '', html_url: 'h', author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: 'x' };
  const cases: [unknown[], { changed: string[]; untracked: string[] }, number][] = [
    [[gateRecord({ pass: true })], { changed: ['docs/a.md'], untracked: [] }, 0],
    [[gateRecord({ pass: true })], { changed: [], untracked: [] }, 0],
    [[gateRecord({ pass: true })], { changed: ['x.ts'], untracked: [] }, 1],
    [[gateRecord({ pass: false, planReviewOrigin: 'gate' })], { changed: ['docs/a.md'], untracked: [] }, 3],
    [[gateRecord({ pass: false, planReviewOrigin: 'gate' })], { changed: ['x.ts'], untracked: [] }, 1],
    [[gateRecord({ pass: false, planReviewOrigin: 'planner' })], { changed: [], untracked: [] }, 3],
    [[gateRecord({ pass: false, planReviewOrigin: 'planner' })], { changed: [], untracked: ['x.ts'] }, 1],
    [[human], { changed: ['x.ts'], untracked: [] }, 3],
    [[], { changed: [], untracked: [] }, 3],
  ];
  for (const [comments, files, want] of cases) {
    const r = await run(comments, files).report;
    assert.ok([0, 1, 3].includes(r.exitCode), `終了コードは 0・1・3 のどれか（${r.exitCode}）`);
    assert.notEqual(r.exitCode, 2);
    assert.equal(r.exitCode, want, JSON.stringify(files));
    assert.equal(r.ok, r.exitCode === 0, 'ok は終了コード 0 のときだけ true');
    assert.equal(r.problems.length === 0, r.exitCode === 0, 'problems が空なのは終了コード 0 のときだけ');
    assert.equal(r.problems.some((p) => p.kind === 'outside'), r.exitCode === 1, 'outside があるのは終了コード 1 のときだけ');
  }
});

// --- App の範囲照合と同じ関数 ---

/** PR #5 が Issue #290 を Closes する形の偽の GitHub */
function prFake(comments: unknown[]): FakeGitHub {
  return issueFake(comments).on('POST', /\/graphql/, (_m, body) => {
    if (String(body.query).includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: ISSUE, repository: { nameWithOwner: 'o/r' } }] } } } } };
    return { data: {} };
  });
}

const CASES: [string, unknown[]][] = [
  ['通過', [gateRecord({ pass: true })]],
  ['Planner の停止', [gateRecord({ pass: false, planReviewOrigin: 'planner' })]],
  ['ゲートの停止', [gateRecord({ pass: false, planReviewOrigin: 'gate', files: ['docs/**'] })]],
  ['記録なし', []],
];

for (const [name, comments] of CASES) {
  test(`同じ関数（${name}）: issuePlannedFiles・issueDelegateFiles は PR 経由の plannedFilesForPr・plannedFilesForDelegate と同じ結果`, async () => {
    const thePr = pr({ number: 5, body: `Closes #${ISSUE}` });
    const viaPr = new GitHub(prFake(comments), 'o/r');
    const direct = new GitHub(issueFake(comments), 'o/r');
    assert.deepEqual(await issuePlannedFiles(direct, config, ISSUE), await plannedFilesForPr(viaPr, config, thePr));
    assert.deepEqual(await issueDelegateFiles(direct, config, ISSUE), await plannedFilesForDelegate(viaPr, config, thePr));
  });

  test(`同じ関数（${name}）: scopeCheck の scope・delegate は issuePlannedFiles・issueDelegateFiles と checkScope の組み合わせと一致する`, async () => {
    const files = { changed: ['docs/a.md', 'harness/lib/state.ts'], untracked: ['x.txt'] };
    const all = [...files.changed, ...files.untracked];
    const gh = new GitHub(issueFake(comments), 'o/r');
    const r = await scopeCheck(gh, config, ISSUE, files);
    const planned = await issuePlannedFiles(gh, config, ISSUE);
    assert.deepEqual(r.scope, 'files' in planned ? checkScope(planned.files, all) : { missing: planned.missing });
    const delegate = await issueDelegateFiles(gh, config, ISSUE);
    if ('files' in delegate) {
      assert.deepEqual(r.delegate, { usable: true, ...checkScope(delegate.files, all) });
    } else {
      assert.equal(r.delegate.usable, false);
      assert.equal(r.delegate.usable === false && r.delegate.reason, delegate.missing);
    }
  });
}

// --- localChangedFiles ---

test('localChangedFiles: commit 済み・未 commit・未追跡・リネーム（旧・新の両方）を拾い、main 側で後から進んだ変更は入れない', () => {
  const sb = sandbox();
  try {
    const { root, seed, git, commit } = sb;
    // main に r.txt を足してから作業のブランチを切る（merge-base に a.txt・r.txt がある）
    commit(root, 'r.txt');
    git(root, 'push', '-q', 'origin', 'main');
    git(root, 'checkout', '-qb', 'claude/issue-290-x');
    commit(root, 'b.txt'); // commit 済みの追加
    git(root, 'mv', 'r.txt', 's.txt');
    git(root, 'commit', '-qm', 'rename'); // commit 済みのリネーム
    writeFileSync(join(root, 'a.txt'), 'changed\n'); // 未 commit の変更
    writeFileSync(join(root, 'u.txt'), 'u\n'); // 未追跡
    writeFileSync(join(root, 'ignored.txt'), 'i\n'); // 無視するファイル
    appendFileSync(join(root, '.git', 'info', 'exclude'), '\nignored.txt\n');
    // main 側が後から進む（seed から push して取り込む）
    git(seed, 'pull', '-q', 'origin', 'main');
    commit(seed, 'm.txt');
    git(seed, 'push', '-q', 'origin', 'main');
    git(root, 'fetch', '-q', 'origin');

    const got = localChangedFiles(root, 'origin/main');
    assert.deepEqual(got.changed, ['a.txt', 'b.txt', 'r.txt', 's.txt']);
    assert.deepEqual(got.untracked, ['u.txt']);
  } finally {
    sb.cleanup();
  }
});

test('localChangedFiles: 未 commit のリネーム（git mv だけ）も旧・新の両方を拾う', () => {
  const sb = sandbox();
  try {
    const { root, git } = sb;
    git(root, 'checkout', '-qb', 'claude/issue-290-y');
    git(root, 'mv', 'a.txt', 'z.txt');
    const got = localChangedFiles(root, 'origin/main');
    assert.deepEqual(got.changed, ['a.txt', 'z.txt']);
    assert.deepEqual(got.untracked, []);
  } finally {
    sb.cleanup();
  }
});

test('localChangedFiles: 変更が無ければどちらも空', () => {
  const sb = sandbox();
  try {
    assert.deepEqual(localChangedFiles(sb.root, 'origin/main'), { changed: [], untracked: [] });
  } finally {
    sb.cleanup();
  }
});

test('localChangedFiles: worktree のサブディレクトリから呼んでも、ルートからのパスで、サブディレクトリの外の未追跡のファイルも拾う', () => {
  const sb = sandbox();
  try {
    const { root, git, commit } = sb;
    mkdirSync(join(root, 'sub'));
    commit(root, 'sub/t.txt');
    git(root, 'push', '-q', 'origin', 'main');
    git(root, 'checkout', '-qb', 'claude/issue-300-x');
    commit(root, 'b.txt'); // commit 済みの追加（ルート）
    writeFileSync(join(root, 'sub', 't.txt'), 'changed\n'); // 未 commit の変更（サブディレクトリ）
    writeFileSync(join(root, 'sub', 'n.txt'), 'n\n'); // 未追跡（サブディレクトリ）
    writeFileSync(join(root, 'u.txt'), 'u\n'); // 未追跡（ルート）
    mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'other', 'o.txt'), 'o\n'); // 未追跡（別のディレクトリ）

    const fromSub = localChangedFiles(join(root, 'sub'), 'origin/main');
    assert.deepEqual(fromSub.changed, ['b.txt', 'sub/t.txt']);
    assert.deepEqual(fromSub.untracked, ['other/o.txt', 'sub/n.txt', 'u.txt']);
    assert.deepEqual(fromSub, localChangedFiles(root, 'origin/main'), 'ルートから呼んだときと同じ');
  } finally {
    sb.cleanup();
  }
});

test('scope-check: サブディレクトリで集めた変更でも、計画の files にある未追跡のファイルを範囲内と判定する（終了コード 0）', async () => {
  const sb = sandbox();
  try {
    const { root, git, commit } = sb;
    mkdirSync(join(root, 'sub'));
    commit(root, 'sub/t.txt');
    git(root, 'push', '-q', 'origin', 'main');
    git(root, 'checkout', '-qb', 'claude/issue-300-y');
    writeFileSync(join(root, 'sub', 't.txt'), 'changed\n');
    writeFileSync(join(root, 'sub', 'n.txt'), 'n\n');
    writeFileSync(join(root, 'u.txt'), 'u\n');

    const files = localChangedFiles(join(root, 'sub'), 'origin/main');
    const r = await run([gateRecord({ pass: true, files: ['sub/t.txt', 'sub/n.txt', 'u.txt'] })], files).report;
    assert.deepEqual(r.untracked, ['sub/n.txt', 'u.txt']);
    assert.deepEqual(r.scope, { ok: true, outside: [] });
    assert.deepEqual(r.delegate, { usable: true, ok: true, outside: [] });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
  } finally {
    sb.cleanup();
  }
});

// --- implement の skill ---

test('implement の skill: PR を作る前に scope-check を走らせ、外れていれば AskUserQuestion で聞く', () => {
  const root = join(import.meta.dirname, '..', '..');
  const text = readFileSync(join(root, '.claude/skills/implement/SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const checkLine = lines.findIndex((l) => l.includes('scope-check'));
  const createLine = lines.findIndex((l) => l.includes('gh pr create'));
  assert.ok(checkLine >= 0, 'scope-check の手順がある');
  assert.ok(createLine >= 0, 'gh pr create の手順がある');
  assert.ok(checkLine < createLine, 'scope-check の手順が gh pr create の手順より前にある');
  // scope-check の手順（番号付きの行から、次の番号付きの行の前まで。下の箇条書きも含む）
  const next = lines.findIndex((l, i) => i > checkLine && /^\d+\.\s/.test(l));
  const step = lines.slice(checkLine, next < 0 ? undefined : next).join('\n');
  assert.match(step, /AskUserQuestion/, 'scope-check の手順に、外れたら AskUserQuestion で聞くことが書いてある');
});

/** implement の skill の scope-check の手順（番号付きの行から次の番号付きの行の前まで）の行 */
function scopeCheckStepLines(): string[] {
  const root = join(import.meta.dirname, '..', '..');
  const lines = readFileSync(join(root, '.claude/skills/implement/SKILL.md'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\d+\.\s/.test(l) && l.includes('scope-check'));
  assert.ok(start >= 0, 'scope-check の番号付きの手順がある');
  const next = lines.findIndex((l, i) => i > start && /^\d+\.\s/.test(l));
  return lines.slice(start, next < 0 ? undefined : next);
}

/** 終了コード n に触れている行（「終了コード 1」「終了コード `1`」「終了コードが 1」など） */
function exitCodeLines(lines: string[], n: number): string[] {
  const re = new RegExp(`終了コード[がはの]?\\s*\`?${n}\`?(?!\\d)`);
  return lines.filter((l) => re.test(l));
}

test('implement の skill: scope-check の手順に、終了コード 0・1・3 のそれぞれの扱いが書いてある', () => {
  const lines = scopeCheckStepLines();
  const step = lines.join('\n');
  assert.doesNotMatch(step, /終了コードではなく/, '終了コードで分けないという古い書き方は残さない');
  assert.ok(exitCodeLines(lines, 0).length > 0, '終了コード 0 の扱いが書いてある');
  const one = exitCodeLines(lines, 1);
  assert.ok(one.some((l) => l.includes('AskUserQuestion')), '終了コード 1 は AskUserQuestion で聞く');
  assert.ok(one.some((l) => /PR を作らず/.test(l)), '終了コード 1 は PR を作らない');
  const three = exitCodeLines(lines, 3);
  assert.ok(three.some((l) => l.includes('人に見てほしい点')), '終了コード 3 は PR 本文の「人に見てほしい点」に書く');
  assert.ok(three.some((l) => /聞かずに進め/.test(l)), '終了コード 3 は聞かずに進める');
});

test('implement の skill: scope-check が JSON を出さずに終わったら、PR を作らずに人に返すことが書いてある', () => {
  const lines = scopeCheckStepLines();
  const line = lines.find((l) => l.includes('JSON') && /PR を作らず/.test(l) && /人に返す/.test(l));
  assert.ok(line, 'JSON が出ずに終わったら PR を作らずに人に返す行がある');
});
