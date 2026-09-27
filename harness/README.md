# harness/

ハーネスの本体。GitHub の上で Issue と PR の流れを見張る「ゲート」と、その判断に使うロジック、人やセッションが使うコマンド、テストが入っている。TypeScript をビルドせずに Node 24 で動かす。

| 名前 | 内容 |
| --- | --- |
| `gates/` | 専用 GitHub App として GitHub Actions で動くゲート（計画ゲート・判定の受け付け・必須チェックなど） |
| `lib/` | ゲートとコマンドが共通で使うロジック（書式の読み取り、範囲照合、merge-route など） |
| `scripts/` | 手元で動かすコマンド（書式の検査とコメント本文の生成、導入先の設定、集計） |
| `templates/` | 導入先にコピーして使う設定の見本 |
| `test/` | `node:test` のテスト（`npm run check` で動く） |

全体の流れは root の [overview.html](../overview.html) と [docs/operations.md](../docs/operations.md) を見る。
