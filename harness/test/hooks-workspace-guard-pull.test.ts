// Issue #296：ワークスペースの見張りの hook（.claude/hooks/workspace-guard.ts）が、pull.ff=only の設定の main の checkout で素の git pull を通し、rebase を伴う pull を --ff-only があっても止めるか（設定はテストのリポジトリの local に書き、人のパソコンの global の設定に左右されない）
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decide, MARKER, type WorkspaceContext } from '../../.claude/hooks/workspace-guard.ts';
import { assertAllow, assertDeny, bash, git, guardSandbox, sh } from './support/workspace-guard-sandbox.ts';

// ---- 砂場：local の pull.ff・pull.rebase の組み合わせごとに本体を作る ----

/** pull.ff=only・pull.rebase=false（素の pull を通す形） */
const only = guardSandbox({ pullFf: 'only', pullRebase: 'false' });
/** pull.ff=false（未設定と同じ扱い：fast-forward だけではない） */
const ffFalse = guardSandbox({ pullFf: 'false', pullRebase: 'false' });
/** pull.ff=true */
const ffTrue = guardSandbox({ pullFf: 'true', pullRebase: 'false' });
/** pull.ff=only でも pull.rebase=true */
const rebaseTrue = guardSandbox({ pullFf: 'only', pullRebase: 'true' });
/** pull.ff=only・pull.rebase=false でも branch.main.rebase=true */
const branchRebase = guardSandbox({ pullFf: 'only', pullRebase: 'false', config: { 'branch.main.rebase': 'true' } });
after(() => {
  for (const s of [only, ffFalse, ffTrue, rebaseTrue, branchRebase]) s.cleanup();
});

/** 印のあるワークスペース（only の本体とは別の git worktree の一番上に MARKER を置く） */
const marked = join(only.base, 'hq');
git(only.main, 'worktree', 'add', '-q', '-b', 'hq', marked);
writeFileSync(join(marked, MARKER), '');

// ---- AC2：pull.ff=only の main の checkout で素の git pull を通す ----

test('AC2：local に pull.ff=only を書いた main の checkout で、素の git pull・git pull origin main を通す', () => {
  const { main, issueWt, ctx } = only;
  assertAllow(decide(bash('git pull', main), ctx), 'git pull（main）');
  assertAllow(decide(bash('git pull origin main', main), ctx), 'git pull origin main（main）');
  assertAllow(decide(bash('git pull', join(main, 'src')), ctx), 'git pull（main/src）');
  assertAllow(decide(bash(`git -C ${sh(main)} pull`, issueWt), ctx), 'git -C main pull（cwd は worktree）');
  assertAllow(decide(bash(`cd ${sh(main)} && git pull origin main`, issueWt), ctx), 'cd main && git pull origin main');
  assertAllow(decide(bash('git fetch origin && git pull', main), ctx), 'git fetch origin && git pull');
});

test('AC2：通すと決めたオプション（-q・--quiet・-v・--no-rebase・--rebase=false・--prune・--no-tags など）だけの素の pull は通す', () => {
  const { main, ctx } = only;
  const cmds = [
    'git pull -q origin main',
    'git pull --quiet',
    'git pull -v',
    'git pull --verbose origin main',
    'git pull --no-rebase',
    'git pull --rebase=false origin main',
    'git pull --progress',
    'git pull --no-progress',
    'git pull --autostash',
    'git pull --no-autostash',
    'git pull --prune',
    'git pull --no-tags',
    'git pull --tags',
  ];
  for (const cmd of cmds) assertAllow(decide(bash(cmd, main), ctx), `${cmd}（pull.ff=only の main）`);
});

test('AC2：pull.ff が only でない（false・true）とき、main の checkout の素の git pull は今までどおり止める', () => {
  for (const [name, s] of [['pull.ff=false', ffFalse], ['pull.ff=true', ffTrue]] as const) {
    assertDeny(decide(bash('git pull', s.main), s.ctx), `git pull（${name}）`);
    assertDeny(decide(bash('git pull origin main', s.main), s.ctx), `git pull origin main（${name}）`);
    assertDeny(decide(bash('git pull -q origin main', s.main), s.ctx), `git pull -q origin main（${name}）`);
    // --ff-only があれば設定によらず今までどおり通す
    assertAllow(decide(bash('git pull --ff-only', s.main), s.ctx), `git pull --ff-only（${name}）`);
  }
});

test('AC2：pull.ff=only でも、pull.rebase=true・branch.main.rebase=true なら素の git pull を止める', () => {
  assertDeny(decide(bash('git pull', rebaseTrue.main), rebaseTrue.ctx), 'git pull（pull.rebase=true）');
  assertDeny(decide(bash('git pull origin main', rebaseTrue.main), rebaseTrue.ctx), 'git pull origin main（pull.rebase=true）');
  assertDeny(decide(bash('git pull', branchRebase.main), branchRebase.ctx), 'git pull（branch.main.rebase=true）');
});

test('範囲の外：git pull --ff-only に pull.rebase=true の設定が重なるときは、今までどおり通す', () => {
  assertAllow(decide(bash('git pull --ff-only', rebaseTrue.main), rebaseTrue.ctx), 'git pull --ff-only（pull.rebase=true）');
  assertAllow(decide(bash('git pull --ff-only origin main', branchRebase.main), branchRebase.ctx), 'git pull --ff-only origin main（branch.main.rebase=true）');
});

test('AC2：pull.ff=only でも、取り込み方を変えるもの・一覧に無いオプションの付いた素の pull は止める', () => {
  const { main, ctx } = only;
  const cmds = [
    'git pull --no-ff',
    'git pull --ff',
    'git pull --squash',
    'git pull --squ',
    'git pull --no-ff origin main',
    'git pull --commit',
    'git pull --strategy=ours',
    'git pull -s ours',
    'git pull --allow-unrelated-histories',
    'git pull --unknown-option',
    'git pull --rebase',
    'git pull -r',
  ];
  for (const cmd of cmds) assertDeny(decide(bash(cmd, main), ctx), `${cmd}（pull.ff=only の main）`);
});

test('AC2：pull.ff=only でも、コマンド行や環境で設定を変えられる素の pull は止める（-c・--config-env・GIT_CONFIG*・HOME・XDG_CONFIG_HOME）', () => {
  const { main, ctx } = only;
  const cmds = [
    'git -c pull.ff=false pull',
    'git -c x.y=z pull',
    'git -c pull.rebase=true pull origin main',
    'git --config-env=pull.ff=V pull',
    'git --config-env pull.ff=V pull',
    'HOME=/x git pull',
    'XDG_CONFIG_HOME=/x git pull',
    'GIT_CONFIG_GLOBAL=/x git pull',
    'GIT_CONFIG_SYSTEM=/x git pull',
    'GIT_CONFIG_PARAMETERS=x git pull',
    'GIT_CONFIG_COUNT=1 git pull',
    'env HOME=/x git pull',
    'env GIT_CONFIG_GLOBAL=/x git pull',
  ];
  for (const cmd of cmds) assertDeny(decide(bash(cmd, main), ctx), `${cmd}（pull.ff=only の main）`);
});

test('AC2：作業場所が静的に決まらない素の pull は止める（pull.ff=only でも）', () => {
  const { issueWt, ctx } = only;
  assertDeny(decide(bash('git -C "$X" pull', issueWt), ctx), 'git -C "$X" pull');
  assertDeny(decide(bash('cd "$X" && git pull', issueWt), ctx), 'cd "$X" && git pull');
});

test('AC2：pullSettings が無い・null を返す文脈では、素の pull は今のまま止める（設定を読めないときは止める）', () => {
  const { main, ctx } = only;
  const { pullSettings: _drop, ...rest } = ctx;
  const without: WorkspaceContext = rest;
  assertDeny(decide(bash('git pull', main), without), 'pullSettings が無い');
  const unreadable: WorkspaceContext = { ...ctx, pullSettings: () => null };
  assertDeny(decide(bash('git pull', main), unreadable), 'pullSettings が null');
  assertAllow(decide(bash('git pull --ff-only', main), unreadable), 'pullSettings が null でも --ff-only は通す');
});

test('AC2：差し替えた pullSettings の値で、素の pull を通すのは ff が only で rebase が無いか false のときだけ', () => {
  const { main, ctx } = only;
  const withSettings = (ff: string | null, rebase: string | null): WorkspaceContext => ({ ...ctx, pullSettings: () => ({ ff, rebase }) });
  assertAllow(decide(bash('git pull', main), withSettings('only', null)), 'ff=only・rebase なし');
  assertAllow(decide(bash('git pull', main), withSettings('only', 'false')), 'ff=only・rebase=false');
  for (const [ff, rebase] of [
    [null, null],
    ['false', null],
    ['true', null],
    ['only', 'true'],
    ['only', 'merges'],
    ['only', 'interactive'],
  ] as const) {
    assertDeny(decide(bash('git pull', main), withSettings(ff, rebase)), `ff=${ff}・rebase=${rebase}`);
  }
});

// ---- AC3：rebase を伴う pull は --ff-only があっても止める ----

test('AC3：main の checkout で、--ff-only と rebase を求める引数を合わせた pull を止める（省略形・短いオプションの束も）', () => {
  for (const s of [only, ffFalse]) {
    const cmds = [
      'git pull --ff-only --rebase',
      'git pull --rebase --ff-only origin main',
      'git pull --ff-only -r',
      'git pull --ff-only --rebase=merges',
      'git pull --ff-only --rebase=true',
      'git pull --ff-only --rebase=interactive',
      'git pull --ff-only --reb',
      'git pull --ff-only -qr',
    ];
    for (const cmd of cmds) assertDeny(decide(bash(cmd, s.main), s.ctx), `${cmd}（main）`);
    assertDeny(decide(bash(`git -C ${sh(s.main)} pull --ff-only --rebase`, s.issueWt), s.ctx), 'git -C main pull --ff-only --rebase（cwd は worktree）');
  }
});

test('AC3：--ff-only に --no-rebase・--rebase=false を合わせた pull は通す', () => {
  for (const s of [only, ffFalse]) {
    assertAllow(decide(bash('git pull --ff-only --no-rebase', s.main), s.ctx), 'git pull --ff-only --no-rebase');
    assertAllow(decide(bash('git pull --ff-only --rebase=false', s.main), s.ctx), 'git pull --ff-only --rebase=false');
    assertAllow(decide(bash('git pull --ff-only -q origin main', s.main), s.ctx), 'git pull --ff-only -q origin main');
  }
});

test('AC3：rebase を伴う pull も、Issue の worktree では通し、印のあるワークスペースでは止める', () => {
  const { issueWt, ctx } = only;
  assertAllow(decide(bash('git pull --ff-only --rebase', issueWt), ctx), 'git pull --ff-only --rebase（worktree）');
  assertAllow(decide(bash('git pull --rebase origin main', issueWt), ctx), 'git pull --rebase origin main（worktree）');
  assertDeny(decide(bash('git pull --ff-only --rebase', marked), ctx), 'git pull --ff-only --rebase（印のあるワークスペース）');
  assertAllow(decide(bash('git pull --ff-only', marked), ctx), 'git pull --ff-only（印のあるワークスペース：今までどおり通す）');
});

// ---- realContext の pullSettings ----

test('realContext の pullSettings：local の pull.ff・pull.rebase を読み、今のブランチの branch.<名前>.rebase を pull.rebase より先に読む', () => {
  assert.equal(typeof only.ctx.pullSettings, 'function', 'realContext は pullSettings を持つ');
  assert.deepEqual(only.ctx.pullSettings!(only.main), { ff: 'only', rebase: 'false' }, 'pull.ff=only・pull.rebase=false');
  assert.deepEqual(only.ctx.pullSettings!(join(only.main, 'src')), { ff: 'only', rebase: 'false' }, '下のディレクトリからも読む');
  assert.deepEqual(ffTrue.ctx.pullSettings!(ffTrue.main), { ff: 'true', rebase: 'false' }, 'pull.ff=true');
  assert.deepEqual(rebaseTrue.ctx.pullSettings!(rebaseTrue.main), { ff: 'only', rebase: 'true' }, 'pull.rebase=true');
  assert.deepEqual(branchRebase.ctx.pullSettings!(branchRebase.main), { ff: 'only', rebase: 'true' }, 'branch.main.rebase=true が pull.rebase=false より先');
  // branch.main.rebase は main のブランチだけに効き、別のブランチの worktree では pull.rebase を読む
  assert.deepEqual(branchRebase.ctx.pullSettings!(branchRebase.issueWt), { ff: 'only', rebase: 'false' }, 'worktree のブランチ（claude/issue-1-x）では pull.rebase');
});

test('realContext の pullSettings：設定が無ければ null（global・system の設定を読まないようにして確かめる）', () => {
  const s = guardSandbox();
  const emptyGlobal = join(s.allowDir, 'empty-gitconfig');
  writeFileSync(emptyGlobal, '');
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    assert.deepEqual(s.ctx.pullSettings!(s.main), { ff: null, rebase: null }, '未設定');
    git(s.main, 'config', 'pull.ff', 'only');
    assert.deepEqual(s.ctx.pullSettings!(s.main), { ff: 'only', rebase: null }, 'pull.ff だけ');
  } finally {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
    s.cleanup();
  }
});
