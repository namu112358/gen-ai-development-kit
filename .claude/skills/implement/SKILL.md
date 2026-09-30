---
name: implement
description: 人が付き添うセッションで、計画ゲートを通った（または agent:plan-review で人が進めると決めた）Issue を実装し、Draft PR を出す。「#番号 を実装して」「PR を出して」と頼まれたとき、計画の後の段階で使う。
---

# implement（実装）

Routine の implement（[.claude/routine.md](../../routine.md)）を、付き添いのセッションで行う手順。判定はしない（judge の段階）。

## 入力

- Issue 番号
- 計画：`node harness/scripts/agent.ts show-plan <番号>` の出力（App の記録の `gate.plan.files` が触ってよいファイル）。`planCommentBody` が null なら計画コメントは編集されているので、`gate.plan` だけに従う。`agent:plan-review` で止まった Issue（通過した計画が無い）は、人が進めると決めた計画コメントの `files` に従う
- Issue の AC と Validation Requirements

## 手順

1. `node harness/scripts/agent.ts claim <番号> --manual --stage implement` で着手を宣言する（段階の更新。ほかのセッションの宣言があれば止まる。先に宣言したセッションがあって自分の宣言を取り下げて止まったら、作業を始めずに ship / fleet の扱いに従う）。同じ領域の判定前の Agent PR（Draft）が上限で止まったら、AskUserQuestion で人に聞く（急ぐと言われたときだけ `--force`）。
2. `node harness/scripts/agent.ts worktree claude/issue-<番号>-<短い名前>` で worktree を作る（出力がパス。置き場所はリポジトリの外）。以降はそのディレクトリで作業する。`node_modules` が無ければ worktree が `npm ci` まで行う。
3. **test-designer** サブエージェントにテストを書かせる。GitHub は読ませないので、Issue 番号、AC、Validation Requirements、計画の `files` を指示に含めて渡す。
4. 計画の `files` の範囲で実装する。範囲外の変更が要るなら、先に AskUserQuestion で人に聞く（聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方。範囲外として出すなら PR 本文の「範囲外の変更」に理由を書き、計画を出し直すなら plan の skill に戻る）。
5. `npm run check` を通す。
6. commit する。`git add <ファイル>` でファイルを指定する（`-A` や `.` は使わない）。1行目は Issue のタイトルと同じ Conventional Commits の形。
7. `git push -u origin claude/issue-<番号>-<短い名前>` で push する（main への push、force push はしない）。
8. PR を作る前に、worktree で `node harness/scripts/agent.ts scope-check <番号>` を走らせ、変更が計画の `files` に収まるかを App の範囲照合と同じ関数で確かめる（読むだけ。worktree のどのディレクトリから走らせてもよい）。`agent/scope`（ゲートを通った計画）と委任・bypass の範囲照合の両方を見て、終了コードと出力の JSON の `problems`（`check` がどちらの照合か、`kind` が `outside`（範囲の外）か `no-plan`（使える計画が無い））で分ける。
   - 終了コード 0：両方の照合に計画があり、範囲の外が無い。次へ。
   - 終了コード 1（範囲の外のファイルがある。`problems` の `outside` の `files`）：PR を作らずに、計画を出し直す（plan の skill の出し直し）か、その変更を外すかを AskUserQuestion で聞く（聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。変更を外したら、commit・push し直して `scope-check` をもう一度走らせる。
   - 終了コード 3（範囲の外は無いが、どちらかの照合に使える計画が無い。`problems` の `no-plan`。ゲートの停止で止まった計画は `agent/scope` で、Planner の申告で止まり人が進めると決めた計画は両方で計画なし）：聞かずに進め、どの照合（`agent/scope`・委任・bypass）に乗らないかを PR 本文の「人に見てほしい点」に書く。
   - それ以外（終了コード 2 など、JSON が出ずに終わった。引数・git・GitHub のエラー）：照合できていないので、範囲の外が無い扱いにせず、PR を作らずに人に返す。
   - `untracked` にあるファイルは PR にまだ入っていない。入れるものは手順6に戻って commit する。
9. PR を作る前に `node harness/scripts/agent.ts ensure-claim <番号>` で、このセッションの着手宣言が今も持ち主かを確かめる。止まったら PR を出さずに人に返す（ほかのセッションが先に宣言していた、または引き継いだ）。
10. `gh pr create --draft --base main` で **Draft** PR を出す。タイトルは Issue のタイトル。本文は [.github/pull_request_template.md](../../../.github/pull_request_template.md) どおり（`Closes #<番号>`、計画コメントへのリンク、セッション（`node harness/scripts/agent.ts session-url`、無ければ「付き添いのセッション」）、変更の概要、AC ごとの対応、範囲外の変更、人に見てほしい点、テスト）。
11. `node harness/scripts/agent.ts release <番号>` で着手を解除する。
12. `node harness/scripts/agent.ts worktree-remove claude/issue-<番号>-<短い名前>` は、続けて judge・fix をしないときだけ行う。

手順10の `--base main` は通常の PR の出し方。Stacked PR で出すときは次の節に従う。

### Stacked PR で出すとき

使えるのは付き添いのセッションだけ（[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。組み方は [gh-stack](../gh-stack/SKILL.md) の skill。

1. 積む条件を確かめる：上の層が、下の層と同じファイルを触る・下の層が足したもの（関数・型・設定・ファイル）を使う・PR 本文に `Stack: 理由` を書く、のどれかに当たるときだけ積む。当たらなければ別々に `main` 宛てで出す。
2. 1層＝1 Issue。層ごとに手順1・2で claim と worktree を用意する。
3. 上の層の worktree は、作った直後に `git merge --ff-only origin/<下の層のブランチ>` で下の層に合わせる（`node harness/scripts/agent.ts worktree` は新しいブランチを `origin/main` から作るため）。下の層を作った後に main が進んでいて `--ff-only` が失敗したら、先に下の層へ sync の skill で main を取り込んで push し、その後に上の層で `git fetch origin` して `--ff-only` をやり直す。それでも失敗したら上の層を出さずに人に返す。`--ff-only` の代わりに通常の `git merge` をしてはいけない（上の層に新しい main が入り、base（下の層）からの diff に main の変更が混ざって範囲照合と判定を壊す）。
4. 層ごとに手順3〜9を行い、手順10の代わりに `gh pr create --draft --base <下の層のブランチ（一番下の層は main）>` で出す。本文は `Refs #<番号>`（一番上の層は `Closes #<番号>`、どちらも1つだけ）と、条件の3つ目で積むなら `Stack: 理由` の行。
5. 全部の層を出したら、gh-stack の skill の `gh stack link <下の PR 番号> <上の PR 番号>` で組む。上の層は組むまで一時的に orphan-base（Draft と `agent:blocked`）になり、組めば App が戻す。

## 終わりの状態

- `claude/issue-<番号>-<短い名前>` のブランチが push され、`Closes #<番号>` 付きの Draft PR がある。
- Issue に着手の解除コメントがある。
- 判定はまだ無い（judge の段階で行う。PR は Draft のまま）。

## 人に返す条件

- `claim --manual` が領域の上限で止まった
- `claim` が先に宣言したセッションがあるため取り下げて止まった、または `ensure-claim` で止まった（PR を出さない）
- 計画の `files` の外を変える必要がある、または計画どおりでは AC を満たせない
- `scope-check` が範囲の外のファイルを出した（計画を出し直すか、その変更を外すかを AskUserQuestion で聞く）
- `scope-check` が JSON を出さずに終わった（終了コード 2 など。PR を作らない）
- `npm run check` が、この変更と関係ない理由で落ちる
- push や PR の作成が拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge` と `*:exempt` のラベルの付け外し
