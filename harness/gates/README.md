# harness/gates/

専用 GitHub App として動く「ゲート」。GitHub Actions（`.github/workflows/gate.yml`）が `node harness/gates/run.ts` で起動し、Issue・PR・コメントの出来事ごとに、計画ゲート、判定の受け付け、必須チェック（`agent/*`・merge-route）、ラベル付け、ダッシュボードの更新を行う。PR のコードは実行せず、中身は API で読むだけ。ここはガードレール（変えると人が Merge する場所）。

| 名前 | 内容 |
| --- | --- |
| `apply.ts` | 受け付けた判定を PR に反映する（Ready 化・auto-merge・merge-route・`agent/risk`・`agent/review` を安全な順に書く）。Human Merge の依頼コメントもここで作る |
| `context.ts` | ゲートの実行の土台（イベントの読み込み、App のコメント、Check Run の書き込み、Draft・Ready・auto-merge の操作） |
| `epic-split.ts` | Epic：計画の `split` から子 Issue を作り、Sub-issues と依存を登録する |
| `label-apply.ts` | 足りないラベルを付ける（タイトルから `type:*`、`epic`、計画から `area:*`、Jev の答えから `priority:*` など） |
| `on-comment.ts` | コメントが投稿されたとき：計画ゲートと判定の受け付け |
| `on-issue.ts` | Issue の出来事（作成・ラベル・Close）：本文の書式の確認、`agent:plan-ok` の見張り、依存の解消、親 Issue の Close |
| `on-main-push.ts` | main に push されたとき：自動 Merge された PR の revert を見つけたら停止スイッチを入れ、Agent PR を main に追従させる |
| `on-pr.ts` | PR の出来事（push・編集・ラベル）：auto-merge の解除、判定の引き継ぎ、範囲照合、テストの改ざん検査、例外ラベルの扱い |
| `plan-link.ts` | 必須チェック `agent/plan-link`：PR が計画のある Issue を `Closes` しているか |
| `publish-queue.ts` | 次にやること（queue）を計算して、ダッシュボード Issue に公開する |
| `run.ts` | 入口。イベントの種類ごとに上のどれを呼ぶかを決め、最後に queue を公開し直す |
| `stale.ts` | 定期実行：停滞・衝突・人の対応待ち・ラベルの不足をダッシュボードに一覧にする |
