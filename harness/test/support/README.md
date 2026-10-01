# harness/test/support/

テストが共有する補助。ファイル名を `*.test.ts` にしないので、それ自体はテストとして動かない。

| 名前 | 内容 |
| --- | --- |
| `agent-source.ts` | `harness/scripts/agent.ts` とサブコマンド（`harness/scripts/agent/` の下）のソースをつないで読み、使い方のコメントに書かれたコマンド名を集める（ソースの文字列を確かめるテストが共有する。#313） |
| `dashboard-fixtures.ts` | ダッシュボードの読み直しのテスト用の見本（1つの見本を、REST の応答と、まとめた GraphQL の問い合わせの応答の両方で返す偽の GitHub）と、内側に流れた呼び出しの短い形 |
| `gate-fixtures.ts` | ゲートのテスト用の偽の GitHub（呼び出しを記録し、決めた応答を返す）と、ゲートの実行コンテキスト・PR・判定・イベントの見本 |
| `flow-divergences.ts` | queue（`decideIssue`・`decidePr`）と fleet（`fleetStatus`）が次にやることで食い違うと分かっている組み合わせの一覧（述語と理由。`flow-queue-fleet.test.ts` が使う。#201） |
| `git-sandbox.ts` | worktree のテスト用の git の砂場（一時ディレクトリに bare の origin と、その clone（本体）を作る） |
| `judge-graphql-fixtures.ts` | judge-input の過去の PR の読み方のテスト用の見本（1つの見本を、REST の応答と、まとめた GraphQL の問い合わせ（PastPrHistories・PastPrThreads）の応答と、前のファイルごとの履歴の問い合わせの応答で返す偽の GitHub。#249） |
| `output-file-rules.ts` | サブエージェントの定義に同じ言い回しで置く「渡された出力のパスに自分で書く」決まりの文（判定の担当と plan-critic のテストが共有する） |
| `skill-text.ts` | skill の文を確かめるテストの補助（frontmatter・節・手順の切り出しと、skill ごとの構造の表（見出し・語・含まないはずの語・順番）を本文と照らし、足りないものを全部一度に返す `skillProblems`。#487） |
| `stack-fixtures.ts` | Stacked PR・orphan-base のテスト用の見本（stack 付きの PR、orphan-base／base-resolved の App の記録、agent:blocked の events）と、`acceptanceFake` にルートを足した偽の GitHub |
| `step-fixtures.ts` | `agent.ts step`（`harness/lib/step.ts`）のテスト用の事実（IssueFacts・PrFacts・FleetIssue・FleetPr・StepInput）の既定値と、判定のゲートと同じ形の変更要求レビューの本文（#306） |
| `workspace-guard-sandbox.ts` | 書き換えの場所の見張りの hook（`.claude/hooks/workspace-guard.ts`）のテスト用の git の砂場（本体のリポジトリ（local の `pull.ff`・`pull.rebase` を書ける）・Issue の worktree・通す置き場所）と、hook の入力の組み立てと判定の検査（#296） |
