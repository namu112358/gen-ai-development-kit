# harness/scripts/

手元（人や Claude のセッション）で動かすコマンド。`node harness/scripts/<名前>.ts` で実行する。使い方は各ファイルの先頭のコメントにある。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `agent.ts` | Routine と人のセッションが使う CLI。 | ○ |
| `mutate.ts` | テストが効いているかを確かめる（mutation）。 |  |
| `readme.ts` | README の表（名前・内容・ガードレール）を、各ディレクトリの直下の名前と先頭のコメントから作る。 |  |
| `report.ts` | 判定の集計（Jev の切り替え判断用）。 | ○ |
| `review-panel.ts` | 合体版のレビュー（.claude/skills/review-panel/SKILL.md）の CLI。 | ○ |
| `setup.ts` | リポジトリ設定を冪等に適用する（人が手元で、リポジトリ管理者の gh 認証で実行する）。 | ○ |
<!-- readme:generated end -->
