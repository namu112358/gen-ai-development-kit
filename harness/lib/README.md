# harness/lib/

ゲート（`harness/gates/`）とコマンド（`harness/scripts/`）が共通で使うロジック。多くは GitHub を呼ばない関数で、テストしやすくしてある。ほとんどがガードレール（変えると人が Merge する場所）で、「対象外」と書いたものだけ `harness.config.json` の `guardrailExclude` で外してある。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `arch-review.ts` | arch-review（Merge 済みの PR をまとめて読み、Issue をまたぐ設計のずれを直す Issue の下書きを人に示す skill）の決まる部分。 | ○ |
| `blocks.ts` | コメントに埋め込む構造化データと目印。 | ○ |
| `claim.ts` | 着手宣言の投稿と読み直し（Issue #171）。 | ○ |
| `classify.ts` | PR の分類ラベル（表示用）。 | 対象外 |
| `concurrency.ts` | 領域（area）ごとの、同時に開いてよい PR の上限。 | 対象外 |
| `config.ts` | `harness.config.json` の読み込みと、ラベル・理由コード・必須チェックの名前などの定義。 | ○ |
| `decision.ts` | 決定の記録（````agent-decision````）：Planner の申告（needsHuman・openQuestions）への人の答えを、付き添いのセッションが記録する。 | ○ |
| `delegate.ts` | 委任 Merge：人が期限つきで Merge の判断を App に委ねる（docs/risk-policy.md）。 | ○ |
| `epic.ts` | Epic：計画の `split` で大きな課題を子課題に分ける。 | ○ |
| `exempt.ts` | 人が付ける例外ラベル（review:exempt・test:exempt）は、付けた時点の PR の差分にだけ効く。 | ○ |
| `facts.ts` | queue の材料（事実）を GitHub から集める。 | ○ |
| `fleet.ts` | fleet（付き添いのセッションで複数の Issue を並行して進める）の段階の判定と選び方。 | ○ |
| `github.ts` | GitHub REST / GraphQL の最小クライアント。 | ○ |
| `guardrail.ts` | ガードレール：Agent が自分を縛る仕組み（App が機械的に強制している部分）。 | ○ |
| `issue-form.ts` | Issue Forms（.github/ISSUE_TEMPLATE/agent-task.yml）が出力する本文の読み取り。 | ○ |
| `issue-triage.ts` | Issue の分類（種類・領域・優先度）を Jev に問い、提案をまとめる。 | 対象外 |
| `jev.ts` | TypeSafe AI の Jev（https://docs.typesafe.ai/api）で、Risk ポリシーの8問に1回の呼び出しで答えさせる。 | ○ |
| `label-rules.ts` | 必須ラベルの検査（docs/operations.md の「必須ラベルの規則」）。 | ○ |
| `merge-route.ts` | App が PR に残す受け付け記録（````agent-app````、kind=acceptance）と、merge-route の評価。 | ○ |
| `patch-id.ts` | diff テキストの `git patch-id --verbatim` を返す。 | ○ |
| `plan.ts` | 計画コメントの構造化出力（````agent-plan````）。 | ○ |
| `push-claim.ts` | 着手宣言の無いセッションの push を見分ける（harness/gates/push-claim.ts が Agent PR の push で App のコメントにして知らせる）。 | ○ |
| `qa-retro.ts` | Merge 済みの PR の振り返り（qa-retro の skill）の集計。 | ○ |
| `queue.ts` | Routine の次の行動を決める純粋関数。 | 対象外 |
| `report.ts` | 判定の集計（Jev の切り替え判断用）の純粋関数。 | ○ |
| `review-panel.ts` | 合体版のレビュー（公式の code-review に、このハーネスの観点⑥〜⑧を足したもの）の組み立てと記録。 | ○ |
| `ruleset.ts` | 既定ブランチの Ruleset の本文（harness/scripts/setup.ts の ruleset が適用する）。 | ○ |
| `scope.ts` | 計画の「触るファイル一覧」と実際の diff の照合（範囲照合）。 | ○ |
| `session-inputs.ts` | 有人セッションで判定（Reviewer）・批評（plan-critic）に渡す入力と、判定コメントの組み立て。 | ○ |
| `session.ts` | 今のセッションの ID を環境の値から決める（lib は process.env を直接読まず、呼び出し元が渡す）。 | ○ |
| `stack.ts` | PR の base の見分け（既定ブランチ宛て・Stacked PR の層・スタックでないのに base が既定ブランチ以外）。 | ○ |
| `state.ts` | GitHub 上の状態の読み取り。 | ○ |
| `test-tamper.ts` | テストの改ざん検査（agent/tests）。 | ○ |
| `title.ts` | Issue・PR のタイトルの形式（Conventional Commits）。 | ○ |
| `usage.ts` | Claude Code のセッション記録（jsonl）からトークン数を集計し、API で動かした場合の料金を見積もる。 | 対象外 |
| `validate.ts` | 依存なしの小さな検証ヘルパー。 | ○ |
| `verdict.ts` | 判定コメントの構造化出力（````agent-verdict````）。 | ○ |
| `worktree.ts` | 作業用の git worktree（リポジトリの外の作業場所）の作成（`node_modules` が無ければ `npm ci` まで）と削除。 | 対象外 |
<!-- readme:generated end -->
