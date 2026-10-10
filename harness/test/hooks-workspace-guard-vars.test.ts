// Issue #539：ワークスペースの見張りの hook（.claude/hooks/workspace-guard.ts）が、同じコマンドの中で必ず実行される形で文字のまま代入した変数を、引用符の中の cd・pushd・git -C の行き先として読み、展開を含む値・条件付き・子のシェルなどでは今までどおり止めるか。guard.ts の parseScript が文の前の区切り（before）を返すか
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseScript } from '../../.claude/hooks/guard.ts';
import { decide, type Decision } from '../../.claude/hooks/workspace-guard.ts';
import { assertAllow, assertDeny, bash, guardSandbox, sh } from './support/workspace-guard-sandbox.ts';

const s = guardSandbox();
after(() => s.cleanup());

/** 止めた上で、理由が「静的に決まらない」か「main の checkout」を含むか（ほかの理由で止まったのではないか）を見る */
function assertDenyWhy(d: Decision, label: string, why: readonly string[] = ['静的に決まらない', 'main の checkout']): void {
  assertDeny(d, label);
  if (d.deny) assert.ok(why.some((w) => d.reason.includes(w)), `理由に ${why.join('・')} のどれも無い: ${label}: ${d.reason}`);
}

// ---- AC1：文字のまま代入した変数の行き先を読んで通す ----

test('AC1：cwd が main の checkout でも、文字のまま代入した変数で Issue の worktree に移った git の書き込みは通す', () => {
  const { main, issueWt, ctx } = s;
  const wt = sh(issueWt);
  const cmds = [
    `W="${wt}"; cd "$W" && git merge --ff-only origin/x -q`,
    `W=${wt}; git -C "\${W}" merge x`,
    `W="${wt}"\ncd "$W/src" && git commit -m x`,
    `W=${wt}; pushd "$W" && git add .`,
  ];
  for (const cmd of cmds) assertAllow(decide(bash(cmd, main), ctx), cmd);
});

// ---- AC2：読めない・読んではいけない形は今までどおり止める ----

test('AC2：値に展開を含む・同じシェルに残らない・必ず実行されない・上書きされた・読み方が危ない変数の行き先は今までどおり止める', () => {
  const { main, issueWt, ctx } = s;
  const wt = sh(issueWt);
  const m = sh(main);
  const cmds = [
    `W="$(echo ${wt})"; cd "$W" && git merge x`,
    // 代入が別の Bash の呼び出し（このコマンドには代入が無い）
    `cd "$W" && git merge x`,
    `true && W=${wt}; cd "$W" && git merge x`,
    `(W=${wt}); cd "$W" && git merge x`,
    `W=${wt} | true; cd "$W" && git merge x`,
    `W=${wt} |& true; cd "$W" && git merge x`,
    `if true; then W=${wt}; fi; cd "$W" && git merge x`,
    `W=${wt}; W="$(pwd)"; cd "$W" && git merge x`,
    `W=${wt}; export W=$X; cd "$W" && git merge x`,
    // 引用符なし
    `W=${wt}; cd $W && git merge x`,
    // 名前の切れ目（$Wx は W ではない）
    `W=${wt}; cd "$Wx" && git merge x`,
    // 値に空白
    `W="${wt} x"; cd "$W" && git merge x`,
    `W=${wt}; bash -c 'cd "$W" && git merge x'`,
    // 前置きの代入付きの eval（eval の中の W は main）
    `W=${wt}; W=${m} eval 'cd "$W" && git merge x'`,
    `IFS=/; W=${wt}; cd "$W" && git merge x`,
    `case x in a) ;; esac; (W=${wt}); cd "$W" && git merge x`,
  ];
  for (const cmd of cmds) assertDenyWhy(decide(bash(cmd, main), ctx), cmd);
});

test('AC2：値が main の checkout なら、覚えた上で今までどおり main の checkout として止める', () => {
  const { main, issueWt, ctx } = s;
  const cmd = `W=${sh(main)}; cd "$W" && git merge x`;
  assertDenyWhy(decide(bash(cmd, issueWt), ctx), cmd, ['main の checkout']);
});

test('AC2：引用符の境目で名前が切れる使い方（"$W"o）は、別の変数（Wo）として読まずに止める', () => {
  const { main, issueWt, ctx } = s;
  const wt = sh(issueWt);
  const cmds = [
    `Wo=${wt}; cd "$W"o && git merge x`,
    `Wo=${wt}; cd "$W"'o' && git merge x`,
    `W=${wt}; cd "\${W}"o && git merge x`,
  ];
  for (const cmd of cmds) assertDenyWhy(decide(bash(cmd, main), ctx), cmd);
  // 名前の後が / で始まる使い方は今までどおり読む
  const ok = `W=${wt}; cd "$W"/src && git commit -m x`;
  assertAllow(decide(bash(ok, main), ctx), ok);
});

test('AC2：関数の定義・trap・readonly・declare などの文の後は、覚えた代入の値を信用せずに止める', () => {
  const { main, issueWt, ctx } = s;
  const wt = sh(issueWt);
  const m = sh(main);
  const cmds = [
    `f() { W=${m}; }; W=${wt}; f; cd "$W" && git merge x`,
    `function f { W=${m}; }; W=${wt}; f; cd "$W" && git merge x`,
    `trap 'W=${m}' DEBUG; W=${wt}; cd "$W" && git merge x`,
    `readonly W=${m}; W=${wt}; cd "$W" && git merge x`,
    `declare -n W=Z; W=${wt}; Z=${m}; cd "$W" && git merge x`,
  ];
  for (const cmd of cmds) assertDenyWhy(decide(bash(cmd, main), ctx), cmd);
});

// ---- guard.ts の parseScript の before ----

test('parseScript：各文に直前の区切り（before）を入れる', () => {
  assert.deepEqual(
    parseScript('a; b && c | d').map((seg) => seg.before),
    ['', ';', '&&', '|'],
  );
});
