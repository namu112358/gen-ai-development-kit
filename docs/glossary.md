# 用語集

ハーネスで使う用語を、Issue が流れる順に並べる。

## 着手

### 付き添いのセッション

Claude が人と一緒に作業するセッション。着手は `node harness/scripts/agent.ts claim <番号> --manual --stage <段階>`、ブランチは `claude/`、出す PR は Agent PR として判定・修正・自動 Merge の経路に乗る（critical は人が Merge する）。詳細：[operations.md](operations.md#付き添いのセッションで進める)

### ship

付き添いのセッションで、Issue 番号から plan → implement → judge → fix（必要なら sync）の skill をつなぎ、人の Merge 待ちか人の判断待ちまで進める skill。最後に人がすることを一覧にする。詳細：[operations.md](operations.md#付き添いのセッションで進める)

### Routine

毎時起動される Claude のクラウド実行（将来の構想）。App がダッシュボードに公開する queue に従い、Issue や PR を1段階ずつ進める。GitHub の操作は MCP ツールで行う。詳細：[setup.md](setup.md#6-routine)

### queue

App が次に Routine がやることを計算してダッシュボード Issue の本文に公開し、Routine がそれに従って処理する仕組み。詳細：[formats.md](formats.md#app-の記録agent-app)

### `agent:ready`

人が Issue に付けるラベル。「着手してよい」の意味で、Routine が次の実行で拾う。付けた時点で App が Issue 本文を Issue Form の書式として読めるか確かめる。詳細：[operations.md](operations.md#issue-の書き方)

### claim（着手宣言）

Routine か付き添いのセッションが作業の前に残す、着手者を記録したコメント（```` ```agent-claim ````）。付き添いのセッションの着手（`manual`）は Routine が奪わない。付き添いのセッションの宣言には段階（`stage`）とセッションの ID（`session`）が入り、ほかのセッションからどの段階かが見える。詳細：[formats.md](formats.md#着手宣言agent-claim)

## 計画

### 計画コメント

Routine が Issue に投稿する実装方針。末尾の ```` ```agent-plan ```` に、想定 Risk・人の判断が必要か・未解決の質問・触るファイル一覧を JSON で書く。詳細：[formats.md](formats.md#計画agent-plan)

### 触るファイル一覧

計画コメントの `files`。実装で変更するファイルをすべて列挙する必須項目で、範囲照合の基準になる。詳細：[formats.md](formats.md#計画agent-plan)

### 計画ゲート

計画コメントの構造化出力を App が機械的に検査する段階。人の判断が必要、AC 変更の提案、未解決の質問、high 以上、ファイル一覧の欠落のどれかに当たれば `agent:plan-review` で止まり、当たらなければ `agent:plan-ok` が付く。詳細：[plan.md](plan.md#開発フロー)

### `agent:plan-ok` / `agent:plan-review`

計画ゲートの結果。`agent:plan-ok` は App だけが付けられ、Routine は App が付けたことを確かめてから実装する。`agent:plan-review` の Issue は、付き添いのセッションで、人が進めると決めてから実装する。App のゲートの停止による `agent:plan-review` は、止めた理由が当たらない計画を出し直せば App が外す。Planner の申告（`needsHuman`・`openQuestions`）は、付き添いのセッションが記録した人の決定（```` ```agent-decision ````）を Jev が確かめ、`jev.decisionRelease` が `enforce` のとき App が外す。AC の変更提案と人が付けた印は、人が外すまで残る。詳細：[operations.md](operations.md#ラベル)

## 実装

### Agent PR

同じリポジトリの `claude/` ブランチからの PR。付き添いのセッションの PR も Agent PR。自動 Merge の経路に乗れるのは Agent PR だけ。詳細：[security.md](security.md)

### 人の PR

`claude/` 以外のブランチから人が自分で書いた PR。計画のある Issue に紐付いていれば判定されるが、修正は人がし、自動 Merge しない。fork からの PR は判定しない。詳細：[security.md](security.md) / [operations.md](operations.md#人が関わる場面)

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

### `agent/plan-link`

App が書く必須チェック。計画のある Issue を `Closes` しない PR を止める。人の PR も対象になる。詳細：[operations.md](operations.md#人が関わる場面)

### `agent/tests`

App が書く必須チェック。PR の差分からテストの削除、skip・only・todo の追加、アサーションの削除・書き換えを検出して止める。例外は人が付ける `test:exempt`。人が Merge する PR（Human Merge）では止めずに neutral にし、見つけた行を Human Merge の依頼に載せて人の確認に回す。詳細：[operations.md](operations.md#テストの改ざん検査)

### Human Merge / 自動 Merge

Human Merge は人が PR を Merge する経路で、Risk が medium 以上の PR はこちらになる。自動 Merge は、low で条件をすべて満たす PR に App が auto-merge を付け、必須チェックが揃うと GitHub が Merge する経路。詳細：[risk-policy.md](risk-policy.md#自動-merge-の条件)

### 修正ループ

Reviewer のブロッキング指摘を受けて Routine が直すこと。通常2回まで、3回目は critical な指摘があるときだけで、超えると `agent:blocked` になる。詳細：[plan.md](plan.md#運用)

## 停止

### 停止スイッチ

ダッシュボード Issue に付ける `agent:auto-merge-stopped` ラベル。付いている間は自動 Merge がすべて止まり、自動 Merge された PR が revert されると App が自動で付ける。詳細：[operations.md](operations.md#止める仕組み)

### 委任承認

人が計画ゲートの承認と Merge の判断を App に委ねること。期限は無く、ダッシュボード Issue に人だけが付けるラベルが付いている間ずっと有効で、停止スイッチが優先する。`agent:delegate-plan` は委任承認（計画）で、ガードレールや想定 Risk だけで計画ゲートに止まる計画に App が `agent:plan-ok` を付ける。`agent:delegate-merge` は委任承認（計画＋Merge）で、それに加えてガードレールや Risk を理由に Human Merge になる Agent PR も、ほかの条件を満たせば自動 Merge する。どちらも `delegateMergeExclude` に当たるものは委ねない。旧称は委任 Merge（今の委任承認（計画＋Merge））。詳細：[risk-policy.md](risk-policy.md#委任承認)

### bypass モード

ブロッキング指摘の無い Agent PR の Merge を、人が期限なしで App に任せること。ダッシュボード Issue に `agent:bypass-merge` を人だけが付け、付けている間は、Risk・ガードレール・`humanMergePaths`・`delegateMergeExclude`・Jev を理由に Human Merge になる Agent PR も、ブロッキング指摘が無く範囲照合と `agent/tests` を通れば自動 Merge する（ハーネス自身の変更も含む）。停止スイッチが優先する。ラベルを外すと、bypass で付けた auto-merge を外して Human Merge に戻す。詳細：[risk-policy.md](risk-policy.md#bypass-モード)

### `agent:hold`

人が Issue や PR に付ける個別停止のラベル。PR なら merge-route が failure になり、Issue なら Routine が処理しない。詳細：[operations.md](operations.md#止める仕組み)

### ダッシュボード

App が作る「Agent ダッシュボード」Issue。人の対応待ち、コンフリクト、停滞している Issue・PR、必須ラベルが足りない（または規則に反する）Issue・PR を3時間ごとに一覧にする。詳細：[operations.md](operations.md#止める仕組み)

## 外部

### Jev

TypeSafe AI の判定モデル。いまは Claude の判定と並べて記録するだけ（シャドー判定）で、結果を見て外れがないと確かめてから Risk 判定を任せる。詳細：[plan.md](plan.md#jev-への段階移行)
