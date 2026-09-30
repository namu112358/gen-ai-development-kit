# harness/scripts/

手元（人や Claude のセッション）で動かすコマンド。`node harness/scripts/<名前>.ts` で実行する。使い方は各ファイルの先頭のコメントにある。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `agent.ts` | Routine と人のセッションが使う CLI。 | ○ |
| `agent/` | `harness/scripts/agent.ts` のサブコマンドの実装（`commands/`）と、コマンドが共有する補助（`cli.ts`）。 | ○ |
| `dashboard.ts` | エージェントの状態をグラフで見る、手元の読み取り専用のダッシュボード（GitHub には書かない）。 |  |
| `dashboard/` | エージェントの状態をグラフで見る手元のダッシュボード（`harness/scripts/dashboard.ts`）の部品。 |  |
| `jev-language.ts` | 日本語の材料と英訳した材料を同じ問いで Jev（TypeSafe AI）に投げ比べる、手で実行する実験用スクリプト。 |  |
| `mutate.ts` | テストが効いているかを確かめる（mutation）。 |  |
| `observe.ts` | 保守の観測（docs の照合・ホットスポット・テストの健康）を、人が指示したときに1回分だけ出す（LLM を呼ばない決まる集計）。 |  |
| `readme.ts` | README の表（名前・内容・ガードレール）を、各ディレクトリの直下の名前と先頭のコメントから作る。 |  |
| `report.ts` | 判定の集計（Jev の切り替え判断用）。 | ○ |
| `review-panel.ts` | 合体版のレビュー（.claude/skills/review-panel/SKILL.md）の CLI。 | ○ |
| `setup.ts` | リポジトリ設定を冪等に適用する（人が手元で、リポジトリ管理者の gh 認証で実行する）。 | ○ |
| `test-prune.ts` | 減らせるテストの材料を、人が指示したときに1回分だけ集める（LLM を呼ばない決まる集計）。 |  |
<!-- readme:generated end -->
