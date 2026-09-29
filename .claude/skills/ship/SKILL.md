---
name: ship
description: 人が付き添うセッションで、Issue 番号を受け取り、plan → implement → judge → fix（必要なら sync）の skill をつないで、人の Merge 待ちか人の判断待ちまで進める。最後に人がすることを一覧にする。「#番号 を進めて」「#番号 を ship して」「〜を Issue にして進めて」と頼まれたときに使う。
---

# ship（Issue を一続きに進める）

plan・implement・judge・fix・sync の各 skill（[.claude/skills/](../)）を、Issue の状態に応じてつなぐ手順。各段階の中身は各 skill に従い、ここに写さない。

## 入力

- Issue 番号
- Issue がまだ無い依頼（「〜を Issue にして進めて」）なら、Issue Form（`.github/ISSUE_TEMPLATE/agent-task.yml`）の見出しと、タイトルの書式（`harness/lib/title.ts` の `parseTitle`、Conventional Commits）に合わせて `gh issue create` で作り、その番号で手順1から進める。人が「作るだけ」と言わない限り、作った Issue は同じセッションで plan まで進める
- Issue の状態：ラベル（`agent:plan-ok`・`agent:plan-review`・`epic`・`agent:waiting`・`agent:blocked`・`agent:hold`）と、`gh issue view <番号> --comments` の本文・コメント
- 計画ゲートの記録：`node harness/scripts/agent.ts show-plan <番号>`
- Issue を Closes する開いた PR：`gh issue view <番号> --json closedByPullRequestsReferences`

## 手順

1. 状態を読み、次の段階を決める。PR があれば手順4から、計画ゲートを通った計画があれば手順3から始める。
   - 着手宣言：Issue に手を付ける最初に、その段階の skill の手順どおり `claim <番号> --manual --stage <段階>` で宣言する（計画・批評の前も）。宣言にはこのセッションの ID が入り、ほかのセッションとダッシュボードに段階が見える。ほかのセッションの宣言があれば `claim` は止まるので、引き継ぐかを AskUserQuestion で人に聞く（引き継ぐのは人が決めたときだけ `--takeover`）。
   - 人の判断待ちで止めてセッションを終えるときは `node harness/scripts/agent.ts release <番号>` で解除する（宣言が残ると、ほかのセッションを待たせ、期限切れとして報告される）。`post-plan` はゲートを通らない見込みなら自分で解除する。`/clear` などでセッション ID が変わったら、自分の古い宣言は人に確かめて `claim --takeover` で出し直す。
   - `agent:hold`・`agent:blocked`・`agent:waiting` が付いている：進めずに人に返す。
   - `epic`：App の記録（`kind=epic-split`）の子課題を、依存の順に1つずつこの手順で進める。1つが人の Merge 待ちか人の判断待ちになったら、そこで人に返す（次の子課題は、その Merge の後）。
2. 計画が無ければ plan の skill で計画を書いて投稿する。批評の止める条件や `drop` に当たったら、plan の skill どおり「進める／直す／やめる」を AskUserQuestion で聞く。App の計画ゲートの結果が付くのを待つ（`gh issue view <番号> --json labels`）。
   - `agent:plan-ok`：次へ。
   - `agent:plan-review`（critical、ガードレールに触れる、人の判断が要る など）：宣言が残っていれば（`post-plan` の出力の `claim` が `plan-gate`）先に `release <番号>` で解除する。理由を示し、進めてよいかを AskUserQuestion で聞く（選択肢は、進める・止める、止めた理由が計画で直せる（ゲートの停止）なら計画を直して出し直す（plan の skill の出し直しの扱い）も）。人が進めてよいと答えれば次へ（[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の規則どおり。implement の `claim --stage implement` で宣言し直す）。答えなければ人に返す。
     - Planner の申告（理由コード `needs-decision`）なら、plan の skill の手順9どおり人の答えを `agent-decision` で記録し（`post-decision`）、App の `plan-decision` の結果を待つ。`enforce` で通れば次へ、`shadow` なら人が「進める」と言えば次へ（ラベルを外すよう人に頼まない）。答えで計画が変わるなら、App が判定し直した後（`agent:plan-ok` か `gate` の停止）に計画を出し直す。
   - `epic`：手順1の `epic` に戻る。
3. implement の skill で実装し、Draft PR を出す。worktree は消さずに続ける。
4. judge の skill で判定する。現在の head にコラボレーターのレビューがあれば、先に fix の skill をする。
5. 判定にブロッキング指摘があれば（App の `kind=fix-request`）、fix の skill で直し、判定をやり直す。PR が main と衝突している、または main への追従が要るときは sync の skill をする。修正の上限（`agent:blocked`、理由コード `fix-limit`）に達したら人に返す。
6. 合格して Ready になったら、Merge の経路を確かめる。
   - 自動 Merge：App が auto-merge を付けたこと（`gh pr view <PR番号> --json autoMergeRequest` が null でない）。
   - Human Merge：App のコメント（本文に `kind=human-review`、作成者が App）が PR に付いたこと（[docs/operations.md](../../../docs/operations.md) の「Human Merge の依頼」）。
   - 数分待ってもどちらも無ければ、App の記録（`kind=acceptance` の `autoEligible` と `reasons`）を読んで人に返す。
7. 続けて使わなければ `node harness/scripts/agent.ts worktree-remove claude/issue-<番号>-<短い名前>` で worktree を消す。
8. ラベル（`priority:*`・`area:*`）は、まず Jev に任せる（[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。扱った Issue（Epic なら親と子課題）に、App の名義（`appSlug` の App が書いたコメント）の `kind=label-triage` の記録があり、その `notApplied`（下限未満で付けなかったもの）がまだ足りなければ、本文と Jev の提案を見て決めて付け、付けたラベルと理由を Issue のコメントに残す。記録が無ければ付けない。人や App が付けたラベル・`type:*`・違反は変えない。不足や違反を手順9の一覧に書かず、人にも聞かない。
9. 人に**人がすること**の一覧を出す。
   - Merge：Human Merge なら PR を確認して Merge する。自動 Merge なら何もしない（止めたければ `agent:hold`）。
   - 例外ラベル：`test:exempt` は自動 Merge の対象の PR で `agent/tests` が failure のときだけ（Human Merge の PR では付けず、依頼のコメントに載ったテストの変更を Merge の前に確かめる、を「Merge」の項に書く）。`review:exempt` は付けるかの判断。どちらも、その理由を書いた場所（Issue か PR のコメント）
   - `node harness/scripts/setup.ts` の実行が要る変更か（ラベル・Ruleset・Environment・App の設定を変えた）
   - Merge 後の確かめ（Issue の Validation Requirements、AC のうち Merge 後に確かめるもの）

## 終わりの状態

- 次のどちらか。
  - 人の Merge 待ち：Ready の PR があり、App が auto-merge を付けたか、`kind=human-review` のコメントを付けた。
  - 人の判断待ち：どの段階の、何を決めてほしいかを AskUserQuestion で聞いた（拒まれた・答えが無いときは文章で示した）。
- 人がすることの一覧を出した。

## 人に返す条件

- Issue に `agent:hold`・`agent:blocked`・`agent:waiting` が付いている
- 計画の批評が止める条件に当たった、または `drop`（「進める／直す／やめる」を AskUserQuestion で聞く）
- 計画ゲートで止まり（`agent:plan-review`）、人が進めてよいと言わない
- 判定の不合格が修正の上限を超えた（`fix-limit`）
- 両方の意図を残して解消できない衝突がある
- Ready になっても、App が auto-merge も `kind=human-review` も付けない
- 各 skill の「人に返す条件」に当たった
- 操作が deny などで拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-merge` と `*:exempt` のラベルの付け外し
