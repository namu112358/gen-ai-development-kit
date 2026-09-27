# harness/gates/

専用 GitHub App として動く「ゲート」。GitHub Actions（`.github/workflows/gate.yml`）が `node harness/gates/run.ts` で起動し、Issue・PR・コメントの出来事ごとに、計画ゲート、判定の受け付け、必須チェック（`agent/*`・merge-route）、ラベル付け、ダッシュボードの更新を行う。PR のコードは実行せず、中身は API で読むだけ。ここはガードレール（変えると人が Merge する場所）。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `apply.ts` | 受け付けた判定を PR に反映する。 | ○ |
| `context.ts` | ゲートの実行コンテキスト。 | ○ |
| `epic-split.ts` | Epic の子 Issue を作り、Sub-issues と依存を登録する。 | ○ |
| `label-apply.ts` | 足りないラベルを付ける（docs/operations.md の「必須ラベルの規則」）。 | ○ |
| `on-comment.ts` | issue_comment（created）：計画ゲートと判定の受け付け | ○ |
| `on-issue.ts` | Issue の出来事ごとの処理。 | ○ |
| `on-main-push.ts` | main に push されたときの処理。 | ○ |
| `on-pr.ts` | PR の出来事（作成・push・編集・ラベル）ごとの処理。 | ○ |
| `plan-link.ts` | 必須チェック agent/plan-link：PR が計画のある Issue を Closes しているか。 | ○ |
| `publish-queue.ts` | 次にやること（queue）を App が計算し、ダッシュボード Issue の本文に公開する。 | ○ |
| `run.ts` | ゲートの入口で、イベントの種類ごとに処理を選び、最後に queue を公開し直す。 | ○ |
| `stale.ts` | 定期実行：停滞検知。 | ○ |
| `tests-check.ts` | 必須チェック agent/tests（テストの改ざん検査）の結果を決める。 | ○ |
<!-- readme:generated end -->
