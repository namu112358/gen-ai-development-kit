// review-api の記録を判定に使うかの選び方（harness/lib/api-review.ts の parseApiReviewRecord・judgeInputFacts・selectApiReview）を確かめる（Issue #1042）。
// 読み戻しが review-api/src/record.ts の parseApiReviewComment と同じ規則であること（細部は review-api-record.test.ts・review-api-stopped-record.test.ts）、
// judge-input の「PR の状態」「前回の判定」の節から state と前回の head を読むこと、posted → api・止めた3つの outcome → local・
// レビュー用の App 以外の名義・Bot でない・pr の違う・patch-id の違う head の記録を使わないこと、closed と前回の判定と同じ head で skip、
// head の一致を patch-id の一致より先に、同じ段では id の大きい記録を選び、samePatch は head が違う候補にだけ呼ぶことを見る
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderShadowComment, renderStoppedComment, parseApiReviewComment, type StoppedOutcome } from '../../review-api/src/record.ts';
import { composeShadowVerdict, type ReviewerOutput, type RiskOutput } from '../../review-api/src/verdict.ts';
import { judgeInputFacts, parseApiReviewRecord, selectApiReview } from '../lib/api-review.ts';
import type { IssueComment } from '../lib/github.ts';
import { renderJudgeInput } from '../lib/session-inputs.ts';
import { RISK_QUESTIONS } from '../lib/verdict.ts';
import { config, verdictComment } from './support/gate-fixtures.ts';

const PR = 5;
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const APP = 'review-api[bot]';
const MODELS = { review: 'claude-opus-5-5', risk: 'claude-sonnet-5-5' };

const REVIEWER: ReviewerOutput = { pass: false, blocking: [{ kind: 'bug', file: 'src/a.ts', detail: 'null で落ちる' }], nonBlocking: ['命名'] };
const RISK: RiskOutput = {
  level: 'low',
  answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as RiskOutput['answers'],
  rationale: 'docs のみ',
  facts: { references: 'none', tests: 'none', fileKinds: 'docs' },
};

const postedBody = (headSha = HEAD, pr = PR): string =>
  renderShadowComment({
    version: 1, pr, headSha,
    verdict: composeShadowVerdict({ pr, headSha, reviewer: REVIEWER, risk: RISK, model: MODELS.review }),
    models: MODELS, usage: {}, usd: null, durationSec: 1,
  });
const stoppedBody = (outcome: StoppedOutcome, headSha = HEAD, pr = PR): string => renderStoppedComment({ version: 1, pr, headSha, outcome, usd: null });

const comment = (id: number, body: string, user: IssueComment['user'] = { login: APP, type: 'Bot' }): IssueComment => ({
  id, body, html_url: `https://example.test/c${id}`, created_at: '2026-10-13T00:00:00Z', updated_at: '', author_association: 'NONE', user,
});

const OPEN = { state: 'open', previousHead: null };
const select = (comments: IssueComment[], opts: { facts?: { state: string | null; previousHead: string | null }; samePatch?: (h: string) => boolean } = {}) =>
  selectApiReview({ pr: PR, judgedHead: HEAD, appLogin: APP, comments, facts: opts.facts ?? OPEN, samePatch: opts.samePatch ?? (() => false) });

// 目印とフェンスだけを手で組んだ本文（render が受け付けない値を読み戻しに渡すため）
const handBody = (json: string, head = HEAD): string => [`<!-- api-review-shadow head=${head} -->`, '', '```api-review-shadow', json, '```', ''].join('\n');

test('parseApiReviewRecord：review-api の parseApiReviewComment と同じ記録を読み、同じものを null にする', () => {
  const bodies: [string, string][] = [
    ['posted', postedBody()],
    ...(['budget-exceeded', 'too-large', 'verdict-invalid'] as const).map((o): [string, string] => [o, stoppedBody(o)]),
    ['目印が2つ', `${postedBody()}\n<!-- api-review-shadow head=${OTHER} -->`],
    ['JSON が壊れた', handBody('{ not json')],
    ['head の食い違い', handBody(JSON.stringify({ version: 1, pr: PR, headSha: OTHER, outcome: 'too-large', usd: null }))],
    ['outcome が語彙の外', handBody(JSON.stringify({ version: 1, pr: PR, headSha: HEAD, outcome: 'exploded', usd: null }))],
  ];
  for (const [name, body] of bodies) {
    const want = parseApiReviewComment(body);
    const got = parseApiReviewRecord(body);
    assert.equal(got?.outcome ?? null, want?.outcome ?? null, name);
    assert.equal(got?.headSha ?? null, want?.headSha ?? null, `${name}: head`);
    if (want !== null) assert.equal(got?.pr, PR, `${name}: pr`);
  }
  const posted = parseApiReviewRecord(postedBody());
  assert.ok(posted?.outcome === 'posted');
  assert.deepEqual(posted.models, MODELS);
  assert.deepEqual(posted.verdict.review, composeShadowVerdict({ pr: PR, headSha: HEAD, reviewer: REVIEWER, risk: RISK, model: MODELS.review }).review);
});

test('judgeInputFacts：judge-input の PR の状態の state と前回の判定の head を読む（無ければ null）', () => {
  const input = (prState: { state: string; draft: boolean } | undefined, prComments: IssueComment[]) =>
    renderJudgeInput(config, { pr: { number: PR, headSha: HEAD, body: '' }, issues: [], prComments, checkRuns: [], ...(prState ? { prState } : {}) });
  const cases: [string, string, { state: string | null; previousHead: string | null }][] = [
    ['open・前回なし', input({ state: 'open', draft: true }, []), { state: 'open', previousHead: null }],
    ['closed', input({ state: 'closed', draft: false }, []), { state: 'closed', previousHead: null }],
    ['状態を集めていない', input(undefined, []), { state: null, previousHead: null }],
    ['前回の判定あり', input({ state: 'open', draft: true }, [verdictComment({ headSha: OTHER }) as IssueComment]), { state: 'open', previousHead: OTHER }],
  ];
  for (const [name, text, want] of cases) assert.deepEqual(judgeInputFacts(text), want, name);
});

test('selectApiReview：同じ head の posted は api（Reviewer・Risk の出力と記録の URL・head・モデル）', () => {
  const verdict = composeShadowVerdict({ pr: PR, headSha: HEAD, reviewer: REVIEWER, risk: RISK, model: MODELS.review });
  assert.deepEqual(select([comment(7, postedBody())]), {
    action: 'api',
    reviewer: verdict.review,
    risk: { ...verdict.risk, facts: verdict.facts },
    recordUrl: 'https://example.test/c7',
    recordHead: HEAD,
    models: MODELS,
  });
});

test('selectApiReview：止めた outcome は local、使わない記録しか無ければ pending、closed・前回と同じ head は skip', () => {
  type Want = { action: string; reason?: string; recordUrl?: string };
  const cases: [string, IssueComment[], Want, { facts?: { state: string | null; previousHead: string | null }; samePatch?: (h: string) => boolean }?][] = [
    // 止めた3つの outcome
    ...(['budget-exceeded', 'too-large', 'verdict-invalid'] as const).map(
      (o): [string, IssueComment[], Want] => [o, [comment(3, stoppedBody(o))], { action: 'local', reason: o, recordUrl: 'https://example.test/c3' }],
    ),
    // 使わない記録（守り）
    ['記録なし', [], { action: 'pending' }],
    ['ほかの Bot の名義', [comment(1, postedBody(), { login: 'agent-harness[bot]', type: 'Bot' })], { action: 'pending' }],
    ['人の名義', [comment(1, postedBody(), { login: 'me', type: 'User' })], { action: 'pending' }],
    ['login は同じでも Bot でない', [comment(1, postedBody(), { login: APP, type: 'User' })], { action: 'pending' }],
    ['user が null', [comment(1, postedBody(), null)], { action: 'pending' }],
    ['pr の違う記録', [comment(1, postedBody(HEAD, PR + 1))], { action: 'pending' }],
    ['pr の違う止めた記録', [comment(1, stoppedBody('too-large', HEAD, PR + 1))], { action: 'pending' }],
    ['patch-id の違う head', [comment(1, postedBody(OTHER))], { action: 'pending' }, { samePatch: () => false }],
    ['読めない本文', [comment(1, handBody('{ not json'))], { action: 'pending' }],
    // skip（記録があっても先に見る）
    ['closed', [comment(1, postedBody())], { action: 'skip', reason: 'closed' }, { facts: { state: 'closed', previousHead: null } }],
    ['前回の判定と同じ head', [comment(1, postedBody())], { action: 'skip', reason: 'same-head' }, { facts: { state: 'open', previousHead: HEAD } }],
    ['closed かつ記録なし', [], { action: 'skip', reason: 'closed' }, { facts: { state: 'closed', previousHead: null } }],
  ];
  for (const [name, comments, want, opts] of cases) {
    const got = select(comments, opts) as Want;
    assert.deepEqual({ action: got.action, reason: got.reason, recordUrl: got.recordUrl }, { recordUrl: undefined, reason: undefined, ...want }, name);
  }
  // 前回の判定の head が違えば skip しない
  assert.equal(select([comment(1, postedBody())], { facts: { state: 'open', previousHead: OTHER } }).action, 'api');
});

test('selectApiReview：head の一致を patch-id の一致より先に、同じ段では id の大きい記録を選び、samePatch は head の違う候補にだけ呼ぶ', () => {
  const asked: string[] = [];
  const samePatch = (h: string): boolean => {
    asked.push(h);
    return true;
  };

  // patch-id が同じ head の記録は使う（recordHead は記録の head）
  const viaPatch = select([comment(1, postedBody(OTHER))], { samePatch });
  assert.equal(viaPatch.action, 'api');
  assert.equal((viaPatch as { recordHead: string }).recordHead, OTHER);
  assert.deepEqual(asked, [OTHER]);

  // head の一致（id 小）が patch-id の一致（id 大）より先
  asked.length = 0;
  const headFirst = select([comment(2, stoppedBody('too-large')), comment(9, postedBody(OTHER))], { samePatch });
  assert.deepEqual(headFirst, { action: 'local', reason: 'too-large', recordUrl: 'https://example.test/c2' });
  assert.ok(!asked.includes(HEAD), 'head の一致する記録に samePatch を呼んだ');

  // 同じ段（head 一致）が複数なら id の大きいもの（並びの順に関わらず）
  for (const comments of [
    [comment(4, stoppedBody('budget-exceeded')), comment(8, postedBody())],
    [comment(8, postedBody()), comment(4, stoppedBody('budget-exceeded'))],
  ]) {
    assert.equal(select(comments).action, 'api');
  }
  const newerStopped = select([comment(8, postedBody()), comment(12, stoppedBody('verdict-invalid'))]);
  assert.deepEqual(newerStopped, { action: 'local', reason: 'verdict-invalid', recordUrl: 'https://example.test/c12' });

  // 使わない名義の記録が新しくても、App の記録を選ぶ
  const spoofed = select([comment(3, postedBody()), comment(20, stoppedBody('too-large'), { login: 'me', type: 'User' })]);
  assert.equal(spoofed.action, 'api');
});
