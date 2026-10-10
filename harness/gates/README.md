# harness/gates/

専用 GitHub App として動く「ゲート」。GitHub Actions（`.github/workflows/gate.yml`）が `node harness/gates/run.ts` で起動し、Issue・PR・コメントの出来事ごとに、計画ゲート、判定の受け付け、必須チェック（`agent/*`・merge-route）、ラベル付け、ダッシュボードの更新を行う。PR のコードは実行せず、中身は API で読むだけ。ここはガードレール（変えると人が Merge する場所）。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `apply.ts` | 受け付けた判定を PR に反映する。 | ○ |
| `auto-mode-merge.ts` | auto mode（Epic #339）の始まりと終わりの動作（ダッシュボードの auto mode のラベルの付け外しと停止スイッチ）。 | ○ |
| `auto-mode-tests.ts` | auto mode の経路に乗る PR で、agent/tests が見つけたテストを弱める変更が妥当かを Jev に問い、App の記録（kind=auto-mode-tests）に残す（Issue #349）。 | ○ |
| `auto-mode.ts` | auto mode（Epic #339）の今の状態と、計画・PR を auto mode で通してよいかの判断（Jev の危険の問いと記録の使い回し）。 | ○ |
| `bypass-merge.ts` | bypass モードの始まりと終わりの動作（ダッシュボードのラベルの付け外しと停止スイッチ）。 | ○ |
| `bypass.ts` | bypass モードの今の状態と、PR を bypass で自動経路に乗せるかの判断（読むだけ・判断だけ）。 | ○ |
| `context.ts` | ゲートの実行コンテキスト。 | ○ |
| `delegate-merge.ts` | 委任承認の始まりと終わりの動作（ダッシュボードの agent:delegate-plan・agent:delegate-merge の付け外し）。 | ○ |
| `delegation.ts` | 委任承認の今の状態と、PR を委任（計画＋Merge）で自動経路に乗せるかの判断（読むだけ・判断だけ）。 | ○ |
| `epic-close.ts` | 子課題が全部閉じた Epic を App が閉じる。 | ○ |
| `epic-split.ts` | Epic の子 Issue を作り、Sub-issues と依存を登録する。 | ○ |
| `epic-triage.ts` | 定期実行：開いた Epic に入っていない Issue の Epic を Jev に問い、App の記録 epic-triage を残す（Epic #436・Issue #565）。 | ○ |
| `label-apply.ts` | 足りないラベルを付ける（docs/operations.md の「必須ラベルの規則」）。 | ○ |
| `main-merge-carry.ts` | main の取り込み（App の update-branch）の push で、PR 自身の変更（追加・削除の行）が前と同じなら、合格の判定を新しい patch-id に引き継ぐ（Issue #397）。 | ○ |
| `on-comment.ts` | issue_comment（created）：計画ゲートと判定の受け付け | ○ |
| `on-issue.ts` | Issue の出来事ごとの処理。 | ○ |
| `on-main-push.ts` | main に push されたときの処理。 | ○ |
| `on-pr.ts` | PR の出来事（作成・push・編集・ラベル）ごとの処理。 | ○ |
| `periodic-catch-up.ts` | イベントで動いた gate が、前回の定期の仕事（label-apply → stale の onSchedule → queue の公開）からしきい値以上空いていれば、定期の仕事を1回補う（Issue #418）。 | ○ |
| `plan-decision.ts` | 決定の記録（````agent-decision````）の受け付け。 | ○ |
| `plan-link.ts` | 必須チェック agent/plan-link：PR が計画のある Issue に紐付いているか（本文の `Closes #N`、Stacked PR の層は `Refs #N` も）。 | ○ |
| `publish-queue.ts` | 次にやること（queue）を App が計算し、ダッシュボード Issue の本文に公開する。 | ○ |
| `push-claim.ts` | 着手宣言の無いセッションが Agent PR に push したことを、PR に App のコメント（kind=unclaimed-push）で知らせる（止めない）。 | ○ |
| `rerun-failed.ts` | 定期実行：計画・判定・決定の記録のコメントで起動して失敗した gate の実行を見つけ、1回だけやり直す（#390）。 | ○ |
| `rerun.ts` | ジョブ rerun-failed の入口。 | ○ |
| `run.ts` | ゲートの入口で、イベントの種類ごとに処理を選ぶ。 | ○ |
| `stale.ts` | 定期実行：停滞検知。 | ○ |
| `tests-check.ts` | 必須チェック agent/tests の書き方（on-pr.ts と apply.ts の両方から使う）。 | ○ |
| `tests-jev.ts` | agent/tests の検出（アサーションの書き換え）を Jev に問い、App の記録（kind=test-tamper-jev）に残す（Q95）。 | ○ |
| `tests-move.ts` | テストファイルの削除の移し先を Jev に問い、App の記録（kind=test-move-jev）に残す（Epic #511、Issue #514）。 | ○ |
<!-- readme:generated end -->
