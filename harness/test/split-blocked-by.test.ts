/**
 * split の子課題に外の Issue への依存（blockedBy）を書け、App が作った子課題の Issue Dependencies に付けることを確かめる（Issue #887）。
 * AC1：外の開いた Issue の番号を書くと、子課題の blocked by にその Issue が付く（閉じた・見つからない・PR は付けない）。
 * AC2：blockedBy の書式が違う split の計画は、計画ゲートが理由つきで止める（split-invalid）。
 * 兄弟の dependsOn と親の開いた blocker の今までの動きは harness/test/gates-epic.test.ts が確かめる。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../lib/blocks.ts';
import { validateSplit, type SplitChild } from '../lib/epic.ts';
import { parseIssueBody } from '../lib/issue-form.ts';
import { evaluatePlanGate, parsePlan, type Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, CRITIQUE, critiqueClaim, ctxFor, pr } from './support/gate-fixtures.ts';

const noGuardrail = { guardrailPaths: [] };

const child = (patch: Partial<SplitChild> = {}): SplitChild => ({
  title: 'feat(x): 子', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['src/a.ts'], dependsOn: [], blockedBy: [], ...patch,
});
const withBlockedBy = (blockedBy: number[]): SplitChild[] => [child({ title: 'feat(x): 一つ目' }), child({ title: 'docs: 二つ目', files: ['docs/**'], dependsOn: [0], blockedBy })];
const plan = (split: SplitChild[]): Plan => ({ version: 1, issue: 7, risk: 'critical', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [], split, critique: CRITIQUE });

test('blockedBy の書式：省略すれば []、整数でなければ split[i].blockedBy[j] の型の誤りで読めない', () => {
  const raw = JSON.parse(JSON.stringify(plan(withBlockedBy([12]))));
  delete raw.split[0].blockedBy;
  const ok = parsePlan(raw);
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.join('/'));
  assert.deepEqual(ok.ok && ok.value.split?.[0]?.blockedBy, []);
  assert.deepEqual(ok.ok && ok.value.split?.[1]?.blockedBy, [12]);

  for (const [blockedBy, needle] of [[['12'], 'split[1].blockedBy[0]'], [12, 'split[1].blockedBy']] as const) {
    raw.split[1].blockedBy = blockedBy;
    const bad = parsePlan(raw);
    assert.equal(bad.ok, false, JSON.stringify(blockedBy));
    assert.ok(!bad.ok && bad.errors.some((e) => e.includes(needle)), `${needle}: ${bad.ok ? '' : bad.errors.join('/')}`);
  }
});

test('blockedBy の検査：0・負の数・重複・親の番号は理由つきで返し、計画ゲートが split-invalid で止める。正しいものは通る', () => {
  // 親は #7
  const cases: [number[], RegExp][] = [
    [[0], /split\[1\]\.blockedBy.*\b0\b/],
    [[-3], /split\[1\]\.blockedBy.*-3/],
    [[12, 12], /split\[1\]\.blockedBy.*重複/],
    [[7], /split\[1\]\.blockedBy.*#7/],
  ];
  for (const [blockedBy, needle] of cases) {
    const reasons = validateSplit(withBlockedBy(blockedBy), 7);
    assert.ok(reasons.some((r) => needle.test(r)), `${blockedBy}: ${reasons.join('/')}`);
    const gate = evaluatePlanGate(plan(withBlockedBy(blockedBy)), 7, noGuardrail);
    assert.equal(gate.pass, false, `${blockedBy}`);
    assert.equal(gate.splitInvalid, true, `${blockedBy}`);
    assert.ok(gate.reasons.some((r) => needle.test(r)), `${blockedBy}: ${gate.reasons.join('/')}`);
  }

  assert.deepEqual(validateSplit(withBlockedBy([12, 40]), 7), []);
  assert.deepEqual(evaluatePlanGate(plan(withBlockedBy([12, 40])), 7, noGuardrail), { pass: true, reasons: [] });
  assert.deepEqual(validateSplit(withBlockedBy([7])), [], '親を渡さなければ親の番号の検査はしない');
});

// --- App の split（onComment）---

interface Item { id: number; number: number; body: string; labels: { name: string }[]; user: { login: string } }

/** GET /issues/{番号} で返す外の Issue（null は 404） */
const outside: Record<number, Record<string, unknown> | null> = {
  40: { id: 7040, number: 40, state: 'open', repository_url: 'https://api.github.com/repos/o/r' },
  41: { id: 7041, number: 41, state: 'closed', repository_url: 'https://api.github.com/repos/o/r' },
  42: null,
  43: { id: 7043, number: 43, state: 'open', repository_url: 'https://api.github.com/repos/o/r', pull_request: { url: 'u' } },
  44: { id: 7044, number: 44, state: 'open', repository_url: 'https://api.github.com/repos/o/r' },
};

/** 親 #3 の split に必要な経路だけを持つ偽の GitHub。子は #100 から番号を振る。親の開いた blocker は #44 */
function splitFake() {
  const comments: unknown[] = [critiqueClaim()];
  const created: Item[] = [];
  let next = 100;
  return acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => comments)
    .on('POST', /\/issues\/3\/comments$/, (_m, body) => {
      const c = { id: 500 + comments.length, body: body.body, html_url: 'u', created_at: '', updated_at: '', author_association: 'NONE', user: { login: APP, type: 'Bot' } };
      comments.push(c);
      return c;
    })
    .on('GET', /\/issues\/3\/sub_issues/, () => [])
    .on('GET', /\/issues\?state=all&creator=/, () => created)
    .on('POST', /\/repos\/o\/r\/issues$/, (_m, body) => {
      const item = { id: 9000 + next, number: next++, body: body.body, labels: [], user: { login: APP } };
      created.push(item);
      return item;
    })
    .on('POST', /\/issues\/3\/sub_issues$/, () => ({}))
    .on('GET', /\/issues\/(\d+)$/, (m, _b, opts) => {
      const n = Number(m[1]);
      if (!(n in outside) || outside[n] === null) {
        if (opts.allow404) return null;
        throw new Error(`404 issues/${n}`);
      }
      return outside[n];
    })
    .on('GET', /\/issues\/\d+\/dependencies\/blocked_by/, () => [])
    .on('POST', /\/issues\/\d+\/dependencies\/blocked_by$/, () => ({}))
    .on('GET', /\/issues\/3\/dependencies\/blocked_by/, () => [outside[44]]);
}

const event = (split: SplitChild[]) => ({
  action: 'created',
  issue: { number: 3, labels: [{ name: 'agent:ready' }, { name: 'priority:high' }, { name: 'risk:critical' }], state: 'open' },
  comment: { id: 80, body: renderBlock('agent-plan', { ...plan(split), issue: 3 }), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
});

test('App の split：開いた外の Issue だけを子課題の blocked by・本文の Dependencies・epic-split の記録に足す', async () => {
  const fake = splitFake();
  // 一つ目は外の Issue（開いた #40、閉じた #41、無い #42、PR の #43、親の blocker と同じ #44）の後。二つ目は兄弟の一つ目の後
  const split = [child({ title: 'feat(x): 一つ目', blockedBy: [40, 41, 42, 43, 44] }), child({ title: 'docs: 二つ目', files: ['docs/**'], dependsOn: [0] })];
  await onComment(ctxFor(fake, 'issue_comment', event(split)));

  const posts = (re: RegExp) => fake.calls.filter((c) => c.method === 'POST' && re.test(c.path));
  const deps = posts(/blocked_by$/).map((c) => `${c.path.match(/issues\/(\d+)/)![1]}<-${c.body.issue_id}`).sort();
  assert.deepEqual(deps, ['100<-7040', '100<-7044', '101<-7044', '101<-9100'], '開いた外の Issue だけ付く。親の blocker と同じ番号は二重に付けない。兄弟と親の blocker は今までどおり');

  const bodies = posts(/\/repos\/o\/r\/issues$/).map((c) => String(c.body.body));
  const first = parseIssueBody(bodies[0]!);
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.match(first.contract.dependencies, /#40/);
  for (const n of [41, 42, 43]) assert.doesNotMatch(first.contract.dependencies, new RegExp(`#${n}\\b`), `#${n} は Dependencies に載せない`);

  const record = posts(/\/issues\/3\/comments$/).map((c) => String(c.body.body)).find((b) => b.includes('kind=epic-split '))!;
  const line = record.split('\n').find((l) => l.startsWith('- #100'))!;
  assert.match(line, /#40/);
  for (const n of [41, 42, 43]) assert.doesNotMatch(line, new RegExp(`#${n}\\b`));
});
