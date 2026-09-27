import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import type { IssueComment } from '../lib/github.ts';
import { lowerLayers, renderJudgeInput, type JudgeFacts, type StackFacts } from '../lib/session-inputs.ts';
import { config, HEAD, pr } from './support/gate-fixtures.ts';

/**
 * judge-input のスタックの節（Stacked PR の base・スタックの位置・下の層の PR 番号と変更ファイル）と、
 * 再レビューの補足の diff の取り方を PR の base に合わせること。下の層をたどる lowerLayers。
 */

const OLD_HEAD = 'c'.repeat(40);
const STACK_HEADER = '=== スタック（Stacked PR の層。参考：積む必要性の検査の材料）';

const stack = (patch: Partial<StackFacts> = {}): StackFacts => ({
  base: 'feature/l2', number: 1, position: 3, size: 3,
  lower: [{ number: 11, base: 'feature/l1', files: ['harness/lib/a.ts', 'docs/b.md'] }, { number: 10, base: 'main', files: ['harness/lib/c.ts'] }],
  ...patch,
});
const facts = (patch: Partial<JudgeFacts> = {}): JudgeFacts => ({
  pr: { number: 12, headSha: HEAD, body: 'Closes #3', baseRef: 'feature/l2' }, issues: [], prComments: [], checkRuns: [],
  prState: { state: 'open', draft: true, merged: false }, ...patch,
});

function verdictComment(headSha: string): IssueComment {
  return {
    id: 1, html_url: 'v', created_at: '2026-09-26T00:00:00Z', updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' },
    body: `${CLAUDE_MARK}\n## 判定\n\n${renderBlock('agent-verdict', { version: 1, headSha, review: { pass: true, blocking: [] } })}`,
  };
}
const commit = (sha: string, parents = 1) => ({ sha, parents: Array.from({ length: parents }, (_, i) => ({ sha: `${sha}-p${i}` })) });

// ---- スタックの節 ----

test('judge-input：Stacked PR の層なら base・位置・スタック番号と、下の層ごとの PR 番号・base・変更ファイルを載せる', () => {
  const text = renderJudgeInput(config, facts({ stack: stack() }));
  assert.ok(text.includes(`${STACK_HEADER}\nbase: feature/l2 / 位置: 3 / 3（スタック #1）`), text);
  assert.ok(text.includes('--- PR #11（base feature/l1）\n変更ファイル: harness/lib/a.ts, docs/b.md'), text);
  assert.ok(text.includes('--- PR #10（base main）\n変更ファイル: harness/lib/c.ts'), text);
  assert.ok(text.indexOf('--- PR #11') < text.indexOf('--- PR #10'), '下の層は近い順');
});

test('judge-input：スタックの節は PR の状態の直後、過去の PR のコメントの前に入る', () => {
  const text = renderJudgeInput(config, facts({ stack: stack() }));
  const state = text.indexOf('=== PR の状態（参考。合体版の段階0の材料）');
  const section = text.indexOf(STACK_HEADER);
  const past = text.indexOf('=== 過去の PR のコメント');
  assert.ok(state >= 0 && state < section && section < past, `${state} ${section} ${past}`);
});

test('judge-input：一番下の層（下の層が無い）は (なし)、スタックの層でなければその旨、stack を渡さなければ節が無い', () => {
  const bottom = renderJudgeInput(config, facts({ stack: stack({ base: 'main', position: 1, lower: [] }) }));
  assert.ok(bottom.includes(`${STACK_HEADER}\nbase: main / 位置: 1 / 3（スタック #1）\n(なし)`), bottom);
  const notLayer = renderJudgeInput(config, facts({ stack: null }));
  assert.ok(notLayer.includes(`${STACK_HEADER}\n(スタックの層ではありません)`), notLayer);
  assert.ok(!renderJudgeInput(config, facts()).includes('=== スタック'));
});

test('judge-input：stack・baseRef を渡さない既存の呼び出しは、先頭2行が同じでスタックの節が無い', () => {
  const plain = { pr: { number: 12, headSha: HEAD, body: 'Closes #3' }, issues: [], prComments: [], checkRuns: [], prState: { state: 'open', draft: true, merged: false } };
  const text = renderJudgeInput(config, plain);
  assert.ok(text.startsWith(`headSha: ${HEAD}\nPR #12 issues=(なし)\n`));
  assert.ok(!text.includes('=== スタック'));
});

// ---- 再レビューの補足の diff を PR の base に合わせる ----

test('再レビューの範囲：Stacked PR は base の取り込みを見て、diff を origin/<base>...<head> で取る', () => {
  const commits = [commit(OLD_HEAD), commit('m1', 2), commit(HEAD)];
  const text = renderJudgeInput(config, facts({ prComments: [verdictComment(OLD_HEAD)], commits, stack: stack() }));
  assert.ok(text.includes('`git diff origin/feature/l2...<head>`'), text);
  assert.ok(!text.includes('origin/main...'), text);
  assert.ok(text.includes('feature/l2 の取り込みがあります（m1）'), text);
  const none = renderJudgeInput(config, facts({ prComments: [verdictComment(OLD_HEAD)], commits: [commit(OLD_HEAD), commit(HEAD)] }));
  assert.ok(none.includes('feature/l2 の取り込みはありません'), none);
});

test('再レビューの範囲：baseRef が無い・既定ブランチ宛ての PR は今までどおり origin/main', () => {
  const commits = [commit(OLD_HEAD), commit('m1', 2), commit(HEAD)];
  for (const pr of [{ number: 12, headSha: HEAD, body: null }, { number: 12, headSha: HEAD, body: null, baseRef: 'main' }]) {
    const text = renderJudgeInput(config, facts({ pr, prComments: [verdictComment(OLD_HEAD)], commits }));
    assert.ok(text.includes('=== 再レビューの範囲（補足）\n前回の head の後に main の取り込みがあります（m1）'), text);
    assert.ok(text.includes('`git diff origin/main...<head>`'), text);
  }
});

// ---- lowerLayers（下の層をたどる純粋な関数） ----

const layerPr = (number: number, head: string, base: string, repo = 'o/r') => pr({ number, head: { ref: head, sha: HEAD, repo: { full_name: repo } }, base: { ref: base, sha: 'b'.repeat(40) } });
const top = layerPr(12, 'feature/l3', 'feature/l2');
const open = [layerPr(12, 'feature/l3', 'feature/l2'), layerPr(11, 'feature/l2', 'feature/l1'), layerPr(10, 'feature/l1', 'main'), layerPr(20, 'feature/x', 'main')];

test('lowerLayers：base をたどって下の層を近い順に返し、既定ブランチ宛ての層で止まる', () => {
  assert.deepEqual(lowerLayers(open, top, 'main', 'o/r', 10), [{ number: 11, base: 'feature/l1' }, { number: 10, base: 'main' }]);
});

test('lowerLayers：既定ブランチ宛ての PR・base の PR が見つからないときは、そこで止まる', () => {
  assert.deepEqual(lowerLayers(open, layerPr(10, 'feature/l1', 'main'), 'main', 'o/r', 10), []);
  assert.deepEqual(lowerLayers(open, layerPr(30, 'feature/y', 'feature/gone'), 'main', 'o/r', 10), []);
  const gap = [layerPr(11, 'feature/l2', 'feature/gone')];
  assert.deepEqual(lowerLayers(gap, top, 'main', 'o/r', 10), [{ number: 11, base: 'feature/gone' }]);
});

test('lowerLayers：上限の件数で止まる（循環しても終わる）', () => {
  assert.deepEqual(lowerLayers(open, top, 'main', 'o/r', 1), [{ number: 11, base: 'feature/l1' }]);
  const loop = [layerPr(1, 'a', 'b'), layerPr(2, 'b', 'a')];
  assert.ok(lowerLayers(loop, layerPr(3, 'c', 'a'), 'main', 'o/r', 5).length <= 5);
});

test('lowerLayers：別リポジトリ（fork）の PR は同じ head の名前でも拾わない', () => {
  const forked = [layerPr(40, 'feature/l2', 'feature/l1', 'evil/r'), layerPr(10, 'feature/l1', 'main')];
  assert.deepEqual(lowerLayers(forked, top, 'main', 'o/r', 10), []);
});
