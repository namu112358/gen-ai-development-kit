# harness/test/

`node:test` のテスト。`npm run check`（型検査＋テスト）で全部が動く。ファイルが多いので、種類ごとに説明する（このディレクトリは README の鮮度の検査の対象外）。

| 種類 | 内容 |
| --- | --- |
| `gates-*.test.ts` | ゲート（`harness/gates/`）のテスト。偽の GitHub にイベントを渡し、App が書くコメント・ラベル・チェックを確かめる |
| `*-guardrail.test.ts` | ガードレールの範囲と、それに触れる計画・PR の扱い（止めるか通すか）のテスト |
| `hooks-*.test.ts` | 見張りの hook（`.claude/hooks/guard.ts`）が止めるべき操作を止めるか |
| `skills.test.ts`・`ship-skill.test.ts` | skill の手順書（`.claude/skills/`）の書き方の検査 |
| `readme-index.test.ts` | 各ディレクトリの README に直下の名前がすべて書かれているか、`overview.html` が外部を読み込まないか |
| その他の `<機能名>.test.ts` | `harness/lib/`・`harness/scripts/` の各ロジックのテスト（例：`plan.test.ts`・`scope.test.ts`・`mutate.test.ts`） |
| `support/` | テストが共有する補助（テストとしては動かない） |

新しいテストは既存のファイルの末尾に足さず、機能・ハンドラーごとのファイルに書く。
