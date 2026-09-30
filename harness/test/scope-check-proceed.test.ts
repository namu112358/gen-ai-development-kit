/**
 * ローカルの scope-check が、人が「進める」と決めた計画（App の kind=plan-proceed の記録）を委任・bypass の照合に使うことを確かめる（Issue #365、harness/lib/scope-check.ts・state.ts）。
 * Planner の申告で止まった計画に一致する plan-proceed（ok）があれば delegate.usable が真で、agent/scope だけが no-plan（終了コード 3）。無ければ両方 no-plan（終了コード 3）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import { GitHub } from '../lib/github.ts';
import { scopeCheck } from '../lib/scope-check.ts';
import { APP, config, CRITIQUE, FakeGitHub } from './support/gate-fixtures.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const ISSUE = 365;
const PLANNED = ['harness/lib/state.ts', 'docs/**'];
const GATE_MISSING = `#${ISSUE} に計画ゲートを通過した計画がありません`;
const DELEGATE_MISSING = `#${ISSUE} に委任承認で照合できる計画がありません（ゲートを通ったか、ゲートの停止で止まった計画だけを使う）`;

const plan = {
  version: 1, issue: ISSUE, risk: 'low', needsHuman: true, needsHumanReasons: ['既定値を決める'], acChangeProposed: false, openQuestions: [], files: PLANNED, critique: CRITIQUE,
};
const PLAN_BODY = `${CLAUDE_MARK}\n## 計画\n\n${renderBlock('agent-plan', plan)}`;

function comment(id: number, body: string, login: string) {
  return {
    id, body, created_at: '2026-09-27T00:00:00Z', updated_at: '', html_url: `u${id}`,
    author_association: login === APP ? 'NONE' : 'OWNER', user: { login, type: login === APP ? 'Bot' : 'User' },
  };
}
const record = (id: number, kind: string, value: unknown) => comment(id, `${appMark(kind)}\n記録\n${renderBlock('agent-app', value)}`, APP);

const stopped = [
  comment(80, PLAN_BODY, 'me'),
  record(90, 'plan-gate', { version: 1, planCommentId: 80, planBodySha256: sha256(PLAN_BODY), pass: false, reasons: ['止めた理由'], planReviewOrigin: 'planner', plan }),
];
const proceed = record(110, 'plan-proceed', { version: 1, decisionCommentId: 100, planCommentId: 80, planBodySha256: sha256(PLAN_BODY), status: 'ok' });

/** Issue のコメントだけを返す偽の GitHub（書き込みは経路が無いので、呼べば unrouted で落ちる） */
function run(comments: { id: number }[], files: { changed: string[]; untracked: string[] }) {
  const fake = new FakeGitHub()
    .on('GET', new RegExp(`/issues/${ISSUE}/comments`), () => comments)
    .on('GET', /\/issues\/comments\/(\d+)$/, (m) => {
      const found = comments.find((c) => c.id === Number(m[1]));
      if (!found) throw new Error(`404 comments/${m[1]}`);
      return found;
    });
  return { fake, report: scopeCheck(new GitHub(fake, 'o/r'), config, ISSUE, files) };
}

test('plan-proceed の記録がある：delegate.usable が真で、agent/scope だけが no-plan（終了コード 3）', async () => {
  const { fake, report } = run([...stopped, proceed], { changed: ['harness/lib/state.ts', 'docs/a.md'], untracked: [] });
  const r = await report;
  assert.deepEqual(r.scope, { missing: GATE_MISSING }, 'agent/scope は通過した計画だけ（変えない）');
  assert.deepEqual(r.delegate, { usable: true, ok: true, outside: [] });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.problems, [{ check: 'scope', kind: 'no-plan', reason: GATE_MISSING }]);
  assert.deepEqual(fake.writes(), [], 'GitHub には書き込まない');
});

test('plan-proceed の記録がある：計画の外のファイルは delegate の outside に出て終了コード 1', async () => {
  const r = await run([...stopped, proceed], { changed: ['harness/lib/state.ts'], untracked: ['notes.txt'] }).report;
  assert.deepEqual(r.delegate, { usable: true, ok: false, outside: ['notes.txt'] });
  assert.equal(r.exitCode, 1);
});

test('plan-proceed の記録が無い：両方 no-plan（終了コード 3）', async () => {
  const r = await run(stopped, { changed: ['docs/a.md'], untracked: [] }).report;
  assert.deepEqual(r.scope, { missing: GATE_MISSING });
  assert.deepEqual(r.delegate, { usable: false, reason: DELEGATE_MISSING, latestPlanOutside: [] });
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.problems, [
    { check: 'scope', kind: 'no-plan', reason: GATE_MISSING },
    { check: 'delegate', kind: 'no-plan', reason: DELEGATE_MISSING },
  ]);
});

test('plan-proceed の後に計画コメントが編集された：両方 no-plan（終了コード 3）', async () => {
  const edited = [comment(80, `${PLAN_BODY}\n追記`, 'me'), stopped[1]!, proceed];
  const r = await run(edited, { changed: ['docs/a.md'], untracked: [] }).report;
  assert.equal(r.delegate.usable, false);
  assert.equal(r.exitCode, 3);
});
