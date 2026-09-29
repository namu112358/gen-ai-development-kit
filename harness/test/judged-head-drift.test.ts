import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractBlock } from '../lib/blocks.ts';
import { judgedHeadError, samePrPatch } from '../lib/patch-id.ts';
import { composeVerdict, type ComposeInput } from '../lib/session-inputs.ts';
import { parseVerdict, RISK_QUESTIONS } from '../lib/verdict.ts';
import { HEAD } from './support/gate-fixtures.ts';
import { sandbox } from './support/git-sandbox.ts';

/**
 * 判定した head と今の head が違うとき、PR 自身の差分（`origin/<base>...<head>` の patch-id）が同じなら
 * 判定した head のまま組み立て・投稿してよいか（samePrPatch・judgedHeadError・composeVerdict の samePatch）。
 */

/**
 * 判定の後に main の取り込みだけで head が変わった PR を git の砂場に作る。
 * judged：PR のファイル p.txt を足した head。merged：そこに main の別ファイル m.txt を merge した head。
 * edited：merged から PR 自身のファイル p.txt を書き換えた head。
 */
function driftedPr() {
  const s = sandbox();
  const { git, root, seed } = s;
  git(root, 'checkout', '-qb', 'claude/issue-3-x', 'origin/main');
  writeFileSync(join(root, 'p.txt'), 'pr\n');
  git(root, 'add', 'p.txt');
  git(root, 'commit', '-qm', 'pr');
  const judged = git(root, 'rev-parse', 'HEAD');
  s.commit(seed, 'm.txt');
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  git(root, 'merge', '-q', '--no-edit', 'origin/main');
  const merged = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'p.txt'), 'pr changed\n');
  git(root, 'commit', '-qam', 'edit');
  const edited = git(root, 'rev-parse', 'HEAD');
  return { ...s, judged, merged, edited };
}

test('samePrPatch：main の別ファイルを merge しただけの head なら true', () => {
  const s = driftedPr();
  try {
    assert.notEqual(s.judged, s.merged);
    assert.equal(samePrPatch('origin/main', s.judged, s.merged, s.root), true);
  } finally {
    s.cleanup();
  }
});

test('samePrPatch：PR 自身のファイルを変えた head なら false', () => {
  const s = driftedPr();
  try {
    assert.equal(samePrPatch('origin/main', s.judged, s.edited, s.root), false);
  } finally {
    s.cleanup();
  }
});

test('samePrPatch：存在しない SHA や git の失敗では false（止める側）', () => {
  const s = driftedPr();
  try {
    assert.equal(samePrPatch('origin/main', 'f'.repeat(40), s.merged, s.root), false);
    assert.equal(samePrPatch('origin/main', s.judged, 'f'.repeat(40), s.root), false);
    assert.equal(samePrPatch('origin/no-such-branch', s.judged, s.merged, s.root), false);
  } finally {
    s.cleanup();
  }
});

test('samePrPatch：diff.noprefix・color.diff などの手元の git の設定の影響を受けない', () => {
  const s = driftedPr();
  try {
    for (const [k, v] of [['diff.noprefix', 'true'], ['color.diff', 'always'], ['color.ui', 'always'], ['diff.mnemonicPrefix', 'true']] as const) {
      s.git(s.root, 'config', k, v);
    }
    assert.equal(samePrPatch('origin/main', s.judged, s.merged, s.root), true, 'main の取り込みだけなら同じ');
    assert.equal(samePrPatch('origin/main', s.judged, s.edited, s.root), false, 'PR 自身の変更が違えば違う（色付きで両方が空の patch-id になっていない）');
  } finally {
    s.cleanup();
  }
});

test('judgedHeadError：head が同じなら null で、samePatch を呼ばない', () => {
  let called = 0;
  assert.equal(judgedHeadError(HEAD, HEAD, () => (called++, false)), null);
  assert.equal(called, 0);
});

test('judgedHeadError：head が違っても patch-id が同じなら null', () => {
  let called = 0;
  assert.equal(judgedHeadError(HEAD, 'c'.repeat(40), () => (called++, true)), null);
  assert.equal(called, 1);
});

test('judgedHeadError：head が違い patch-id も違えば、judge-input からやり直す旨のエラー', () => {
  const e = judgedHeadError(HEAD, 'c'.repeat(40), () => false);
  assert.ok(e !== null);
  assert.ok(e.includes(HEAD) && e.includes('c'.repeat(40)), '両方の head を示す');
  assert.ok(e.includes('patch-id'));
  assert.ok(e.includes('judge-input'));
});

const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe]));
const risk = { level: 'low', answers, rationale: 'docs のみ', facts: { references: 'none', tests: 'none', fileKinds: 'docs' } };
const CURRENT = 'c'.repeat(40);
const input = (patch: Partial<ComposeInput> = {}): ComposeInput => ({
  pr: 5, judgedHead: HEAD, currentHead: CURRENT, reviewer: { pass: true, blocking: [], nonBlocking: [] }, risk, meta: { model: 'm', judgedBy: '付き添いのセッション' }, ...patch,
});

test('compose-verdict：head が違っても samePatch が true なら、判定した head のまま組み立てる', () => {
  const r = composeVerdict(input({ samePatch: true }));
  assert.ok(r.ok, JSON.stringify(r));
  const b = extractBlock(r.value, 'agent-verdict');
  assert.ok(b.found && b.ok);
  const v = parseVerdict(b.value);
  assert.ok(v.ok);
  assert.equal(v.value.headSha, HEAD, '判定した head（今の head ではない）');
  assert.ok(!r.value.includes(CURRENT), '判定していない head を書かない');
});

test('compose-verdict：head が違い samePatch が false なら、judge-input からやり直す旨で止まる', () => {
  const r = composeVerdict(input({ samePatch: false }));
  assert.ok(!r.ok);
  assert.ok(r.errors[0]!.includes('judge-input'));
});

test('compose-verdict：samePatch を渡さなければ、今までどおり head が違えば止まる', () => {
  const r = composeVerdict(input());
  assert.ok(!r.ok);
  assert.ok(r.errors[0]!.includes(HEAD) && r.errors[0]!.includes(CURRENT));
});
