# harness/scripts/

手元（人や Claude のセッション）で動かすコマンド。`node harness/scripts/<名前>.ts` で実行する。使い方は各ファイルの先頭のコメントにある。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `accounts/` | Orca につないだ Claude のアカウントのうち、使用量の低いものを選ぶ手元のコマンド（Epic #813）。 |  |
| `actions-usage.ts` | Actions の使用分（ジョブごとに分単位で切り上げた分）を、ワークフロー・ジョブ・ci のきっかけごとに数える（読むだけ、Issue #624）。 |  |
| `agent.ts` | Routine と人のセッションが使う CLI。 | ○ |
| `agent/` | `harness/scripts/agent.ts` のサブコマンドの実装（`commands/`）と、コマンドが共有する補助（`cli.ts`）。 | ○ |
| `dashboard.ts` | エージェントの状態をグラフで見る、手元のダッシュボード（GitHub に書くのは POST /decisions の決定の記録と POST /confirm-answers の確認事項への答えのコメントだけで、気づきは手元の受け箱に書く）。 |  |
| `dashboard/` | エージェントの状態をグラフで見る手元のダッシュボード（`harness/scripts/dashboard.ts`）の部品。 |  |
| `hq-compact.ts` | hq が fleet と hq 自身の端末へ `/compact` を送る判定と送り方（Issue #737）。 |  |
| `hq-decide.ts` | hq の判定（空いた枠の割り当て・交代の判定・便りの振り分け・引き継ぎの判定）を、hq（モデル）が数えずに済むように、純粋な関数にしたもの（Issue #780）。 |  |
| `hq-state.ts` | hq の控え（hq-fleets.json）と、hq がいない間の fleet の質問の控えを、git の共通ディレクトリの下に置く（Issue #409）。 |  |
| `hq-takeover-ask.ts` | Issue #771：止まった宣言・担当のいない PR の引き継ぎの問いを、hq が 24 時間（HQ_TAKEOVER_DEFAULTS。 |  |
| `hq-watch.ts` | hq の見張り（Issue #559）。 |  |
| `intel-watch.ts` | intel の見張り（Issue #854）。 |  |
| `jev-context.ts` | auto mode の危険の問い（autoModePrJevRequest）を、4通りの材料（今の材料・＋Issue・＋ファイル全体・＋両方）で Jev に問い直し、PR ごとの危険の確率を Markdown の表で標準出力に出す、手で実行する実験用スクリプト（Issue #596）。 |  |
| `mutate.ts` | テストが効いているかを確かめる（mutation）。 |  |
| `observe.ts` | 保守の観測（docs の照合・ホットスポット・テストの健康・運用の健康）を、人が指示したときに1回分だけ出す（LLM を呼ばない決まる集計）。 |  |
| `orca-cli.ts` | Orca の CLI を env・printenv を使わずに決める関数（orcaCliInfo・onPath）の置き場所（Issue #757）。 |  |
| `panes.ts` | fleet と hq のワークスペースのペイン表示（進み具合・人がすること・PR と費用）。 |  |
| `patrol.ts` | 見直しのまとめ役（patrol の skill）が、付き添いのセッションの `/loop` の1回分で使う、前回の観測の読み出し・今回まわす見直しの決定・回の記録。 |  |
| `plan-companions.ts` | 計画の files に、今の規則で一緒に変えるファイルが抜けていないかを見る（`agent.ts check` が plan で使う）。 |  |
| `qa-retro-loop.ts` | qa-retro を付き添いのセッションの `/loop` から回すときの、期間の決め方・進め方と下書きの記録（qa-retro の skill の「/loop で回すとき」が使う）。 |  |
| `readme.ts` | README の表（名前・内容・ガードレール）を、各ディレクトリの直下の名前と先頭のコメントから作る。 |  |
| `relaunch.ts` | Orca が無いときのハーネスの交代で、tmux の中から新しい付き添いのセッションを auto mode で起動する入口（Issue #807）。 |  |
| `report.ts` | 判定の集計（Jev の切り替え判断用）。 | ○ |
| `review-panel.ts` | 合体版のレビュー（.claude/skills/review-panel/SKILL.md）の CLI。 | ○ |
| `session-doctor.ts` | セッションの前提の確かめ（Issue #833）。 |  |
| `setup.ts` | リポジトリ設定を冪等に適用する（人が手元で、リポジトリ管理者の gh 認証で実行する）。 | ○ |
| `sync.ts` | kit の版（タグ・ブランチ・SHA）を指定して、配布物を導入先に写す。 |  |
| `test-prune-loop.ts` | test-prune を付き添いのセッションの `/loop` から回すときの、回の記録と下書きの採用（test-prune の skill の「/loop で回すとき」が使う）。 |  |
| `test-prune.ts` | 減らせるテストの材料を、人が指示したときに1回分だけ集める（LLM を呼ばない決まる集計）。 |  |
<!-- readme:generated end -->
