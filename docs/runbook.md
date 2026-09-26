# Runbook（止める・戻す）

## 止める仕組み

| 仕組み | 操作 | 効き方 |
| --- | --- | --- |
| 停止スイッチ（全体） | 「Agent ダッシュボード」Issue に `agent:auto-merge-stopped` を付ける | App が全 PR の auto-merge を外し、merge-route が自動経路をすべて failure にする。Human Merge は通る |
| 停止スイッチ（GitHub 側） | Settings → General → Allow auto-merge を切る | auto-merge が一斉に効かなくなる（App の操作に依存しない最終手段） |
| 個別停止 | Issue / PR に `agent:hold` を付ける | PR：merge-route が failure。Issue：Routine が処理しない。外されると App が記録コメントを残す |
| revert で自動停止 | 自動 Merge された PR を revert する | App が停止スイッチを入れる（ダッシュボードに停止ラベル）。人が確認して外すまで再開しない |
| Routine の停止 | [claude.ai/code/routines](https://claude.ai/code/routines) で Routine を無効化 | Claude が動かなくなる。App のゲートは動き続ける |

## 暴走時の手順

1. **Routine を無効化**する（Claude の書き込みを止める）。
2. ダッシュボードに `agent:auto-merge-stopped` を付ける（または Allow auto-merge を切る）。
3. 開いている Agent PR を確認し、必要なら `agent:hold` を付けるか Close する。
4. 誤って Merge されたものは GitHub の Revert ボタンで revert PR を作り、人が Merge する。
5. [ダッシュボード](../../../issues?q=is%3Aopen+%22Agent+ダッシュボード%22) と Actions の失敗を確認し、原因を Issue に記録する。
6. 原因を直したら、フェーズを戻す：
   - 自動 Merge だけ止める（Phase 3 相当）：停止ラベルを付けたまま Routine を再開
   - 計画〜Draft PR まで（Phase 2 相当）：`.claude/routine.md` の judge / fix を人が手元で行う運用に切り替える
7. 再開するときは停止ラベルを外す。外した事実は App がダッシュボードに記録する。

## 自動 Merge を有効にする（Phase 4）

前提：止める仕組みの動作確認（[phase0.md](phase0.md) の Phase 4 チェック）が済んでいること。

1. ダッシュボードの `agent:auto-merge-stopped` を外す。
2. App が、受け付け済みで条件を満たす Agent PR に auto-merge を付け直す。

## よくある状態と対処

| 状態 | 見え方 | 対処 |
| --- | --- | --- |
| Issue 本文が読めない | `agent:blocked`＋App の `form-error` コメント | 本文を Issue Form の見出しに直して `agent:blocked` を外す |
| 計画ゲートで停止 | `agent:plan-review` | 人が手元でセッションを立てて実装する（`agent.ts claim <番号> --manual`） |
| 修正回数の上限 | PR に `agent:blocked` | 人が指摘を確認して直すか、Close する |
| 判定が古い | App の `verdict-rejected` コメント | 何もしなくてよい（次の実行で判定し直す） |
| コンフリクト | ダッシュボードの「コンフリクトしている Agent PR」 | 人が解消するか、Issue にコメントして Routine に任せる |
| ゲートが失敗 | Actions の失敗、ダッシュボードの停滞 | Actions のログを確認。`workflow_dispatch` でダッシュボードだけ更新できる |
