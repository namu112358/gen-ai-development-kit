# harness/test/

`node:test` のテスト。`npm run check`（型検査＋テスト）で全部が動く。ファイルが多いので、種類ごとに説明する（このディレクトリは説明の生成の対象外。名前の実在の検査はかかる）。

| 種類 | 内容 |
| --- | --- |
| `gates-*.test.ts` | ゲート（`harness/gates/`）のテスト。偽の GitHub にイベントを渡し、App が書くコメント・ラベル・チェックを確かめる |
| `*-guardrail.test.ts` | ガードレールの範囲と、それに触れる計画・PR の扱い（止めるか通すか）のテスト |
| `hooks-*.test.ts` | hook（`.claude/hooks/`）：見張りの hook（`guard.ts`）が止めるべき操作を止めるか、SessionStart の hook（`session-env.ts`）がセッションの ID を書き残すか、Orca の CLI が無いときに Windows・WSL・Linux を見分けて知らせるか、入口（`run.mjs`）が Node の版を確かめて、動けないときに guard は止め SessionStart は知らせるか |
| `skills.test.ts`・`ship-skill.test.ts`・`qa-retro-skill.test.ts`・`label-delegation.test.ts`・`label-session-decide.test.ts`・`arch-review-skill.test.ts` | skill の手順書（`.claude/skills/`）の書き方と、ラベルを Jev に任せる手順・Jev が下限未満で付けなかったものをセッションが決めて付ける手順・arch-review の手順と arch-reviewer の定義の検査 |
| `orca-skills.test.ts`・`settings-permission-mode.test.ts` | Orca の導入の検査（#195）。`orca-skills.test.ts`：skill の入口（`.claude/skills/orca-cli`・`orchestration`）を取り込んだ版（sha256・コミットの固定値）のまま配ること、MIT の表示（`docs/upstream/`・`NOTICE`）、`harness/managed.json` に当たること、入口に素の `orca` のコマンドが無いこと、`docs/setup.md` の Orca の節と `docs/security.md` の受け入れているリスクの行。`settings-permission-mode.test.ts`：`.claude/settings.json` の `permissions.disableBypassPermissionsMode` で bypass を使えなくし `defaultMode` を書かないこと、`harness/managed.json` がそのキーを持つこと、`docs/setup.md` の Orca の節の利用者の設定と Agent Permissions の手順 |
| `plan-ask-before-post.test.ts` | plan の skill で、Planner の質問（`openQuestions`・`needsHumanReasons`）を批評と投稿の前に人に聞き、答えを計画に書き込んで申告から除く手順と、Routine は聞かないこと、入れ子の ship は投稿せずに fleet に返し、fleet がまとめて聞いて呼び直すこと、`harness/CLAUDE.harness.md` の規則の検査（#289・#299） |
| `readme-*.test.ts` | 各ディレクトリの README が、直下の実在する名前・先頭のコメントから生成した表と食い違っていないかの検査（`readme-index.test.ts`・`readme-generate.test.ts`・`readme-stale-names.test.ts`・`readme-mjs.test.ts`・`readme-folded-description.test.ts`） |
| `report-*.test.ts` | 判定の集計（`harness/lib/report.ts`）のテスト：外れの数え方と fix の PR の結び付け（行・参照の根拠）、Jev の問いの版・問いごとの確率、文字数とトークン数の比 |
| `review-panel-*.test.ts` | 合体版のレビューの組み立て・記録・担当の定義と、今の判定と比べる集計のテスト |
| `dashboard-*.test.ts` | 手元のダッシュボード（`harness/scripts/dashboard.ts`・`harness/scripts/dashboard/`）のテスト：グラフの組み方・カード・サーバー・画面、GitHub の見張りと facts の取り直し、API の上限で止まる・backoff + jitter・接続が0の間は読まない見張りの回し方 |
| `overview-labels.test.ts` | `overview.html` のラベル表示が `harness.config.json` の定義と食い違っていないかの検査 |
| `gitattributes.test.ts` | root の `.gitattributes` が LF で取り出す設定になっているか（`git check-attr`・`git ls-files --eol`）と、docs/setup.md の改行コードをそろえる手順の検査 |
| `plan-review-origin-legacy.test.ts` | 出どころの欄が無い古い計画ゲートの記録から、出し直した計画の前の印を解くか・止めたときの出どころを推し量るか（`recordedOrigin`）と、その計画が委任・bypass の範囲照合に使われるか（#274） |
| `claim-owner.test.ts`・`claim-recheck.test.ts` | 着手宣言の持ち主の決め方（最初の宣言が持ち主、`--takeover` で移る）と、`claim` の投稿 → 待つ → 読み直し・取り下げ、`ensureOwnClaim` の確かめ（#171） |
| `assignee.test.ts`・`claim-assignee.test.ts` | 担当（Issue の Assignee）の判定（自分1人・空・他人・2人以上）と `checkAssignee`（無効なら読まない、PR は Close する Issue で見る）、`postClaim` の `before`・`ensureOwnClaim` の `assignee` で宣言を止めること（#172） |
| `label-on-open.test.ts`・`label-area-from-stopped-plan.test.ts` | Issue の作成で足りない `priority:*`・`area:*` を Jev に問うて付けること（`on-issue.ts`）と、計画ゲートで止まった計画の files が1つの領域に収まるときに App が付ける `area:*`（`on-comment.ts`・`label-apply.ts`）のテスト |
| `issue-triage-materials.test.ts` | Jev にラベルを問う材料（`dependencies`・今の `type:*`・`risk:*`・`area:*`・`epic` のラベル・子の数）と、設定の `classification.priorityCriteria` で priority の基準を上書きすること、`label-apply.ts`・`on-issue.ts` が材料を渡すこと（#259） |
| `scope-check.test.ts` | PR を出す前のローカルの範囲照合（`harness/lib/scope-check.ts`）：ローカルの変更の集め方、App の範囲照合と同じ関数での照合、使える計画が無いときの出力、implement の skill の手順（#290）。サブディレクトリから走らせたときのルートからのパス、`problems` と終了コードの決まり（0・1・3）（#300） |
| `flow.test.ts`・`flow-queue-fleet.test.ts` | 段階のグラフのデータ（`harness/lib/flow.ts`）の検査（行き止まり・届かないノード・端と理由コード）と、queue と fleet の判断の食い違い（既知のものは `support/flow-divergences.ts`）・コードとデータのつながりの検査（#201） |
| `fleet-*.test.ts` | fleet の選び方（重なり・PR 同士の衝突・着手宣言の扱い）と、進め方（入れ子の orca／交互の flat）のテスト |
| `usage-*.test.ts` | usage の集計（今のセッションの記録の選び方、入れ子のサブエージェントの記録も含めること）のテスト |
| `test-tamper-jev.test.ts` | テストの改ざんの検査が見つけたアサーションの書き換えを Jev に問う材料・問い方・答えのまとめ（`harness/lib/test-tamper-jev.ts`）のテスト |
| `gates-tests-jev.test.ts` | `agent/tests` の Jev の判定（shadow・enforce・off、同じ差分の記録の使い回し、判定の受け付けと auto-merge の後の書き直し）のテスト |
| `report-tamper.test.ts` | テストの改ざんの Jev の判定と人の判断（`test:exempt`・Merge した差分）の一致の集計のテスト |
| その他 | `harness/lib/`・`harness/scripts/` の各ロジックのテスト（`<機能名>.test.ts`。例：`plan.test.ts`・`scope.test.ts`・`mutate.test.ts`・`api-count.test.ts`） |
| `support/` | テストが共有する補助（テストとしては動かない） |

新しいテストは既存のファイルの末尾に足さず、機能・ハンドラーごとのファイルに書く。
