// Issue #640：合体版のレビューの⑧（runProjectCheck）が設定の検証コマンド・取り込みのコマンドを動かすこと。
// 別のコマンドなら取り込み → 検証の順でそのコマンドを run し、checkCommand が null なら run を呼ばず通る扱い、installCommand だけ null なら検証だけ、取り込みの失敗は throw。
// composePanel の typecheck-test-failure の detail に、設定の検証コマンドの名前が出ること。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composePanel, runProjectCheck } from '../lib/review-panel.ts';
import { HEAD } from './support/gate-fixtures.ts';

type RunResult = { status: number | null; error?: Error; stdout?: string | null; stderr?: string | null };

/** 呼ばれたコマンドを記録し、コマンドごとに決めた結果を返す偽の run */
function fakeRun(results: Record<string, RunResult> = {}) {
  const calls: string[] = [];
  const run = (command: string): RunResult => {
    calls.push(command);
    return results[command] ?? { status: 0, stdout: 'ok\n', stderr: '' };
  };
  return { calls, run };
}

test('runProjectCheck：別のコマンドを書くと、取り込み → 検証の順でそのコマンドを run し、終了コードと出力を返す', () => {
  const r = fakeRun({ 'pytest -q': { status: 1, stdout: 'collected 3\n', stderr: 'FAILED test_a\n' } });
  const result = runProjectCheck(HEAD, { checkCommand: 'pytest -q', installCommand: 'pip install -e .' }, r.run);
  assert.deepEqual(r.calls, ['pip install -e .', 'pytest -q']);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.exitCode, 1);
  assert.equal(result.command, 'pytest -q');
  assert.ok(result.outputTail.includes('FAILED test_a'), result.outputTail);
});

test('runProjectCheck：checkCommand が null なら run を呼ばず exitCode 0・command null', () => {
  const r = fakeRun();
  const result = runProjectCheck(HEAD, { checkCommand: null, installCommand: null }, r.run);
  assert.deepEqual(r.calls, []);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.exitCode, 0);
  assert.equal(result.command, null);
});

test('runProjectCheck：installCommand だけ null なら検証のコマンドだけ run する', () => {
  const r = fakeRun();
  const result = runProjectCheck(HEAD, { checkCommand: 'npm run check', installCommand: null }, r.run);
  assert.deepEqual(r.calls, ['npm run check']);
  assert.equal(result.exitCode, 0);
});

test('runProjectCheck：取り込みのコマンドが失敗したら、そのコマンド名の installFailureMessage の文で throw し、検証は run しない', () => {
  const failures: RunResult[] = [
    { status: 1, stdout: '', stderr: 'boom\n' },
    { status: null, error: new Error('spawnSync ENOENT') },
  ];
  for (const failed of failures) {
    const r = fakeRun({ 'pip install -e .': failed });
    assert.throws(
      () => runProjectCheck(HEAD, { checkCommand: 'pytest -q', installCommand: 'pip install -e .' }, r.run),
      (e: Error) => e.message.startsWith('pip install -e . が失敗しました（⑧の指摘にはしません。やり直すか人に返す）:'),
      JSON.stringify(failed),
    );
    assert.deepEqual(r.calls, ['pip install -e .']);
  }
});

test('composePanel：検証が失敗したとき、typecheck-test-failure の detail に設定の検証コマンドの名前が出る', () => {
  const r = composePanel({
    findings: [],
    scores: [],
    check: { headSha: HEAD, exitCode: 2, outputTail: 'FAILED', command: 'pytest -q' },
    previous: null,
    changedLines: null,
  });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  const failure = r.value.review.blocking.find((b) => b.kind === 'typecheck-test-failure');
  assert.ok(failure, JSON.stringify(r.value.review.blocking));
  assert.ok(failure.detail.startsWith('pytest -q が終了コード 2'), failure.detail);
});
