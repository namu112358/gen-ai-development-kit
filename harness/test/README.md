# harness/test/

`node:test` のテスト。`npm run check`（型検査＋テスト）で全部が動く。ファイルが多いので、種類ごとにファイル名のパターンで説明する（このディレクトリは説明の生成の対象外。パターンが実在のファイルに当たるかと、直下のテストファイルがどれかのパターンに当たるかの検査はかかる）。

| 種類（パターン） | 内容 |
| --- | --- |
| `gates-*.test.ts` | ゲート（`harness/gates/`）のテスト。偽の GitHub にイベントを渡し、App が書くコメント・ラベル・チェックを確かめる |
| `gate-*.test.ts`・`workflow-*.test.ts` | ワークフローの YAML（`.github/workflows/`）の検査：gate.yml の起動条件（`if:` の項）と、ci.yml の `on`・concurrency |
| `guardrail*.test.ts`・`*-guardrail.test.ts` | ガードレールの範囲と、それに触れる計画・PR の扱い（止めるか通すか）のテスト |
| `hooks-*.test.ts` | hook（`.claude/hooks/`）：見張りの hook（`guard.ts`）が止めるべき操作を止めるか、SessionStart の hook（`session-env.ts`）がセッションの ID を書き残すか、Orca の CLI が無いときの知らせ方、入口（`run.mjs`）の Node の版の確かめ、書き換えの場所の見張り（`workspace-guard.ts`）が main の checkout と fleet のワークスペースの書き換えを止めるか |
| `skills*.test.ts`・`*-skill.test.ts`・`qa-retro*.test.ts`・`hq-*.test.ts`・`ship-*.test.ts` | skill の手順書（`.claude/skills/`）の書き方と、各 skill（ship・qa-retro・hq・patrol など）の手順・関わるロジック（qa-retro の期間のつなぎ方、進んでいない fleet の判定、ship と fleet の受け渡しなど）の検査 |
| `arch-review-skill.test.ts`・`arch-review.test.ts`・`arch-review-loop.test.ts` | arch-review の skill の手順と arch-reviewer の定義、記録の書式と下書きの採用、`/loop` から回すときの検査（ほかのテストが README にこのファイル名があることを確かめるので、パターンにせずファイル名で書く） |
| `plan*.test.ts`・`decision-*.test.ts` | 計画の書式・批評・計画ゲートの記録・出し直し・投稿の前に人に聞く手順と、決定の記録（`agent-decision`。`proceed` の書式と対象の条件） |
| `delegate-*.test.ts`・`bypass*.test.ts`・`auto-mode-*.test.ts` | 委任承認・bypass・auto mode の設定と状態、Jev の記録だけから保留するかの判断、Claude の危険の判定を外したこと（欄のある古い計画・判定コメントも読める。#382） |
| `epic*.test.ts`・`split*.test.ts`・`title*.test.ts`・`issue-*.test.ts` | Epic と子課題への分け方、タイトルの書式、Issue Form と Issue の分類の材料 |
| `label*.test.ts`・`priority*.test.ts`・`classify*.test.ts` | ラベルの定義と規則、Jev に任せる手順、セッションが決めて付ける手順、優先度・領域の付け方 |
| `jev*.test.ts` | Jev の問い・言語・使用量 |
| `claim*.test.ts`・`rules-*.test.ts`・`push-*.test.ts`・`assignee*.test.ts`・`session-*.test.ts` | 着手宣言（持ち主の決め方・読み直し・段階・必須の場面）と担当（Assignee）の判定、セッションの ID と目印の規則 |
| `queue*.test.ts`・`publish-*.test.ts`・`concurrency*.test.ts`・`unowned-*.test.ts` | queue の組み方と公開、領域ごとの同時の本数、持ち主のいない衝突した Agent PR の判定 |
| `flow*.test.ts`・`step-*.test.ts`・`stage-*.test.ts`・`sync-*.test.ts` | 段階のグラフのデータ（`harness/lib/flow.ts`）と queue・fleet の判断の食い違い、`agent.ts step` が返すノード、段階のファイル、`syncLoop` の設定 |
| `fleet*.test.ts` | fleet の選び方（重なり・PR 同士の衝突・着手宣言の扱い）と、進め方（入れ子の orca／交互の flat） |
| `worktree*.test.ts`・`panes*.test.ts`・`orca-*.test.ts` | worktree の置き場所と作り方、Orca の表示名、fleet と hq のワークスペースのペイン表示、Orca の skill の入口の固定 |
| `judge*.test.ts`・`verdict*.test.ts`・`compose-verdict-*.test.ts`・`facts*.test.ts`・`scope*.test.ts` | 判定の入力と出力、判定コメント（`agent-verdict`）の書式と判定した head のずれ、facts、PR を出す前の範囲照合 |
| `merge-*.test.ts`・`human-merge*.test.ts`・`tests-*.test.ts`・`exempt*.test.ts`・`patch-id*.test.ts`・`revert*.test.ts`・`pr-*.test.ts`・`main-push*.test.ts`・`stack*.test.ts` | Merge の経路（自動 Merge と Human Merge）、テストの結果と例外ラベル、patch-id、revert、PR と Issue の結び付け、main への push、Stacked PR |
| `review-panel-*.test.ts` | 合体版のレビューの組み立て・記録・担当の定義と、今の判定と比べる集計 |
| `report-*.test.ts`・`render-*.test.ts` | 判定の集計（`harness/lib/report.ts`）：外れの数え方、fix の PR の結び付け、Jev の問いごとの確率、テストの改ざんの判定と人の判断の一致、文字数とトークン数の比、指標の描き方 |
| `test-*.test.ts`・`mutate*.test.ts`・`observe*.test.ts`・`hotspot*.test.ts`・`patrol*.test.ts` | テストの改ざんの検査と Jev への問い方、テストの健康・減らせるテスト、ミュータントの検査、保守の観測（docs の照合・ホットスポット）、見直しのまとめ役 patrol |
| `dashboard-*.test.ts` | 手元のダッシュボード（`harness/scripts/dashboard.ts`・`harness/scripts/dashboard/`）：グラフ・カード・サーバー・画面、GitHub の見張りと API の上限の扱い |
| `usage*.test.ts`・`api-*.test.ts`・`gh-*.test.ts`・`graphql-*.test.ts`・`npm-*.test.ts` | usage の集計、API の呼び出しの数え方、`gh` の呼び出し方と GraphQL の読み取りを REST の形にそろえる変換、npm のコマンド |
| `agent-*.test.ts`・`config-*.test.ts`・`settings-*.test.ts`・`managed*.test.ts`・`setup-*.test.ts`・`ruleset*.test.ts`・`gitattributes*.test.ts` | `agent.ts` の入口、設定（`harness.config.json`・`.claude/settings.json`）のキーと上限、導入先に配るファイルの一覧、setup・Ruleset、改行コードの設定 |
| `harness-drift*.test.ts` | 読み込みの記録（`harness/lib/harness-drift.ts`）：版の比べ方、記録の読み書き、`fleet-status`・`step`・`claim` の配線 |
| `readme-*.test.ts`・`overview-*.test.ts` | 各ディレクトリの README の表と、`overview.html` のラベル表示が、実物と食い違っていないかの検査 |
| `support/` | テストが共有する補助（テストとしては動かない） |

ほかのテストが README の本文に特定のファイル名を求めるときは、その行だけパターンにせずファイル名で書く（ファイル名も同じ検査でパターンとして扱う）。テストファイルはこのディレクトリの直下に置く（`support/` 以外のサブディレクトリの `*.test.ts` は、パターンの検査の対象外）。新しいテストは既存のファイルの末尾に足さず、機能・ハンドラーごとのファイルに書く。ファイル名がどれかのパターンに当たれば、この README は変えなくてよい。どのパターンにも当たらなければ `npm run check`（readme のテスト）が落ちてファイル名を出すので、そのときだけ行かパターンを足す（全部を覆う `*.test.ts` は数えない）。
