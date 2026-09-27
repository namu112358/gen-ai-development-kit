# 用語集

ハーネスで使う用語を、Issue が流れる順に並べる。

## 着手

### Routine

毎時起動される Claude のクラウド実行。App がダッシュボードに公開する queue に従い、Issue や PR を1段階ずつ進める。GitHub の操作は MCP ツールで行う。詳細：[setup.md](setup.md#6-routine)

### queue

App が次に Routine がやることを計算してダッシュボード Issue の本文に公開し、Routine がそれに従って処理する仕組み。詳細：[formats.md](formats.md#app-の記録agent-app)

### `agent:ready`

人が Issue に付けるラベル。「着手してよい」の意味で、Routine が次の実行で拾う。付けた時点で App が Issue 本文を Issue Form の書式として読めるか確かめる。詳細：[operations.md](operations.md#issue-の書き方)

### claim（着手宣言）

Routine か人のセッションが作業の前に付ける `agent:working` ラベルと、着手者を記録したコメント（```` ```agent-claim ````）。人の着手は Routine が奪わない。詳細：[formats.md](formats.md#着手宣言agent-claim)

## 計画

### 計画コメント

Routine が Issue に投稿する実装方針。末尾の ```` ```agent-plan ```` に、想定 Risk・人の判断が必要か・未解決の質問・触るファイル一覧を JSON で書く。詳細：[formats.md](formats.md#計画agent-plan)

### 触るファイル一覧

計画コメントの `files`。実装で変更するファイルをすべて列挙する必須項目で、範囲照合の基準になる。詳細：[formats.md](formats.md#計画agent-plan)

### 計画ゲート

計画コメントの構造化出力を App が機械的に検査する段階。人の判断が必要、AC 変更の提案、未解決の質問、high 以上、ファイル一覧の欠落のどれかに当たれば `agent:plan-review` で止まり、当たらなければ `agent:plan-ok` が付く。詳細：[plan.md](plan.md#開発フロー)

### `agent:plan-ok` / `agent:plan-review`

計画ゲートの結果。`agent:plan-ok` は App だけが付けられ、Routine は App が付けたことを確かめてから実装する。`agent:plan-review` の Issue は人が手元のセッションで実装する。詳細：[operations.md](operations.md#ラベル)

## 実装

### Agent PR

同じリポジトリの `claude/` ブランチからの PR。自動 Merge の経路に乗れるのは Agent PR だけで、fork やそれ以外のブランチの PR は判定の対象外になる。詳細：[security.md](security.md)

### Draft

Agent が作業中であることを表す PR の状態。判定が確定した時点で App が Ready にする。詳細：[plan.md](plan.md#運用)

## 判定

### 判定

Reviewer と Risk Agent の結果をまとめて、head SHA 付きで PR に投稿するコメント（```` ```agent-verdict ````）。実装とは別の Routine の実行で行う。詳細：[formats.md](formats.md#判定agent-verdict)

### Reviewer

PR が AC を満たし、範囲を守り、既存の挙動を壊していないかを確かめるサブエージェント。ブロッキング指摘があれば Merge させない。詳細：[plan.md](plan.md#risk-ポリシーと自動-merge-条件)

### Risk Agent

diff とリポジトリだけを見て、8問に答えるサブエージェント。Issue 本文や PR の説明といった自然言語の主張は読まない。詳細：[risk-policy.md](risk-policy.md)

### ブロッキング指摘

直さない限り Merge させない Reviewer の指摘。AC 未達、範囲外の変更、型検査・テストの失敗、データ破壊、秘密の漏えい、AC 外の退行の6種類。詳細：[formats.md](formats.md#判定agent-verdict)

### 受け付け

App が判定コメントを検証し、Check Run（`agent/review`・`agent/risk`）に変える段階。判定時の差分と現在の差分が同じときだけ受け付ける。詳細：[security.md](security.md)

### patch-id

「PR が main に加えた変更」を表す値（`git patch-id --verbatim`）。main に追従しても差分が同じなら値が変わらないので、判定をやり直さずに済む。空白の違いも別の値になる。詳細：[security.md](security.md)

### 範囲照合

PR の変更ファイルが計画の触るファイル一覧に収まるかを App が確かめること。はみ出していれば自動 Merge の対象外になる（人が Merge するのは可）。詳細：[security.md](security.md)

## Merge

### merge-route

App が書く必須チェック。auto-merge が付いていない PR は通し（Human Merge）、付いている PR は、現在の差分に対する判定が自動 Merge の条件を満たすときだけ通す。詳細：[risk-policy.md](risk-policy.md#自動-merge-の条件)

### Human Merge / 自動 Merge

Human Merge は人が PR を Merge する経路で、Risk が medium 以上の PR はこちらになる。自動 Merge は、low で条件をすべて満たす PR に App が auto-merge を付け、必須チェックが揃うと GitHub が Merge する経路。詳細：[risk-policy.md](risk-policy.md#自動-merge-の条件)

### 修正ループ

Reviewer のブロッキング指摘を受けて Routine が直すこと。通常2回まで、3回目は critical な指摘があるときだけで、超えると `agent:blocked` になる。詳細：[plan.md](plan.md#運用)

## 停止

### 停止スイッチ

ダッシュボード Issue に付ける `agent:auto-merge-stopped` ラベル。付いている間は自動 Merge がすべて止まり、自動 Merge された PR が revert されると App が自動で付ける。詳細：[operations.md](operations.md#止める仕組み)

### `agent:hold`

人が Issue や PR に付ける個別停止のラベル。PR なら merge-route が failure になり、Issue なら Routine が処理しない。詳細：[operations.md](operations.md#止める仕組み)

### ダッシュボード

App が作る「Agent ダッシュボード」Issue。人の対応待ち、コンフリクト、停滞している Issue・PR を3時間ごとに一覧にする。詳細：[operations.md](operations.md#止める仕組み)

## 外部

### Jev

TypeSafe AI の判定モデル。いまは Claude の判定と並べて記録するだけ（シャドー判定）で、結果を見て外れがないと確かめてから Risk 判定を任せる。詳細：[plan.md](plan.md#jev-への段階移行)
