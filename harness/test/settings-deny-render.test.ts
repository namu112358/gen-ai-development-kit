// 配る deny の雛形の既定ブランチへの push の3行（{{defaultBranch}} の置き場所）を renderDeny が導入先の既定ブランチで埋めることを確かめる（Issue #868）。
// 置き場所の行の数、develop で埋めた規則の当たり方、main で埋めると .claude/settings.json の deny と同じこと、不正な名前で throw することをここだけで見る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BRANCH_PLACEHOLDER, renderDeny } from '../lib/settings-deny.ts';
import { denyOf, hits, SETTINGS, TEMPLATE } from './support/settings-deny.ts';

const pushRules = (deny: string[], cmd: string): string[] => hits(deny, cmd).filter((r) => r.startsWith('Bash(git push'));

test('雛形の置き場所の行はちょうど3行で、develop で埋めると develop への push だけに当たる', () => {
  const template = denyOf(TEMPLATE);
  assert.equal(template.filter((r) => r.includes(DEFAULT_BRANCH_PLACEHOLDER)).length, 3);
  const deny = renderDeny(template, 'develop');
  for (const cmd of ['git push origin develop', 'git push origin HEAD:develop', 'git push origin feature:develop']) {
    assert.ok(pushRules(deny, cmd).length > 0, `当たるべき: ${cmd}`);
  }
  for (const cmd of ['git push -u origin claude/issue-1-x', 'git push origin feature:develop-x']) {
    assert.deepEqual(pushRules(deny, cmd), [], `当たるべきでない: ${cmd}`);
  }
});

test('雛形を main で埋めると .claude/settings.json の permissions.deny と同じ', () => {
  assert.deepEqual(renderDeny(denyOf(TEMPLATE), 'main'), denyOf(SETTINGS));
});

test('既定ブランチが空・*・)・空白を含むなら throw する', () => {
  const template = denyOf(TEMPLATE);
  for (const name of ['', '*', 'a)', 'my branch']) {
    assert.throws(() => renderDeny(template, name), `throw するべき: ${JSON.stringify(name)}`);
  }
});
