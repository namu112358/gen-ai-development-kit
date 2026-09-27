# harness/scripts/

手元（人や Claude のセッション）で動かすコマンド。`node harness/scripts/<名前>.ts` で実行する。使い方は各ファイルの先頭のコメントにある。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `agent.ts` | Routine と人のセッションが使う CLI。 | ○ |
| `jev-language.ts` | 日本語の材料と英訳した材料を同じ問いで Jev（TypeSafe AI）に投げ比べる、手で実行する実験用スクリプト。 |  |
| `mutate.ts` | テストが効いているかを確かめる（mutation）。 |  |
| `readme.ts` | README の表（名前・内容・ガードレール）を、各ディレクトリの直下の名前と先頭のコメントから作る。 |  |
| `report.ts` | 判定の集計（Jev の切り替え判断用）。 | ○ |
| `setup.ts` | リポジトリ設定を冪等に適用する（人が手元で、リポジトリ管理者の gh 認証で実行する）。 | ○ |
<!-- readme:generated end -->
