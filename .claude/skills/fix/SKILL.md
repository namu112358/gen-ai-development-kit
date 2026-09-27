---
name: fix
description: 人が付き添うセッションで、Agent PR のブロッキング指摘（App の変更要求レビュー）や人のレビューを直して push し、判定をやり直す。「PR #番号 の指摘を直して」と頼まれたとき、判定の後の段階で使う。
---

# fix（修正）

Routine の fix（[.claude/routine.md](../../routine.md)）を、付き添いのセッションで行う手順。対象は `claude/` ブランチの Agent PR だけ（人の PR は直さない）。

## 入力

- PR 番号
- 直す指摘：App の最新の変更要求レビュー（本文に `kind=fix-request`、作成者が App）のブロッキング指摘と、現在の head へのコラボレーターのレビュー（Claude・App 以外、Comment か Request changes）。`gh pr view <PR番号> --comments` と `gh api repos/{owner}/{repo}/pulls/<PR番号>/reviews` で読む
- 計画の `files`（`node harness/scripts/agent.ts show-plan <Issue番号>`）

## 手順

1. `node harness/scripts/agent.ts claim <PR番号> --manual` で着手を宣言する。
2. `node harness/scripts/agent.ts worktree <PR のブランチ>` で worktree を作り（出力がパス）、そこで作業する。
3. 指摘を直す。計画の `files` の範囲で直す。
4. テストの assert の行を書き換える・消す必要があるときは、書き方を変えて改ざん検査（`agent/tests`）を逃れない。理由を Issue か PR にコメントし、人に `test:exempt` を付けてもらうよう頼む（自分では付けない）。
5. `npm run check` を通す。
6. `git add <ファイル>` でファイルを指定して commit し、`git push` する（force push しない。main への追従が要るなら sync の手順で merge する）。
7. 何を直したかを PR にコメントする（先頭に `<!-- agent-harness:claude -->`）。
8. `node harness/scripts/agent.ts release <PR番号>` で着手を解除する。
9. judge の手順で判定をやり直す（再レビュー。前回の判定の head からの差分と前回の指摘だけがブロッキングの対象）。

## 終わりの状態

- 指摘を直したコミットが PR のブランチに push され、何を直したかのコメントがある。
- 新しい head への判定が投稿され、App が受け付けている（judge の終わりの状態）。

## 人に返す条件

- 指摘が要件・AC の変更を求めている、または指摘どうし・計画と食い違う
- テストの assert を変える必要がある（`test:exempt` を頼む）
- 計画の `files` の外を変える必要がある
- 修正回数の上限（App が `agent:blocked`、理由コード `fix-limit`）に達した
- やってはいけないこと：force push、Merge、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped` と `*:exempt` のラベルの付け外し
