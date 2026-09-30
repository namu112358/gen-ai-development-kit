# harness/test/

`node:test` のテスト。`npm run check`（型検査＋テスト）で全部が動く。ファイルが多いので、種類ごとに説明する（このディレクトリは説明の生成の対象外。名前の実在の検査はかかる）。

| 種類 | 内容 |
| --- | --- |
| `gates-*.test.ts` | ゲート（`harness/gates/`）のテスト。偽の GitHub にイベントを渡し、App が書くコメント・ラベル・チェックを確かめる |
| `*-guardrail.test.ts` | ガードレールの範囲と、それに触れる計画・PR の扱い（止めるか通すか）のテスト |
| `hooks-*.test.ts` | hook（`.claude/hooks/`）：見張りの hook（`guard.ts`）が止めるべき操作を止めるか、SessionStart の hook（`session-env.ts`）がセッションの ID を書き残すか、Orca の CLI が無いときに Windows・WSL・Linux を見分けて知らせるか、入口（`run.mjs`）が Node の版を確かめて、動けないときに guard は止め SessionStart は知らせるか、書き換えの場所の見張り（`workspace-guard.ts`。`hooks-workspace-guard*.test.ts`）が main の checkout と fleet のワークスペースの書き換えを止めるか |
| `skills.test.ts`・`ship-skill.test.ts`・`qa-retro-skill.test.ts`・`label-delegation.test.ts`・`label-session-decide.test.ts`・`arch-review-skill.test.ts` | skill の手順書（`.claude/skills/`）の書き方と、ラベルを Jev に任せる手順・Jev が下限未満で付けなかったものをセッションが決めて付ける手順・arch-review の手順と arch-reviewer の定義の検査 |
| `arch-review-loop.test.ts` | arch-review を `/loop` から回すときの検査（#328）：記録の書式（`trigger`・下書きの `body`・`duplicateOf`・`commented`、`/loop` の下書きの上限、本文の「下書き N 件・採用 M 件」）、下書きの採用（`adoptArchReviewDraft`）と採用待ちの一覧（`archReviewAdoption`）、本文の長さの上限、採用で編集した記録があっても作成の新しい記録を前回に選ぶこと、`arch-review-drafts --loop`、skill の「/loop で回すとき」の節と docs の見出し |
| `qa-retro-loop.test.ts` | qa-retro を `/loop` から回すときの期間のつなぎ方（`harness/lib/qa-retro-loop.ts`：前回の回の終わりを次の始まりに・終わりは今の7日前、境目の PR が1回だけ数えられること）、状態のファイルの読み方と進めるときの一致の確かめ、下書きの記録と採用、skill・docs の書き方（#329） |
| `patrol.test.ts` | 見直しのまとめ役 patrol が今回まわす見直しの決め方（`harness/lib/patrol.ts`：観測の差の有無・前回からの経過の下限と上限・1回に回す数の上限・test-prune は勧めるだけ）、2回分の回での変わり方、状態のファイルの読み書きと引数の検査 |
| `patrol-skill.test.ts` | patrol の skill（`.claude/skills/patrol/SKILL.md`）の書き方（入力・手順・やってはいけないこと、`patrol.ts`・`agent.ts` のコマンドの実在、docs/operations.md の「見直しを /loop で回す」へのリンク）と、skill の一覧への載せ方 |
| `unowned-conflict.test.ts` | 持ち主のいない衝突した Agent PR の判定（`harness/lib/unowned-conflict.ts`：宣言の期限の数え方、期限内の宣言があれば出さない、表示する宣言の選び方、「引き継ぐか決める」の行の書き方）。ダッシュボードに出るかは `gates-stale-unowned-conflict.test.ts`（#371） |
| `agent-commands.test.ts` | `harness/scripts/agent.ts` の入口がコマンドの一覧を持たず、`harness/scripts/agent/commands/` から読み込むこと（名前が分ける前と同じ・重複で止まる・.ts だけを読む・知らないコマンドの出力と終了コード）（#313） |
| `orca-skills.test.ts`・`settings-permission-mode.test.ts` | Orca の導入の検査（#195）。`orca-skills.test.ts`：skill の入口（`.claude/skills/orca-cli`・`orchestration`）を取り込んだ版（sha256・コミットの固定値）のまま配ること、MIT の表示（`docs/upstream/`・`NOTICE`）、`harness/managed.json` に当たること、入口に素の `orca` のコマンドが無いこと、`docs/setup.md` の Orca の節と `docs/security.md` の受け入れているリスクの行。`settings-permission-mode.test.ts`：`.claude/settings.json` の `permissions.disableBypassPermissionsMode` で bypass を使えなくし `defaultMode` を書かないこと、`harness/managed.json` がそのキーを持つこと、`docs/setup.md` の Orca の節の利用者の設定と Agent Permissions の手順 |
| `stack-docs.test.ts` | Stacked PR の使い方と制限（#147）：ハーネスの規則・docs・reviewer.md・gh-stack の skill に、積む3条件・`Refs #N`／`Closes #N`・Human Merge・`git merge` での追従が書かれ、reviewer・risk-agent・judge・sync の差分が PR の base からか |
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
| `decision-proceed.test.ts`・`scope-check-proceed.test.ts` | 進める記録（`agent-decision` の `proceed`）：`parseDecision` の書式と `proceedEligibility` の対象の条件（印の窓・編集された計画・停止より前の決定・`acChangeProposed` など）、App の `plan-proceed` の記録があるときのローカルの `scope-check` の委任の照合（#365） |
| `flow.test.ts`・`flow-queue-fleet.test.ts` | 段階のグラフのデータ（`harness/lib/flow.ts`）の検査（行き止まり・届かないノード・端と理由コード）と、queue と fleet の判断の食い違い（既知のものは `support/flow-divergences.ts`）・コードとデータのつながりの検査（#201） |
| `step-node.test.ts`・`step-stop.test.ts`・`step-claim.test.ts`・`stage-file.test.ts`・`sync-loop-config.test.ts` | `agent.ts step`（`harness/lib/step.ts`）が状態ごとに返すノードと、stop の理由コード・宣言の投稿と解除、段階のファイル（`harness/lib/stage-file.ts`）の書き読み、`syncLoop.limit` の設定の検査（#306） |
| `fleet-*.test.ts` | fleet の選び方（重なり・PR 同士の衝突・着手宣言の扱い）と、進め方（入れ子の orca／交互の flat）のテスト |
| `graphql-author.test.ts`・`fleet-status-prefetch.test.ts`・`judge-input-graphql.test.ts` | 付き添いのセッションの読み取りを GraphQL にまとめること（#249）：GraphQL の作者・関係・ID を REST の形にそろえる変換（`harness/lib/graphql-prefetch.ts`）の後で App の名義と作者の関係の判定が同じになること、fleet-status・step の事実集め（`harness/lib/fleet-reads.ts`）を先読みで読んでも今の REST の読み方と同じ事実・表・JSON になること（100件を超えるコメントとラベルのイベントも）、judge-input の過去の PR の節（`harness/lib/past-pr-reads.ts`）を2回の問い合わせで読んでも同じ節になること（続きのある PR は REST で読み直す） |
| `hq-skill.test.ts`・`hq-stall.test.ts` | hq の skill（`.claude/skills/hq/SKILL.md`）の手順（テーマの承認・fleet の起動と上限・まとめて聞く・起こし直しの条件・片付け・書き換えないこと・印）と、規則・docs・`.gitignore` の記載。進んでいない fleet の判定（`harness/lib/hq-stall.ts` の `hq.staleSnapshotMinutes`・`hq.stuckMinutes` の既定値と不正な値、`fleetStall`、`panes.ts fleets`）（#287） |
| `usage-*.test.ts` | usage の集計（今のセッションの記録の選び方、入れ子のサブエージェントの記録も含めること）のテスト |
| `config-limits.test.ts`・`config-limit-keys.test.ts` | 上限の数値のキーの検査（`harness/lib/config.ts` の `limitErrors`：必須・型・範囲、`loadConfig` が誤りで止まること、実物の設定と雛形が通ること）と、コードの定数を設定に出したキー（`classification.issueTriageJevPerRun`・`routine.gateReplyTimeoutMinutes`・`jev.decisionMaxTargets`・`decisionMaxAnswerChars`）で上限が変わり、無ければ今の値で動くこと（#272） |
| `test-tamper-jev.test.ts` | テストの改ざんの検査が見つけたアサーションの書き換えを Jev に問う材料・問い方・答えのまとめ（`harness/lib/test-tamper-jev.ts`）のテスト |
| `gates-tests-jev.test.ts` | `agent/tests` の Jev の判定（shadow・enforce・off、同じ差分の記録の使い回し、判定の受け付けと auto-merge の後の書き直し）のテスト |
| `report-tamper.test.ts` | テストの改ざんの Jev の判定と人の判断（`test:exempt`・Merge した差分）の一致の集計のテスト |
| `test-tamper-config.test.ts` | このリポジトリの `jev.testTamper` が `enforce`、雛形が `shadow` のままで、下限（`testTamperProbability`）が両方 0.9 であること（#364） |
| `observe.test.ts`・`observe-docs.test.ts`・`hotspot.test.ts`・`test-health.test.ts` | 保守の観測（`harness/scripts/observe.ts`）：docs の照合（実在しないサブコマンド・パス・ラベル・設定キー・リンク先・見出し）、ホットスポット（変更回数 × 行数）、テストの健康（遅いテスト・不安定なテスト・生き残ったミュータント）と、節を組んだ JSON・前回との差・GitHub に GET しか呼ばないこと・出力を一時ディレクトリに書くこと（#326） |
| `auto-mode-state.test.ts`・`auto-mode-danger.test.ts`・`auto-mode-danger-format.test.ts` | auto mode（`harness/lib/auto-mode.ts`）：ダッシュボードのラベルと timeline からの状態（人が付けたもの・App や Bot・停止スイッチ）、`autoMode` の設定の既定・上書き・誤り、雛形と `harness.config.json` の `autoMode` と `delegateMergeExclude`。Jev と Claude の答えから保留するかと理由、Jev への要求の state（PR は diff と変更ファイルだけ）、diff が大きすぎるときの skipped（#342）。Claude の危険の判定の書式（計画の `critique.danger`・判定の `risk.danger` の検査、compose-verdict の写し、plan-critic・Risk Agent の定義と手順の文書。#343） |
| `harness-drift.test.ts`・`harness-drift-git.test.ts`・`hooks-session-harness-record.test.ts`・`harness-drift-step.test.ts`・`harness-drift-commands.test.ts`・`ship-fleet-handoff.test.ts` | 読み込みの記録（`harness/lib/harness-drift.ts`）：版（CRLF と LF で同じ）・記録のパスと読み書き・3つの版（読み込み・merge-base・origin）で比べる規則・`fleet-status` の表の下の1行・judge を止める文、git の砂場で origin の変更・本体が古いまま始めた場合・ブランチ自身の変更の見分け、SessionStart の hook が記録を書く（上書きしない）こと、`step` の `harness-stale`、`claim`・`fleet-status` の配線、ship・fleet の SKILL.md の交代の手順（#199） |
| `fleet-watch.test.ts`・`fleet-watch-skill.test.ts` | fleet の待つ間の読み直し（`harness/lib/fleet-watch.ts`）：`fleet.watch` の設定、App 待ちの行の見張りと1回だけの知らせ、Merge 後の見届けが済んでいない行、fleet・ship の SKILL.md の読み直し・呼び直し・終わり方・/clear の後の宣言を1問で聞く手順、`fleet-status --watch` の配線（#199） |
| `worktree-root.test.ts`・`worktree-orca.test.ts`・`worktree-rules.test.ts` | worktree の置き場所（`harness/lib/worktree.ts` の `worktreeRoot`：環境変数 `AGENT_HARNESS_WORKTREE_ROOT` → 設定 `worktreeRoot` → 既定、リポジトリの中と本体を含む祖先を拒む）と、worktree コマンド・合体版のレビューの⑧・ダッシュボードが同じ置き場所を使うこと、Orca の表示名「#番号 短い名前」と Issue を付けること（親子なし、無い・失敗でも止めない）、`harness/CLAUDE.harness.md` の worktree の優先順位の行と `docs/operations.md` の段落（#196） |
| `worktree-args.test.ts` | `agent.ts worktree`・`worktree-remove` の引数の検査（ref が無い・`-` で始まる ref は使い方を出して止まる。gh より前）（#373） |
| `worktree-leftover.test.ts` | 消し残した空のディレクトリ（`worktree` は作り直す・消せないとほかのプロセスが使っていると分かる文で止まる、`worktree-remove` の後に残れば警告）（#373） |
| `panes.test.ts`・`panes-config.test.ts` | fleet と hq のワークスペースのペイン表示（`harness/lib/panes.ts`・`harness/scripts/panes.ts`）：段階の読み替え、fleet 自身の着手宣言の扱い、描き方がスナップショットだけを受け取ること、collect の間隔と、設定（`fleet.shipMode`・`hq.maxFleets`・`panes.collectIntervalSeconds`）の既定値と不正な値（#284） |
| `gate-workflow-stack.test.ts`・`workflow-triggers.test.ts` | ワークフローの YAML（`.github/workflows/`）の検査：gate.yml の起動条件（`if:` の項）と、ci.yml の `on`・concurrency |
| その他 | `harness/lib/`・`harness/scripts/` の各ロジックのテスト（`<機能名>.test.ts`。例：`plan.test.ts`・`scope.test.ts`・`mutate.test.ts`・`mutate-check-targets.test.ts`・`mutate-related-tests.test.ts`・`api-count.test.ts`） |
| `support/` | テストが共有する補助（テストとしては動かない） |

新しいテストは既存のファイルの末尾に足さず、機能・ハンドラーごとのファイルに書く。
