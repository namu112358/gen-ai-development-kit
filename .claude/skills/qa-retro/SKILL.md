---
name: qa-retro
description: 人が付き添うセッションで、Merge 済みの PR をまとめて振り返り、判定（risk・reviewer）と実際の結果（後追いの修正・revert）のずれ、テストの穴、不安定なテストを報告し、直す Issue の下書きを人に示す。「判定を振り返って」「品質を振り返って」「qa-retro の下書きを選ぶ」と頼まれたときに使う。付き添いのセッションの /loop から `--loop` で続けて回せる。
---

# qa-retro（判定と品質の振り返り）

Merge 済みの PR を、人が呼んだときか、付き添いのセッションの `/loop` から回すときに、まとめて振り返る手順。決まる集計（数える・組にする）は `harness/lib/qa-retro.ts` が行い、判断の要るもの（後追いの修正が元の PR の見落としか、どの問いで拾えたはずか）はこの手順でセッションが行う。Issue の段階ではないので着手宣言は要らない。

## 入力

- 対象の期間。既定は直近 14 日に Merge された PR。人が期間を言ったら `--days <n>`、`--since <YYYY-MM-DD>`、`--until <YYYY-MM-DD>`（その日を含む）で渡す。`--days` と `--since` は同時に渡さない。
- `--loop`：`/loop` から回す回（例 `/loop 1d /qa-retro --loop`）。期間は前回の回の終わりから決まるので、`--days`・`--since`・`--until` と一緒に使わない。手順は「## /loop で回すとき」。`--loop` が無いときは下の手順のまま。

## 集計

1. `node harness/scripts/agent.ts qa-retro-data [--days <n>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>]` を実行する。出力は JSON のファイルのパス（読むだけで、GitHub には書かない）。
2. そのファイルを読む。数はここから取り、セッションが数え直さない。
   - `prs`：PR ごとの risk（最後の受け付けの記録の `riskLevel`）・`autoEligible`・Merge の経路（`auto`・`delegated`・`human`）・判定の回数（`verdicts`・`rejectedVerdicts`・`fixRequests`）・メトリクス（所要時間・トークン・推定料金の合計、読めなかった値の数 `unreadable`）・`fixedBy`・`reverted`
   - `followups`：後追いの修正（Merge 後 7 日以内に同じファイルを変えた fix の PR）か revert がある PR と、元の risk・Merge の経路・重なったファイルの組
   - `byRisk`：risk ごとの Merge 数・後追いの修正・revert の数と割合（`auto` は自動 Merge の PR だけ）
   - `flakyCi`：同じ head で失敗の後に成功した CI の実行と、失敗したテスト名（ログが読めなければ `testNames: null`）
   - `notes`：読めなかったログ・メトリクスの数と、ページの上限で打ち切ったもの。打ち切りがあれば報告にそう書く

## 判断

1. `followups` の組ごとに、元の PR と fix の PR の diff と判定コメントを読む（`gh pr view <番号> --comments`・`gh pr diff <番号>`）。
2. (a) 後追いの修正が元の PR の見落としか（元の PR の変更が原因か、別の要因〔仕様の変更・外部の変化・元の PR の前からあった不具合〕か）を決める。
3. (b) 見落としなら、どこで拾えたはずかを決める：Risk ポリシーの8問（[docs/risk-policy.md](../../../docs/risk-policy.md)）のどの問い、reviewer の観点、test-designer のテストのどこ（足りなかったテストの形）。
4. `flakyCi` はテスト名ごとにまとめ、同じテストが繰り返し落ちているかを見る。`testNames` が null のものは「テスト名は読めない」として数だけ書く。
5. 決めきれないものは「不明」とし、推測で見落としにしない。

## 出力

1. 報告を人に示す（文章で。PR・Issue には投稿しない）。
   - risk ごとの後追い修正と revert の割合（`byRisk`。自動 Merge の PR だけの数も並べる）
   - 見落としの例（元の PR・fix の PR・拾えたはずの問いか観点かテスト）と、「不明」にしたもの
   - 不安定なテストの一覧（テスト名・回数・実行へのリンク）
   - `notes` の読めなかったもの・打ち切り
2. 直す Issue の下書きを作る（risk ポリシーの問いの見直し、テストの追加、不安定なテストの修正）。見出しは Issue Form（[.github/ISSUE_TEMPLATE/agent-task.yml](../../../.github/ISSUE_TEMPLATE/agent-task.yml)）に、タイトルは `harness/lib/title.ts` の書式（Conventional Commits）に合わせる。
3. どの下書きを作るかを AskUserQuestion（複数選択、1回4問まで）で聞く。人が選んだものだけを `gh issue create` で作る。ラベルは付けない。
4. 作った Issue を plan に進めるかを AskUserQuestion で聞く（おすすめは「作るだけ」）。進めると選ばれたら ship の skill（[.claude/skills/ship/SKILL.md](../ship/SKILL.md)）の手順に従う。

## /loop で回すとき

skill によらない共通の規則（`/loop` の始め方・止め方、回の中で人に聞かないこと）は [docs/operations.md の「見直しを /loop で回す」](../../../docs/operations.md#見直しを-loop-で回す) を参照する。ここには qa-retro に固有のことだけを書く。

- 間隔の目安：1日〜1週間おき（例 `/loop 1d /qa-retro --loop`）。期間の終わりは今の7日前なので、間隔を短くしても1回分の期間が細かくなるだけで、抜けも重なりも出ない。
- 1回分の期間：前回の回の終わりから、今の7日前まで（後追いの修正は Merge 後 7 日以内の fix の PR で数えるので、窓が閉じた PR だけを見る）。初回（状態のファイルが無い）は、終わりの14日前から。前回の回の終わりは手元の状態のファイル（既定は `git rev-parse --path-format=absolute --git-common-dir` の下の `agent-harness/qa-retro-loop.json`。作業ツリーにも GitHub にも書かない）に持つ。
- 1回分の処理（回の中で人の答えを待たない）：
  1. `node harness/scripts/qa-retro-loop.ts data` を実行する。「まだ見る期間がありません」と出たら、その回はそこで終える（状態は変わらない）。出力が JSON のファイルのパスなら、「## 集計」の手順2どおり読む。
  2. 「## 判断」の手順を行う。
  3. 報告を「## 出力」の手順1どおり文章で出す。報告の先頭に期間（始まり・終わり）を書く。直す Issue の下書きは3件まで作り、文章で示す。ループの回では AskUserQuestion を呼ばない。`gh issue create` もしない（Issue にするかは、下の「人が選ぶ場面」で人が決める）。
  4. 下書きを JSON の配列（`title`・`body`、同じものがある開いた Issue があれば `duplicateOf`。`labels` は持たせない）で scratchpad に書き、`node harness/scripts/qa-retro-loop.ts advance <集計の JSON> [--drafts <下書きの JSON>]` で期間を進める。進めるのは報告を出した後だけ。
- `advance` が一致の確かめ（集計の JSON の期間の始まりが、前回の回の終わりと違う）で止まったら、人に聞かずにその回を止め、理由を出す（ほかのセッションが同じ状態で回している・古い JSON を渡した恐れ）。状態は変わらない。
- 止め方：`/loop` を止める（止めるよう頼む・セッションを閉じる）。`advance` の前に止めた回は期間が進まないので、次の回が同じ始まりから見直す（抜けない）。
- 人が選ぶ場面（ループの回の外）：人が「qa-retro の下書きを選ぶ」と頼んだら、`node harness/scripts/qa-retro-loop.ts pending` で未採用の下書きを読み、どれを作るかを AskUserQuestion（複数選択、1回4問まで）で聞く。人が選んだものだけを `gh issue create` で作り（ラベルは付けない）、作るたびに `node harness/scripts/qa-retro-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号>` で書き戻す（期間は変わらない）。作った Issue を plan に進めるかは「## 出力」の手順4どおり聞く。
- 動作を確かめるときは、`--state <一時のパス>` を `data`・`advance` に渡して、手元の状態のファイルと分ける。

## やってはいけないこと

- `agent:ready` を付けない（ほかのラベルも付けない。`priority:*`・`area:*` は Jev に任せる）
- 人が選んだものだけを作る。人が選ばなかった下書きは作らない
- 報告を判定の材料にしない。reviewer・risk-agent・Jev には渡さない。PR・Issue に報告を投稿しない
- risk ポリシーのしきい値・問いをこの skill の中で変えない（見直しは人が別の Issue で決める）
- 無人の定期 Routine（schedule・Actions・クラウドの Routine）として動かさない。付き添いのセッションの `/loop` では「## /loop で回すとき」の節どおりに回してよい
- 「人が選んだものだけを作る」「報告を判定の材料にしない」「PR・Issue に報告を投稿しない」は `/loop` の回でも同じ
- Issue 本文を書き換えない
