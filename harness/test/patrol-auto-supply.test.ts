// Issue #827：auto mode の間に patrol の下書きを自動で Issue にする判定（patrol.ts の純粋関数）。
// 候補の JSON の読み取り、種類・Risk・触るファイル・ガードレール・重複・上限ごとの自動にするかの判定、出どころの目印の読み取り、
// agent:ready を付けてよいかの判定（auto mode でないと常に偽）を確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import type { GuardrailConfig } from '../lib/guardrail.ts';
import {
  autoSupplyReady, autoSupplySourceRef, parseAutoSupplyCandidates, selectAutoSupply,
  type AutoSupplyCandidate, type AutoSupplyIssue,
} from '../lib/patrol.ts';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-12T00:00:00Z');
const hoursBefore = (n: number): string => new Date(NOW.getTime() - n * HOUR).toISOString();

/** 実物の harness.config.json のガードレール（harness.config.json・harness/lib/** が当たる） */
const real = loadConfig();
const GUARDRAIL: GuardrailConfig = { guardrailPaths: real.guardrailPaths, guardrailExclude: real.guardrailExclude };

const ON = { active: true, reason: 'agent:auto-mode が付いている' };
const OFF = { active: false, reason: 'agent:auto-mode が無い' };

/** 自動にできる候補（docs の low・new、ガードレールの外のファイル）。over で項目を変える */
const cand = (ref: string, over: Partial<AutoSupplyCandidate> = {}): AutoSupplyCandidate => ({
  ref, title: 'docs(harness): 手順を直す', risk: 'low', files: ['harness/docs/operations.md'], overlap: 'new', draftPath: null, ...over,
});

const select = (candidates: AutoSupplyCandidate[], over: { autoMode?: typeof ON; dailyLimit?: number; createdLast24h?: number } = {}) =>
  selectAutoSupply({ autoMode: over.autoMode ?? ON, candidates, guardrail: GUARDRAIL, dailyLimit: over.dailyLimit ?? 100, createdLast24h: over.createdLast24h ?? 0 });

// --- parseAutoSupplyCandidates ---

test('parseAutoSupplyCandidates：正しい形と空の候補を読める', () => {
  const one = { ref: 'arch-review-D3', title: 'docs(harness): 手順を直す', risk: 'low', files: ['harness/docs/operations.md'], overlap: 'new', draftPath: '/tmp/draft-D3.md' };
  const r = parseAutoSupplyCandidates(JSON.stringify({ version: 1, candidates: [one, { ...one, ref: 'qa-retro_1.x', risk: null, files: [], overlap: null, draftPath: null }] }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.candidates[0], one);
  assert.equal(r.candidates[1]!.risk, null);
  const empty = parseAutoSupplyCandidates(JSON.stringify({ version: 1, candidates: [] }));
  assert.ok(empty.ok, JSON.stringify(empty));
  assert.deepEqual(empty.candidates, []);
});

test('parseAutoSupplyCandidates：形の誤りは throw せず ok: false と誤りの文', () => {
  const one = { ref: 'a1', title: 'docs: x', risk: 'low', files: ['docs/a.md'], overlap: 'new', draftPath: null };
  const doc = (candidates: unknown[], version: unknown = 1): string => JSON.stringify({ version, candidates });
  const cases: [string, string][] = [
    ['壊れた JSON', '{ version: 1'],
    ['version の違い', doc([one], 2)],
    ['risk が知らない値', doc([{ ...one, risk: 'huge' }])],
    ['files が配列でない', doc([{ ...one, files: 'docs/a.md' }])],
    ['ref の書式（英数字で始まらない）', doc([{ ...one, ref: '-a1' }])],
    ['ref の書式（使えない文字）', doc([{ ...one, ref: 'a 1' }])],
    ['ref の重複', doc([one, { ...one }])],
  ];
  for (const [name, text] of cases) {
    const r = parseAutoSupplyCandidates(text);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.length > 0, name);
  }
});

// --- selectAutoSupply ---

test('selectAutoSupply：種類・Risk・触るファイル・ガードレール・重複ごとに、自動にするか人に残すか', () => {
  const cases: [AutoSupplyCandidate, string | null][] = [
    [cand('feat', { title: 'feat(harness): 新しい機能' }), 'type'],
    [cand('bad-title', { title: '題の書式でない' }), 'type'],
    [cand('risk-medium', { risk: 'medium' }), 'risk'],
    [cand('risk-null', { risk: null }), 'risk'],
    [cand('files-empty', { files: [] }), 'files-unknown'],
    [cand('guard-config', { files: ['harness/docs/operations.md', 'harness.config.json'] }), 'guardrail'],
    [cand('guard-lib', { files: ['harness/lib/x.ts'] }), 'guardrail'],
    [cand('overlap-comment', { overlap: 'comment' }), 'overlap'],
    [cand('overlap-null', { overlap: null }), 'overlap'],
    // 先に当たる理由が勝つ（種類が feat でガードレールにも当たる → type）
    [cand('order', { title: 'feat: x', files: ['harness/lib/x.ts'] }), 'type'],
    [cand('test-ok', { title: 'test(harness): テストを足す', files: ['harness/test/a.test.ts'] }), null],
    [cand('docs-ok'), null],
    [cand('fix-ok', { title: 'fix(harness): 誤りを直す' }), null],
  ];
  const r = select(cases.map(([c]) => c));
  assert.equal(r.active, true);
  assert.deepEqual(r.create.map((c) => c.ref), cases.filter(([, w]) => w === null).map(([c]) => c.ref));
  for (const [c, want] of cases) {
    const m = r.manual.find((x) => x.ref === c.ref);
    assert.equal(m?.reason ?? null, want, c.ref);
    if (m) assert.equal(m.title, c.title, c.ref);
  }
  assert.match(r.manual.find((x) => x.ref === 'guard-config')!.detail, /harness\.config\.json/);
  assert.match(r.manual.find((x) => x.ref === 'guard-lib')!.detail, /harness\/lib\/x\.ts/);
});

test('selectAutoSupply：1日の上限を超えた分は limit で人に残る（入力の順）', () => {
  const two = [cand('a'), cand('b')];
  const cases: { name: string; dailyLimit: number; createdLast24h: number; create: string[]; remaining: number }[] = [
    { name: '上限 1 で2件通る', dailyLimit: 1, createdLast24h: 0, create: ['a'], remaining: 1 },
    { name: '使った数が上限以上', dailyLimit: 2, createdLast24h: 3, create: [], remaining: 0 },
    { name: '上限 0', dailyLimit: 0, createdLast24h: 0, create: [], remaining: 0 },
  ];
  for (const c of cases) {
    const r = select(two, c);
    assert.deepEqual(r.create.map((x) => x.ref), c.create, c.name);
    assert.deepEqual(r.manual.map((x) => [x.ref, x.reason]), two.filter((x) => !c.create.includes(x.ref)).map((x) => [x.ref, 'limit']), c.name);
    assert.deepEqual([r.limit, r.used, r.remaining], [c.dailyLimit, c.createdLast24h, c.remaining], c.name);
  }
});

test('selectAutoSupply：auto mode でなければ何も自動にせず、全部 auto-mode-off で人に残る', () => {
  const cs = [cand('docs-ok'), cand('guard', { files: ['harness/lib/x.ts'] }), cand('feat', { title: 'feat: x' })];
  const r = select(cs, { autoMode: OFF });
  assert.equal(r.active, false);
  assert.deepEqual(r.create, []);
  assert.deepEqual(r.manual.map((x) => [x.ref, x.reason]), cs.map((c) => [c.ref, 'auto-mode-off']));
  assert.match(r.manual[0]!.detail, /agent:auto-mode が無い/);
});

// --- autoSupplySourceRef ---

test('autoSupplySourceRef：from=patrol の目印だけ ref を返す', () => {
  const cases: [string, string | null][] = [
    ['本文\n\n<!-- agent-harness:issue-source from=patrol ref=arch-review-D3 -->', 'arch-review-D3'],
    ['本文\n\n<!-- agent-harness:issue-source from=intel ref=n12 -->', null],
    ['目印の無い本文', null],
    ['', null],
  ];
  for (const [body, want] of cases) assert.equal(autoSupplySourceRef(body), want, body);
});

// --- autoSupplyReady ---

const SELF = 'me';
const MARK = (ref: string): string => `本文\n\n<!-- agent-harness:issue-source from=patrol ref=${ref} -->`;
const issue = (number: number, over: Partial<AutoSupplyIssue> = {}): AutoSupplyIssue => ({
  number, body: MARK(`r${number}`), author: SELF, createdAt: hoursBefore(1), labels: [], pullRequest: false, ...over,
});
const ready = (target: AutoSupplyIssue, over: { autoMode?: { active: boolean }; recent?: AutoSupplyIssue[]; dailyLimit?: number } = {}) =>
  autoSupplyReady({ autoMode: over.autoMode ?? ON, issue: target, recent: over.recent ?? [target], self: SELF, now: NOW, dailyLimit: over.dailyLimit ?? 1 });

test('autoSupplyReady：すべて満たすと付けてよい', () => {
  assert.deepEqual(ready(issue(10)), { ready: true, reasons: [] });
});

test('autoSupplyReady：条件を1つ外すと、その理由で付けてよいと返さない', () => {
  const earlier = issue(9, { createdAt: hoursBefore(2) });
  const cases: { name: string; target: AutoSupplyIssue; autoMode?: { active: boolean }; recent?: AutoSupplyIssue[]; dailyLimit?: number; reasons: string[] }[] = [
    { name: 'auto mode でない', target: issue(10), autoMode: { active: false }, reasons: ['auto-mode-off'] },
    { name: 'PR', target: issue(10, { pullRequest: true }), reasons: ['pull-request'] },
    { name: '目印なし', target: issue(10, { body: '目印の無い本文' }), reasons: ['no-marker'] },
    { name: 'intel の目印', target: issue(10, { body: '<!-- agent-harness:issue-source from=intel ref=x -->' }), reasons: ['no-marker'] },
    { name: 'ほかの人', target: issue(10, { author: 'someone' }), reasons: ['not-self'] },
    { name: '24 時間より前', target: issue(10, { createdAt: hoursBefore(25) }), reasons: ['too-old'] },
    { name: '今より後', target: issue(10, { createdAt: new Date(NOW.getTime() + HOUR).toISOString() }), reasons: ['too-old'] },
    { name: '時刻が読めない', target: issue(10, { createdAt: 'not-a-date' }), reasons: ['too-old'] },
    { name: '上限を超える順', target: issue(10), recent: [earlier, issue(10)], reasons: ['limit'] },
    { name: '既に agent:ready', target: issue(10, { labels: ['agent:ready'] }), reasons: ['already-ready'] },
    { name: 'dailyLimit 0', target: issue(10), dailyLimit: 0, reasons: ['limit'] },
  ];
  for (const c of cases) {
    const r = ready(c.target, { autoMode: c.autoMode, recent: c.recent ?? [c.target], dailyLimit: c.dailyLimit });
    assert.deepEqual(r, { ready: false, reasons: c.reasons }, c.name);
  }
});

test('autoSupplyReady：auto mode でなければ、ほかの条件がそろっていても偽（理由は全部並ぶ）', () => {
  assert.equal(ready(issue(10), { autoMode: { active: false }, dailyLimit: 100 }).ready, false);
  assert.deepEqual(ready(issue(10, { labels: ['agent:ready'] }), { autoMode: { active: false } }).reasons, ['auto-mode-off', 'already-ready']);
});

test('autoSupplyReady：上限の数え方は、24 時間より前・PR・ほかの人・目印なしを数えず、一覧に対象が無くても対象を数える', () => {
  const recent = [
    issue(5, { createdAt: hoursBefore(25) }),
    issue(6, { createdAt: hoursBefore(3), pullRequest: true }),
    issue(7, { createdAt: hoursBefore(3), author: 'someone' }),
    issue(8, { createdAt: hoursBefore(3), body: '目印の無い本文' }),
  ];
  assert.deepEqual(ready(issue(10), { recent, dailyLimit: 1 }), { ready: true, reasons: [] });
  // 同じ時刻なら番号の順：9 が先、10 は2件目
  const same = hoursBefore(1);
  assert.deepEqual(ready(issue(10, { createdAt: same }), { recent: [issue(10, { createdAt: same }), issue(9, { createdAt: same })], dailyLimit: 1 }).reasons, ['limit']);
  assert.deepEqual(ready(issue(9, { createdAt: same }), { recent: [issue(10, { createdAt: same }), issue(9, { createdAt: same })], dailyLimit: 1 }).reasons, []);
});
