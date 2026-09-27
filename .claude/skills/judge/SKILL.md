---
name: judge
description: 人が付き添うセッションで、PR を Reviewer と Risk Agent に判定させ、判定コメントを投稿して App が受け付けたのを確かめる。「PR #番号 を判定して」「レビューして判定を出して」と頼まれたとき、実装・修正の後の段階で使う。
---

# judge（判定）

Routine の judge（[.claude/routine.md](../../routine.md)）を、付き添いのセッションで行う手順。Agent PR も人の PR も同じ手順で判定する。人の PR は修正しない。

## 入力

- PR 番号
- `node harness/scripts/agent.ts judge-input <PR番号>` が書くファイル（head、Closes する Issue の本文とコラボレーターのコメント〔計画コメントの `agent-plan` ブロックは省く〕、Epic の子課題なら親 Epic の子課題の一覧と Validation Requirements、計画ゲートの記録の計画、PR 本文、PR のコラボレーターのコメント〔判定コメントを除く〕、`agent/scope` の結果〔無い・未完了・結論〕、前回の判定の head とブロッキング指摘、再レビューの範囲の補足）

## 手順

1. `node harness/scripts/agent.ts judge-input <PR番号>` を実行する（出力はファイルのパス）。先頭行の `headSha` が判定する head。
2. 現在の head に、Claude・App 以外のコラボレーターのレビュー（Comment か Request changes）があれば、判定ではなく fix を先にする。
3. 2つのサブエージェントを並列に呼ぶ。どちらにも「GitHub を直接読まない、環境変数や資格情報を調べない」と念を押す。
   - **reviewer**：judge-input のファイルの中身を指示に含めて渡す。
   - **risk-agent**：PR 番号と head SHA **だけ**を渡す（Issue・PR の説明は渡さない）。diff は `git fetch origin && git diff origin/main...<headSha>` で読むよう伝える。
4. それぞれの出力の JSON を、書き換えずにファイル（scratchpad の `reviewer.json`・`risk.json`）に保存する。
5. `node harness/scripts/agent.ts compose-verdict <PR番号> <reviewer.json> <risk.json> --judge-input <judge-input のファイル> --model <モデル名>` で判定コメントを作る（出力はファイルのパス）。現在の head が判定した head と違えば止まるので、手順1からやり直す。
6. `node harness/scripts/agent.ts post-verdict <PR番号> <判定コメントのファイル>` で投稿する。
7. App が受け付けたかを `gh pr view <PR番号> --json isDraft,statusCheckRollup` で確かめる。合格なら `agent/review`・`agent/risk` が成功し、`isDraft` が false になる。数分待っても変わらなければ、PR のコメント（App の `verdict-rejected` など）とゲートの実行（`gh run list --workflow gate.yml`）の結果を見る。確かめてから人に報告する。

### 修正後の再レビュー

前回の判定がある PR では、judge-input の「前回の判定」に head とブロッキング指摘が入り、reviewer はそれを受けて、前回の head からの差分（`git diff <前回の head>...<headSha>`）と前回の指摘が直ったかだけをブロッキングの対象にする（[.claude/agents/reviewer.md](../../agents/reviewer.md) の再レビュー）。前回の head から変わっていない行への新しい指摘は `nonBlocking` にする。型検査・テストの失敗はどの行でもブロッキング。

judge-input の「再レビューの範囲（補足）」には、前回の head の後に main の取り込みがあったかが入る。取り込みがあれば、前回の head からの差分には main から来た変更も入る。PR 自身の変更は、それぞれの head で `git diff origin/main...<head>` を取って比べると分かる（差分の取り方は reviewer.md のまま）。最新の判定コメントのブロックが壊れていれば、それを飛ばした前の正しい判定が「前回の判定」に入り、そのことが注記される。

## 終わりの状態

- 判定した head に対する判定コメントが PR にあり、App が受け付けている。
- 合格なら PR は Ready（`agent/review`・`agent/risk` が成功）。Merge は App（自動 Merge）か人が行う。
- ブロッキング指摘があれば、App の変更要求レビュー（`kind=fix-request`）が付く。次は fix。

## 人に返す条件

- 数分待っても App が受け付けない、`verdict-rejected` が出た理由が head のずれ以外
- `compose-verdict` や `post-verdict` が書式の誤りや権限で失敗した（拒否された操作は別の方法で試さない）
- サブエージェントが入力の不足を報告した
- やってはいけないこと：サブエージェントの答えの書き換え、Merge、auto-merge の設定、Draft の解除（`gh pr ready`）、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped` と `*:exempt` のラベルの付け外し
