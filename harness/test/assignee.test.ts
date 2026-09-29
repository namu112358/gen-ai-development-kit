// Issue #172：Assignee が自分1人だけかの判定（assigneeProblem・describeAssigneeProblem・requireAssignee・checkAssignee・assigneeExclusion）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assigneeExclusion, assigneeProblem, checkAssignee, describeAssigneeProblem, requireAssignee, type AssigneeIo } from '../lib/assignee.ts';

const ME = 'me';
const on = { requireAssignee: true };

// ---- assigneeProblem ----

test('assigneeProblem：自分1人なら null（login の大文字小文字は区別しない）', () => {
  assert.equal(assigneeProblem(['me'], ME), null);
  assert.equal(assigneeProblem(['Me'], ME), null);
  assert.equal(assigneeProblem(['me'], 'ME'), null);
});

test('assigneeProblem：空は none、他人1人は other', () => {
  assert.equal(assigneeProblem([], ME), 'none');
  assert.equal(assigneeProblem(['alice'], ME), 'other');
});

test('assigneeProblem：2人以上は自分を含んでも含まなくても multiple', () => {
  assert.equal(assigneeProblem(['me', 'alice'], ME), 'multiple');
  assert.equal(assigneeProblem(['alice', 'ME'], ME), 'multiple');
  assert.equal(assigneeProblem(['alice', 'bob'], ME), 'multiple');
  assert.equal(assigneeProblem(['me', 'me'], ME), 'multiple', '数で決める');
});

// ---- describeAssigneeProblem ----

test('describeAssigneeProblem：理由の文', () => {
  assert.equal(describeAssigneeProblem('none', []), '誰もアサインされていない');
  assert.equal(describeAssigneeProblem('other', ['alice']), 'ほかの人（@alice）がアサインされている');
  assert.equal(describeAssigneeProblem('multiple', ['a', 'b']), '2人以上（@a, @b）がアサインされている');
});

// ---- requireAssignee ----

test('requireAssignee：true のときだけ有効（未設定・false は無効）', () => {
  assert.equal(requireAssignee({}), false);
  assert.equal(requireAssignee({ requireAssignee: false }), false);
  assert.equal(requireAssignee({ requireAssignee: true }), true);
});

// ---- checkAssignee ----

/** Issue の assignees・PR の Close する Issue を差し替えた偽の io。呼び出しの回数を数える */
function fakeIo(issues: Record<number, { assignees: string[]; pullRequest?: boolean }>, closing: Record<number, number[]> = {}) {
  const calls = { me: 0, issue: [] as number[], closingIssues: [] as number[] };
  const io: AssigneeIo = {
    async me() {
      calls.me++;
      return ME;
    },
    async issue(n) {
      calls.issue.push(n);
      const i = issues[n];
      assert.ok(i, `知らない番号 #${n}`);
      return { assignees: i.assignees, pullRequest: i.pullRequest ?? false };
    },
    async closingIssues(pr) {
      calls.closingIssues.push(pr);
      return closing[pr] ?? [];
    },
  };
  return { io, calls };
}

const throwingIo: AssigneeIo = {
  me: async () => { throw new Error('me() を呼んだ'); },
  issue: async () => { throw new Error('issue() を呼んだ'); },
  closingIssues: async () => { throw new Error('closingIssues() を呼んだ'); },
};

test('checkAssignee：無効（未設定・false）なら io を一切呼ばずに null', async () => {
  assert.equal(await checkAssignee(throwingIo, {}, 1), null);
  assert.equal(await checkAssignee(throwingIo, { requireAssignee: false }, 1), null);
});

test('checkAssignee：Issue 番号で自分1人なら null、me() は1回だけ', async () => {
  const f = fakeIo({ 5: { assignees: ['me'] } });
  assert.equal(await checkAssignee(f.io, on, 5), null);
  assert.equal(f.calls.me, 1);
  assert.deepEqual(f.calls.closingIssues, [], 'Issue なら Close する Issue を読まない');
});

test('checkAssignee：Issue 番号で空・他人・2人以上なら、#番号 で始まり理由を含む error', async () => {
  const cases: [string[], string][] = [
    [[], '誰もアサインされていない'],
    [['alice'], 'ほかの人（@alice）がアサインされている'],
    [['me', 'alice'], '2人以上（@me, @alice）がアサインされている'],
    [['alice', 'bob'], '2人以上（@alice, @bob）がアサインされている'],
  ];
  for (const [assignees, reason] of cases) {
    const f = fakeIo({ 7: { assignees } });
    const error = await checkAssignee(f.io, on, 7);
    assert.ok(error, JSON.stringify(assignees));
    assert.equal(error, `#7: Assignee が自分（@me）1人ではありません（${reason}）。アサインは人が決めます（エージェントは自分をアサインしません）`);
    assert.ok(error.startsWith('#7: '));
    assert.equal(f.calls.me, 1);
  }
});

test('checkAssignee：PR 番号なら Close する Issue の assignees で判定する（PR 自身の assignees は見ない）', async () => {
  const ok = fakeIo({ 20: { assignees: [], pullRequest: true }, 5: { assignees: ['me'] } }, { 20: [5] });
  assert.equal(await checkAssignee(ok.io, on, 20), null, 'PR の assignees が空でも、Issue が自分1人なら通る');
  assert.deepEqual(ok.calls.closingIssues, [20]);
  assert.equal(ok.calls.me, 1);

  const ng = fakeIo({ 20: { assignees: ['me'], pullRequest: true }, 5: { assignees: ['alice'] } }, { 20: [5] });
  const error = await checkAssignee(ng.io, on, 20);
  assert.ok(error);
  assert.ok(error.startsWith('#5: '), `Issue の番号で示す: ${error}`);
  assert.match(error, /ほかの人（@alice）がアサインされている/);
});

test('checkAssignee：PR が Close する Issue が無ければ error', async () => {
  const f = fakeIo({ 20: { assignees: ['me'], pullRequest: true } }, { 20: [] });
  const error = await checkAssignee(f.io, on, 20);
  assert.equal(error, 'PR #20: Close する Issue が無いため、担当（Assignee）を確かめられません');
  assert.match(error!, /Close する Issue が無い/);
});

test('checkAssignee：PR が複数の Issue を Close するとき、どれか1つでも外れれば error、全部自分1人なら null', async () => {
  const ng = fakeIo({ 20: { assignees: [], pullRequest: true }, 5: { assignees: ['me'] }, 6: { assignees: [] } }, { 20: [5, 6] });
  const error = await checkAssignee(ng.io, on, 20);
  assert.ok(error);
  assert.ok(error.startsWith('#6: '), error);
  assert.match(error, /誰もアサインされていない/);
  assert.equal(ng.calls.me, 1, 'me() は Issue の数によらず1回');

  const ok = fakeIo({ 20: { assignees: [], pullRequest: true }, 5: { assignees: ['me'] }, 6: { assignees: ['ME'] } }, { 20: [5, 6] });
  assert.equal(await checkAssignee(ok.io, on, 20), null);
  assert.equal(ok.calls.me, 1);
});

// ---- assigneeExclusion ----

test('assigneeExclusion：自分1人なら null、それ以外は理由', () => {
  assert.equal(assigneeExclusion(['me'], ME), null);
  assert.equal(assigneeExclusion(['ME'], ME), null);
  assert.equal(assigneeExclusion([], ME), 'Assignee が自分1人ではない（誰もアサインされていない）');
  assert.equal(assigneeExclusion(['alice'], ME), 'Assignee が自分1人ではない（ほかの人（@alice）がアサインされている）');
  assert.equal(assigneeExclusion(['me', 'alice'], ME), 'Assignee が自分1人ではない（2人以上（@me, @alice）がアサインされている）');
});

test('assigneeExclusion：me が null なら、assignees に関わらず確かめられない理由', () => {
  for (const assignees of [[], ['me'], ['alice']]) {
    assert.equal(assigneeExclusion(assignees, null), '今の GitHub のユーザーが分からないため、Assignee を確かめられない');
  }
});
