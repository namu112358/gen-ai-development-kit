// Issue #296：docs/setup.md の「## 10. 改行コード」の手順が、ワークスペースの見張りの hook（.claude/hooks/workspace-guard.ts）があっても最後まで進められるか（main の checkout では人がターミナルで行うと書かれ、Issue の worktree では hook が手順の git を止めない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decide } from '../../.claude/hooks/workspace-guard.ts';
import { assertAllow, assertDeny, bash, guardSandbox } from './support/workspace-guard-sandbox.ts';

const root = join(import.meta.dirname, '..', '..');

/** docs/setup.md の「## 10. 改行コード」の節 */
function section10(): string {
  const lines = readFileSync(join(root, 'docs', 'setup.md'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## 10. 改行コード'));
  assert.ok(start !== -1, 'docs/setup.md に「## 10. 改行コード」の節が無い');
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

/** 節の中の `git ...` のコード（手順の git のコマンド） */
const gitCommandsIn = (text: string): string[] => [...new Set([...text.matchAll(/`(git [^`]+)`/g)].map((m) => m[1]!))];

// 人のパソコンの global の pull.ff に左右されないよう、local に pull.ff=false を書く
const sb = guardSandbox({ pullFf: 'false', pullRebase: 'false' });
after(() => sb.cleanup());
const { main, issueWt, ctx } = sb;

/** 手順が使う git のコマンド */
const STEPS = ['git status', 'git pull --ff-only origin main', 'git add --renormalize .', 'git diff --cached --stat', 'git rm -r --cached -q .', 'git reset --hard', 'git ls-files --eol'];
/** 手順のうち作業ツリー・索引を書き換えるもの（main の checkout では hook が止める） */
const REWRITES = ['git add --renormalize .', 'git rm -r --cached -q .', 'git reset --hard'];

test('AC1：節10に、手順は人が自分のターミナルで行うことと、hook（workspace-guard）が main の checkout の書き換えを止める理由が書かれている', () => {
  const s = section10();
  assert.ok(s.includes('ターミナル'), '節10に「ターミナル」が無い（手順は人がターミナルで行う）');
  assert.ok(s.includes('workspace-guard'), '節10に hook（.claude/hooks/workspace-guard.ts）の名前が無い');
  assert.ok(s.includes('worktree'), '節10に worktree での手順が無い');
  assert.ok(s.includes('git pull --ff-only origin main'), '節10の手順2に `git pull --ff-only origin main` が無い');
  for (const cmd of ['git add --renormalize .', 'git rm -r --cached -q .', 'git reset --hard', 'git ls-files --eol']) {
    assert.ok(s.includes(cmd), `節10に \`${cmd}\` が無い`);
  }
});

test('AC1：節10の手順の git のコマンドは、Issue の worktree では hook で止まらない（worktree での手順を最後まで進められる）', () => {
  const inDoc = gitCommandsIn(section10());
  assert.ok(inDoc.length > 0, '節10に git のコマンドが無い');
  for (const cmd of new Set([...inDoc, ...STEPS])) {
    assertAllow(decide(bash(cmd, issueWt), ctx), `${cmd}（Issue の worktree）`);
  }
  // 手順を1つの Bash でつないでも止まらない
  assertAllow(decide(bash(STEPS.join(' && '), issueWt), ctx), '手順をつないだ Bash（Issue の worktree）');
});

test('AC1：main の checkout では、手順のうち書き換えるもの（add・rm・reset）を hook が止め、読むだけのものと pull --ff-only は通す（人がターミナルで行う理由）', () => {
  for (const cmd of REWRITES) assertDeny(decide(bash(cmd, main), ctx), `${cmd}（main）`);
  for (const cmd of ['git status', 'git ls-files --eol', 'git diff --cached --stat', 'git pull --ff-only origin main']) {
    assertAllow(decide(bash(cmd, main), ctx), `${cmd}（main）`);
  }
});
