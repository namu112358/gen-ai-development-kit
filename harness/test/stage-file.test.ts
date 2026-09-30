// Issue #306：段階のファイル（harness/lib/stage-file.ts）。置き場所（git の共通ディレクトリの下の agent-harness/stage/<ID>.json。worktree からも同じ）、
// 書いて読むと同じ中身・ディレクトリが無くても作る・壊れた JSON や書式違いは読まない・書式違いは書かない、批評の回は同じ Issue・同じ計画ゲートの記録の間だけ引き継ぐこと。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { carriedCritique, checkStageFile, readStageFile, stageFilePath, writeStageFile, type StageFile } from '../lib/stage-file.ts';
import { sandbox } from './support/git-sandbox.ts';
import { SESSION } from './support/step-fixtures.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'stage-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sample = (patch: Partial<StageFile> = {}): StageFile => ({
  version: 1,
  session: SESSION,
  at: '2026-09-26T12:00:00.000Z',
  issue: 306,
  pr: null,
  node: 'plan',
  kind: 'node',
  branch: null,
  branchPrefix: 'claude/issue-306-',
  files: null,
  critique: { issue: 306, gateAt: null, rounds: [{ verdict: 'revise', must: ['AC 2 のテストが無い'] }] },
  ...patch,
});

// ---- 置き場所 ----

test('stageFilePath：<共通ディレクトリ>/agent-harness/stage/<ID>.json、ID が無い・形が違えば null', () => {
  assert.equal(stageFilePath('/repo/.git', SESSION), join('/repo/.git', 'agent-harness', 'stage', `${SESSION}.json`));
  assert.equal(stageFilePath('/repo/.git', null), null);
  assert.equal(stageFilePath('/repo/.git', ''), null);
  assert.equal(stageFilePath('/repo/.git', 'https://claude.ai/code/session_x'), null);
  assert.equal(stageFilePath('/repo/.git', '../escape'), null, 'パスを抜ける ID は使わない');
});

test('worktree からも git の共通ディレクトリ（--git-common-dir）は主と同じで、段階のファイルのパスもそろう', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const wt = join(sb.dir, 'wt');
  sb.git(sb.root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  const common = (cwd: string) => {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return realpathSync(r.stdout.trim());
  };
  const main = common(sb.root);
  if (main === null) {
    t.skip('git が --path-format を知らない');
    return;
  }
  const fromWt = common(wt);
  assert.equal(fromWt, main);
  assert.equal(stageFilePath(fromWt!, SESSION), stageFilePath(main, SESSION));
});

// ---- 書く・読む ----

test('writeStageFile → readStageFile で同じ中身、ディレクトリが無くても作り、一時ファイルを残さない', (t) => {
  const dir = tempDir(t);
  const path = stageFilePath(join(dir, 'common'), SESSION)!;
  assert.equal(existsSync(join(dir, 'common')), false);
  const value = sample({ pr: 400, node: 'fix', kind: 'node', branch: 'claude/issue-306-step', files: ['harness/lib/step.ts'] });
  writeStageFile(path, value);
  assert.deepEqual(readStageFile(path), value);
  assert.deepEqual(readdirSync(join(dir, 'common', 'agent-harness', 'stage')), [`${SESSION}.json`]);
  // 上書き
  const next = sample({ node: 'plan-critique', critique: null });
  writeStageFile(path, next);
  assert.deepEqual(readStageFile(path), next);
});

test('readStageFile：無い・壊れた JSON・書式違いは null', (t) => {
  const dir = tempDir(t);
  assert.equal(readStageFile(join(dir, 'none.json')), null);
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{ "version": 1, ');
  assert.equal(readStageFile(broken), null);
  const wrong = join(dir, 'wrong.json');
  writeFileSync(wrong, JSON.stringify({ ...sample(), version: 2 }));
  assert.equal(readStageFile(wrong), null);
  const arr = join(dir, 'arr.json');
  writeFileSync(arr, '[]');
  assert.equal(readStageFile(arr), null);
});

test('writeStageFile：書式違いは throw し、書かない', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'x', 'bad.json');
  assert.throws(() => writeStageFile(path, { ...sample(), issue: 0 }), /issue/);
  assert.equal(existsSync(path), false);
});

// ---- checkStageFile ----

test('checkStageFile：正しい中身は誤りなし', () => {
  assert.deepEqual(checkStageFile(sample()), []);
  assert.deepEqual(checkStageFile(sample({ critique: null, pr: 1, branch: 'b', files: [] })), []);
  assert.deepEqual(checkStageFile(sample({ kind: 'stop', node: 'stopped', critique: { issue: 306, gateAt: '2026-09-26T01:01:00Z', rounds: [] } })), []);
});

test('checkStageFile：項目ごとの誤り', () => {
  const cases: [string, unknown, RegExp][] = [
    ['オブジェクトでない', null, /オブジェクト/],
    ['配列', [], /オブジェクト/],
    ['version', { ...sample(), version: 2 }, /version/],
    ['session の形', { ...sample(), session: 'https://claude.ai/code/session_x' }, /session/],
    ['at', { ...sample(), at: 'yesterday' }, /at/],
    ['issue', { ...sample(), issue: 1.5 }, /issue/],
    ['pr', { ...sample(), pr: 0 }, /pr/],
    ['node', { ...sample(), node: '' }, /node/],
    ['kind', { ...sample(), kind: 'run' }, /kind/],
    ['branch', { ...sample(), branch: 3 }, /branch/],
    ['branchPrefix', { ...sample(), branchPrefix: null }, /branchPrefix/],
    ['files', { ...sample(), files: [1] }, /files/],
    ['critique の形', { ...sample(), critique: { issue: 306, rounds: 'x', gateAt: null } }, /critique/],
    ['critique.rounds の verdict', { ...sample(), critique: { issue: 306, gateAt: null, rounds: [{ verdict: 'maybe', must: [] }] } }, /critique\.rounds/],
    ['critique.rounds の must', { ...sample(), critique: { issue: 306, gateAt: null, rounds: [{ verdict: 'go', must: [1] }] } }, /critique\.rounds/],
  ];
  for (const [name, value, re] of cases) {
    const errors = checkStageFile(value);
    assert.ok(errors.length > 0, `${name}：誤りがあるはず`);
    assert.ok(errors.some((e) => re.test(e)), `${name}：${errors.join('、')}`);
  }
});

// ---- carriedCritique ----

test('carriedCritique：同じ Issue・同じ gateAt だけ批評の回を引き継ぐ（写しを返す）', () => {
  const prev = sample({ critique: { issue: 306, gateAt: '2026-09-26T01:01:00Z', rounds: [{ verdict: 'revise', must: ['A'] }, { verdict: 'go', must: [] }] } });
  const rounds = carriedCritique(prev, 306, '2026-09-26T01:01:00Z');
  assert.deepEqual(rounds, prev.critique!.rounds);
  rounds[0]!.must.push('変えた');
  assert.deepEqual(prev.critique!.rounds[0]!.must, ['A'], '元のファイルの中身を変えない');
  assert.deepEqual(carriedCritique(sample(), 306, null), [{ verdict: 'revise', must: ['AC 2 のテストが無い'] }], 'gateAt が両方 null でも同じ');
});

test('carriedCritique：Issue が違う・gateAt が違う・前のファイルが無い・critique が null なら空', () => {
  const prev = sample({ critique: { issue: 306, gateAt: '2026-09-26T01:01:00Z', rounds: [{ verdict: 'revise', must: ['A'] }] } });
  assert.deepEqual(carriedCritique(prev, 307, '2026-09-26T01:01:00Z'), []);
  assert.deepEqual(carriedCritique(prev, 306, '2026-09-26T02:00:00Z'), []);
  assert.deepEqual(carriedCritique(prev, 306, null), []);
  assert.deepEqual(carriedCritique(null, 306, null), []);
  assert.deepEqual(carriedCritique(sample({ critique: null }), 306, null), []);
});
