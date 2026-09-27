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

1. `node harness/scripts/agent.ts claim <番号> --manual --stage implement` で着手を宣言する（段階の更新。ほかのセッションの宣言があれば止まる）。同じ領域の開いた PR が上限で止まったら、人に聞く（急ぐと言われたときだけ `--force`）。
2. `node harness/scripts/agent.ts worktree claude/issue-<番号>-<短い名前>` で worktree を作る（出力がパス。置き場所はリポジトリの外）。以降はそのディレクトリで作業する。`node_modules` が無ければ `npm ci`。
3. **test-designer** サブエージェントにテストを書かせる。GitHub は読ませないので、Issue 番号、AC、Validation Requirements、計画の `files` を指示に含めて渡す。
4. 計画の `files` の範囲で実装する。範囲外の変更が要るなら、先に人に聞く（出すなら PR 本文の「範囲外の変更」に理由を書く）。
5. `npm run check` を通す。
6. commit する。`git add <ファイル>` でファイルを指定する（`-A` や `.` は使わない）。1行目は Issue のタイトルと同じ Conventional Commits の形。
7. `git push -u origin claude/issue-<番号>-<短い名前>` で push する（main への push、force push はしない）。
8. `gh pr create --draft --base main` で **Draft** PR を出す。タイトルは Issue のタイトル。本文は [.github/pull_request_template.md](../../../.github/pull_request_template.md) どおり（`Closes #<番号>`、計画コメントへのリンク、セッション（`node harness/scripts/agent.ts session-url`、無ければ「付き添いのセッション」）、変更の概要、AC ごとの対応、範囲外の変更、人に見てほしい点、テスト）。
9. `node harness/scripts/agent.ts release <番号>` で着手を解除する。
10. `node harness/scripts/agent.ts worktree-remove claude/issue-<番号>-<短い名前>` は、続けて judge・fix をしないときだけ行う。

## 終わりの状態

- `claude/issue-<番号>-<短い名前>` のブランチが push され、`Closes #<番号>` 付きの Draft PR がある。
- Issue に着手の解除コメントがある。
- 判定はまだ無い（judge の段階で行う。PR は Draft のまま）。

## 人に返す条件

- `claim --manual` が領域の上限で止まった
- 計画の `files` の外を変える必要がある、または計画どおりでは AC を満たせない
- `npm run check` が、この変更と関係ない理由で落ちる
- push や PR の作成が拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped` と `*:exempt` のラベルの付け外し
