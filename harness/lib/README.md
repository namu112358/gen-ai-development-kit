# harness/lib/

ゲート（`harness/gates/`）とコマンド（`harness/scripts/`）が共通で使うロジック。多くは GitHub を呼ばない関数で、テストしやすくしてある。ほとんどがガードレール（変えると人が Merge する場所）で、「対象外」と書いたものだけ `harness.config.json` の `guardrailExclude` で外してある。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `api-count.ts` | GitHub API の呼び出しの回数を、メソッドとパスの形（番号などを伏せたもの）ごとに数える（#247）。 | ○ |
| `arch-review.ts` | arch-review（Merge 済みの PR をまとめて読み、Issue をまたぐ設計のずれを直す Issue の下書きを人に示す skill）の決まる部分。 | ○ |
| `assignee.ts` | 担当（Issue の Assignee）の確かめ（Issue #172）。 | ○ |
| `auto-mode-tests.ts` | auto mode（Epic #339）の間、agent/tests が見つけたテストを弱める変更が妥当かを Jev に問う材料と、答えのまとめ（Issue #349）。 | ○ |
| `auto-mode.ts` | auto mode（Epic #339）の設定・今の状態・Jev の危険の問い・保留するかの判断。 | ○ |
| `blocks.ts` | コメントに埋め込む構造化データと目印。 | ○ |
| `claim.ts` | 着手宣言の投稿と読み直し（Issue #171）。 | ○ |
| `classify.ts` | PR の分類ラベル（表示用）。 | 対象外 |
| `concurrency.ts` | 領域（area）ごとの、同時に開いてよい PR の上限。 | 対象外 |
| `config.ts` | `harness.config.json` の読み込みと、ラベル・理由コード・必須チェックの名前などの定義。 | ○ |
| `decision.ts` | 決定の記録（````agent-decision````）：Planner の申告（needsHuman・openQuestions）への人の答えを、付き添いのセッションが記録する。 | ○ |
| `delegate.ts` | 委任承認：人がダッシュボードのラベルで、計画ゲートの承認（agent:delegate-plan）か、計画ゲートの承認と Merge の判断（agent:delegate-merge）をApp に委ねる（docs/risk-policy.md）。 | ○ |
| `epic.ts` | Epic：計画の `split` で大きな課題を子課題に分ける。 | ○ |
| `exempt.ts` | 人が付ける例外ラベル（review:exempt・test:exempt）は、付けた時点の PR の差分にだけ効く。 | ○ |
| `facts.ts` | queue の材料（事実）を GitHub から集める。 | ○ |
| `fleet-reads.ts` | fleet-status と step の事実集め（Issue ごとの Closes する PR・Issue と PR の事実・main との差・human-review・計画の files）。 | ○ |
| `fleet-watch.ts` | fleet の待つ間の読み直しの判断（Issue #199、人の決定 2026-09-30）。 | ○ |
| `fleet.ts` | fleet（付き添いのセッションで複数の Issue を並行して進める）の段階の判定と選び方。 | ○ |
| `flow.ts` | 段階のグラフ（ノード・エッジ・ループの上限・止まる先の理由）を1か所に置いたデータ（Issue #201）。 | ○ |
| `github.ts` | GitHub REST / GraphQL の最小クライアント。 | ○ |
| `graphql-prefetch.ts` | まとめた GraphQL の問い合わせで Issue・PR の材料を先に読み、REST の形に直す先読みの仕組み（ダッシュボードと fleet-status・step が使う）。 | ○ |
| `guardrail.ts` | ガードレール：Agent が自分を縛る仕組み（App が機械的に強制している部分）。 | ○ |
| `handoff.ts` | 引き継ぎ（````agent-handoff````）：fleet の入れ子の ship が段階の終わりに fleet へ返す書式と検査（Issue #447）。 | ○ |
| `harness-drift.ts` | 読み込みの記録：付き添いのセッションが始めたときに読み込んだハーネスのファイル（CLAUDE.md・規則・担当の定義・skill・settings）の版を、セッションごとに記録し、今の origin の既定ブランチの版と比べて「このセッションの読み込みは古い」かを決める（Issue #199）。 | ○ |
| `hotspot.ts` | 保守の観測（harness/scripts/observe.ts）のホットスポット：直近の期間に変更の多い大きなファイル。 | ○ |
| `hq-stall.ts` | hq が、動いてはいるが進んでいない fleet を見つける判定（Issue #287、人の決定はコメント 5905221457）。 | ○ |
| `incident.ts` | セッションで起きた問題（拒否・人に返す・App の拒否・人の訂正・回避策）の記録（Issue #186）。 | ○ |
| `issue-form.ts` | Issue Forms（.github/ISSUE_TEMPLATE/agent-task.yml）が出力する本文の読み取り。 | ○ |
| `issue-triage.ts` | Issue の分類（種類・領域・優先度）を Jev に問い、提案をまとめる。 | 対象外 |
| `jev.ts` | TypeSafe AI の Jev（https://docs.typesafe.ai/api）で、Risk ポリシーの8問に1回の呼び出しで答えさせる。 | ○ |
| `label-rules.ts` | 必須ラベルの検査（docs/operations.md の「必須ラベルの規則」）。 | ○ |
| `merge-route.ts` | App が PR に残す受け付け記録（````agent-app````、kind=acceptance）と、merge-route の評価。 | ○ |
| `observe-docs.ts` | 保守の観測（harness/scripts/observe.ts）の docs の照合。 | ○ |
| `observe.ts` | 保守の観測（harness/scripts/observe.ts）のまとめ。 | ○ |
| `panes-hq.ts` | hq の3つのペイン（人待ち・Epic/Issue・ログ）の描き方と、hq の控えから今動いている fleet を見つけること。 | ○ |
| `panes.ts` | fleet のワークスペースのペイン表示（harness/scripts/panes.ts）の、段階の読み替えと描き方。 | ○ |
| `past-pr-reads.ts` | judge-input の過去の PR の節の材料（変更ファイルを触った Merge 済みの過去の PR と、そのコメント・レビュー・レビューコメント）を GraphQL でまとめて読む。 | ○ |
| `patch-id.ts` | diff テキストの `git patch-id --verbatim` を返す。 | ○ |
| `patrol.ts` | 見直しのまとめ役（patrol の skill）が、観測の差と前回からの経過で今回まわす見直しを決める（純粋関数）。 | ○ |
| `plan.ts` | 計画コメントの構造化出力（````agent-plan````）。 | ○ |
| `push-claim.ts` | 着手宣言の無いセッションの push を見分ける（harness/gates/push-claim.ts が Agent PR の push で App のコメントにして知らせる）。 | ○ |
| `qa-retro-loop.ts` | qa-retro を付き添いのセッションの `/loop` から回すときの、期間のつなぎ方と手元の状態（純粋関数）。 | ○ |
| `qa-retro.ts` | Merge 済みの PR の振り返り（qa-retro の skill）の集計。 | ○ |
| `queue.ts` | Routine の次の行動を決める純粋関数。 | 対象外 |
| `report.ts` | 判定の集計（Jev の切り替え判断用）の純粋関数。 | ○ |
| `review-panel.ts` | 合体版のレビュー（公式の code-review に、このハーネスの観点⑥〜⑧を足したもの）の組み立てと記録。 | ○ |
| `ruleset.ts` | 既定ブランチの Ruleset の本文（harness/scripts/setup.ts の ruleset が適用する）。 | ○ |
| `scope-check.ts` | PR を出す前に、ローカルの変更が計画の files に収まるかを確かめる（agent.ts の scope-check、Issue #290）。 | ○ |
| `scope.ts` | 計画の「触るファイル一覧」と実際の diff の照合（範囲照合）。 | ○ |
| `session-inputs.ts` | 有人セッションで判定（Reviewer）・批評（plan-critic）に渡す入力と、判定コメントの組み立て。 | ○ |
| `session.ts` | 今のセッションの ID を環境の値から決める（lib は process.env を直接読まず、呼び出し元が渡す）。 | ○ |
| `stack.ts` | PR の base の見分け（既定ブランチ宛て・Stacked PR の層・スタックでないのに base が既定ブランチ以外）。 | ○ |
| `stage-file.ts` | 段階のファイル：agent.ts step（harness/lib/step.ts）が返した今の段階（Issue・ノード・ブランチ・計画の files）を、セッションごとに書くファイル（Issue #306）。 | ○ |
| `stalled-claim.ts` | 止まっていそうな着手宣言の判定（ダッシュボードの節「止まっていそうな着手宣言」、Issue #391）。 | ○ |
| `state.ts` | GitHub 上の状態の読み取り。 | ○ |
| `step.ts` | agent.ts step の判断（Issue #306）：GitHub の事実と段階のグラフ（flow.ts）から、今やってよいノードを1つだけ返す。 | ○ |
| `test-health.ts` | 保守の観測（harness/scripts/observe.ts）のテストの健康：遅いテスト、不安定なテスト（同じ head で失敗の後に成功）、mutation で生き残ったミュータント。 | ○ |
| `test-prune-loop.ts` | test-prune を付き添いのセッションの `/loop` から回すときの、手元の状態と回の記録（純粋関数）。 | ○ |
| `test-prune.ts` | 減らせるテストの材料（harness/scripts/test-prune.ts）の決まる集計。 | ○ |
| `test-tamper-jev.ts` | テストの改ざんの検査（agent/tests）が見つけたアサーションの書き換えとテストの名前の変更を Jev に問う材料と、答えのまとめ（Q95）。 | ○ |
| `test-tamper.ts` | テストの改ざん検査（agent/tests）。 | ○ |
| `title.ts` | Issue・PR のタイトルの形式（Conventional Commits）。 | ○ |
| `unowned-conflict.ts` | 持ち主のいない衝突した Agent PR の判定（ダッシュボードの「引き継ぐか決める」の行）。 | ○ |
| `usage.ts` | Claude Code のセッション記録（jsonl）からトークン数を集計し、API で動かした場合の料金を見積もる。 | 対象外 |
| `validate.ts` | 依存なしの小さな検証ヘルパー。 | ○ |
| `verdict.ts` | 判定コメントの構造化出力（````agent-verdict````）。 | ○ |
| `worktree.ts` | 作業用の git worktree（リポジトリの外の作業場所）の作成（`node_modules` が無ければ `npm ci` まで）と削除、置き場所の決め方、Orca の表示名。 | 対象外 |
<!-- readme:generated end -->
