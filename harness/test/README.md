# harness/test/

`node:test` のテスト。`npm run check`（型検査＋テスト）で全部が動く。ファイルが多いので、種類ごとに説明する（このディレクトリは説明の生成の対象外。名前の実在の検査はかかる）。

| 種類 | 内容 |
| --- | --- |
| `gates-*.test.ts` | ゲート（`harness/gates/`）のテスト。偽の GitHub にイベントを渡し、App が書くコメント・ラベル・チェックを確かめる |
| `*-guardrail.test.ts` | ガードレールの範囲と、それに触れる計画・PR の扱い（止めるか通すか）のテスト |
| `hooks-*.test.ts` | hook（`.claude/hooks/`）：見張りの hook（`guard.ts`）が止めるべき操作を止めるか、SessionStart の hook（`session-env.ts`）がセッションの ID を書き残すか |
| `skills.test.ts`・`ship-skill.test.ts`・`label-delegation.test.ts`・`label-session-decide.test.ts` | skill の手順書（`.claude/skills/`）の書き方と、ラベルを Jev に任せる手順・Jev が下限未満で付けなかったものをセッションが決めて付ける手順の検査 |
| `readme-*.test.ts` | 各ディレクトリの README が、直下の実在する名前・先頭のコメントから生成した表と食い違っていないかの検査（`readme-index.test.ts`・`readme-generate.test.ts`・`readme-stale-names.test.ts`） |
| `review-panel-*.test.ts` | 合体版のレビューの組み立て・記録・担当の定義と、今の判定と比べる集計のテスト |
| `overview-labels.test.ts` | `overview.html` のラベル表示が `harness.config.json` の定義と食い違っていないかの検査 |
| `gitattributes.test.ts` | root の `.gitattributes` が LF で取り出す設定になっているか（`git check-attr`・`git ls-files --eol`）と、docs/setup.md の改行コードをそろえる手順の検査 |
| `claim-owner.test.ts`・`claim-recheck.test.ts` | 着手宣言の持ち主の決め方（最初の宣言が持ち主、`--takeover` で移る）と、`claim` の投稿 → 待つ → 読み直し・取り下げ、`ensureOwnClaim` の確かめ（#171） |
| `fleet-*.test.ts` | fleet の選び方（重なり・PR 同士の衝突・着手宣言の扱い）と、進め方（入れ子の orca／交互の flat）のテスト |
| `usage-*.test.ts` | usage の集計（今のセッションの記録の選び方、入れ子のサブエージェントの記録も含めること）のテスト |
| その他 | `harness/lib/`・`harness/scripts/` の各ロジックのテスト（`<機能名>.test.ts`。例：`plan.test.ts`・`scope.test.ts`・`mutate.test.ts`） |
| `support/` | テストが共有する補助（テストとしては動かない） |

新しいテストは既存のファイルの末尾に足さず、機能・ハンドラーごとのファイルに書く。
