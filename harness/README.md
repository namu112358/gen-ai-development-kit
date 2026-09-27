# harness/

ハーネスの本体。GitHub の上で Issue と PR の流れを見張る「ゲート」と、その判断に使うロジック、人やセッションが使うコマンド、テストが入っている。TypeScript をビルドせずに Node 24 で動かす。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `gates/` | 専用 GitHub App として動く「ゲート」。 | ○ |
| `lib/` | ゲート（`harness/gates/`）とコマンド（`harness/scripts/`）が共通で使うロジック。 | 一部 |
| `scripts/` | 手元（人や Claude のセッション）で動かすコマンド。 | 一部 |
| `templates/` | 導入先にコピーして使う設定の見本。 | ○ |
| `test/` | `node:test` のテスト。 |  |
<!-- readme:generated end -->

全体の流れは root の [overview.html](../overview.html) と [docs/operations.md](../docs/operations.md) を見る。
