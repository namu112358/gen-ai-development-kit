---
name: ship
description: 人が付き添うセッションで、Issue 番号を受け取り、plan → implement → judge → fix（必要なら sync）の skill をつないで、人の Merge 待ちか人の判断待ちまで進める。最後に人がすることを一覧にする。「#番号 を進めて」「#番号 を ship して」と頼まれたときに使う。
---

# ship（Issue を一続きに進める）

plan・implement・judge・fix・sync の各 skill（[.claude/skills/](../)）を、Issue の状態に応じてつなぐ手順。各段階の中身は各 skill に従い、ここに写さない。

## 入力

- Issue 番号
- Issue の状態：ラベル（`agent:plan-ok`・`agent:plan-review`・`epic`・`agent:waiting`・`agent:blocked`・`agent:hold`）と、`gh issue view <番号> --comments` の本文・コメント
- 計画ゲートの記録：`node harness/scripts/agent.ts show-plan <番号>`
- Issue を Closes する開いた PR：`gh issue view <番号> --json closedByPullRequestsReferences`

## 手順

1. 状態を読み、次の段階を決める。PR があれば手順4から、計画ゲートを通った計画があれば手順3から始める。
   - `agent:hold`・`agent:blocked`・`agent:waiting` が付いている：進めずに人に返す。
   - `epic`：App の記録（`kind=epic-split`）の子課題を、依存の順に1つずつこの手順で進める。1つが人の Merge 待ちか人の判断待ちになったら、そこで人に返す（次の子課題は、その Merge の後）。
2. 計画が無ければ plan の skill で計画を書いて投稿する。批評の止める条件や `drop` に当たったら、plan の skill どおり「進める／直す／やめる」を聞く。App の計画ゲートの結果が付くのを待つ（`gh issue view <番号> --json labels`）。
   - `agent:plan-ok`：次へ。
   - `agent:plan-review`（critical、ガードレールに触れる、人の判断が要る など）：理由を人に示す。付き添いのセッションなので、人が進めてよいと言えば次へ（CLAUDE.md の規則どおり）。言わなければ人に返す。
   - `epic`：手順1の `epic` に戻る。
3. implement の skill で実装し、Draft PR を出す。worktree は消さずに続ける。
4. judge の skill で判定する。現在の head にコラボレーターのレビューがあれば、先に fix の skill をする。
5. 判定にブロッキング指摘があれば（App の `kind=fix-request`）、fix の skill で直し、判定をやり直す。PR が main と衝突している、または main への追従が要るときは sync の skill をする。修正の上限（`agent:blocked`、理由コード `fix-limit`）に達したら人に返す。
6. 合格して Ready になったら、Merge の経路を確かめる。
   - 自動 Merge：App が auto-merge を付けたこと（`gh pr view <PR番号> --json autoMergeRequest` が null でない）。
   - Human Merge：App のコメント（本文に `kind=human-review`、作成者が App）が PR に付いたこと（[docs/operations.md](../../../docs/operations.md) の「Human Merge の依頼」）。
   - 数分待ってもどちらも無ければ、App の記録（`kind=acceptance` の `autoEligible` と `reasons`）を読んで人に返す。
7. 続けて使わなければ `node harness/scripts/agent.ts worktree-remove claude/issue-<番号>-<短い名前>` で worktree を消す。
8. `node harness/scripts/agent.ts label-audit <Issue番号> <PR番号>` で、扱った Issue・PR（Epic なら親と子課題も）に必須ラベルの不足や違反が無いかを確かめる。あれば手順9の一覧に書く（ラベルは付け外ししない）。
9. 人に**人がすること**の一覧を出す。
   - Merge：Human Merge なら PR を確認して Merge する。自動 Merge なら何もしない（止めたければ `agent:hold`）。
   - 例外ラベル：`test:exempt`・`review:exempt` を付けるかの判断と、その理由を書いた場所（Issue か PR のコメント）
   - `node harness/scripts/setup.ts` の実行が要る変更か（ラベル・Ruleset・Environment・App の設定を変えた）
   - Merge 後の確かめ（Issue の Validation Requirements、AC のうち Merge 後に確かめるもの）
   - ラベルの不足・違反（手順8で見つかったもの。付けるか直すかは人が決める）

## 終わりの状態

- 次のどちらか。
  - 人の Merge 待ち：Ready の PR があり、App が auto-merge を付けたか、`kind=human-review` のコメントを付けた。
  - 人の判断待ち：どの段階の、何を決めてほしいかを人に示した。
- 人がすることの一覧を出した。

## 人に返す条件

- Issue に `agent:hold`・`agent:blocked`・`agent:waiting` が付いている
- 計画の批評が止める条件に当たった、または `drop`（「進める／直す／やめる」を聞く）
- 計画ゲートで止まり（`agent:plan-review`）、人が進めてよいと言わない
- 判定の不合格が修正の上限を超えた（`fix-limit`）
- 両方の意図を残して解消できない衝突がある
- Ready になっても、App が auto-merge も `kind=human-review` も付けない
- 各 skill の「人に返す条件」に当たった
- 操作が deny などで拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped` と `*:exempt` のラベルの付け外し
