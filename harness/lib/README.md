# harness/lib/

ゲート（`harness/gates/`）とコマンド（`harness/scripts/`）が共通で使うロジック。多くは GitHub を呼ばない関数で、テストしやすくしてある。ほとんどがガードレール（変えると人が Merge する場所）で、「対象外」と書いたものだけ `harness.config.json` の `guardrailExclude` で外してある。

| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `blocks.ts` | コメントに埋め込む構造化データ（```` ```agent-plan ```` など）と、Claude・App の目印の読み書き | ○ |
| `classify.ts` | PR の表示用ラベル（差分の行数から `size:*`、変更ファイルから `area:*`）を決める | 対象外 |
| `concurrency.ts` | 領域（`area:*`）ごとに同時に開いてよい PR の数（`areaConcurrency`）の判定 | 対象外 |
| `config.ts` | `harness.config.json` の読み込みと、ラベル・理由コードなどの定義 | ○ |
| `epic.ts` | Epic：計画の `split`（子課題の一覧）の検査と、子 Issue の本文の作り方 | ○ |
| `exempt.ts` | 例外ラベル（`review:exempt`・`test:exempt`）が付けた時点の差分にだけ効くようにする | ○ |
| `facts.ts` | GitHub から Issue・PR の状態（着手宣言・判定・レビューなど）を集め、queue を計算する | ○ |
| `fleet.ts` | fleet（複数の Issue を並行して進める）の段階の判定と、同時に進める Issue の選び方 | ○ |
| `github.ts` | GitHub の API を呼ぶ最小のクライアント（Actions では App のトークン、手元では `gh`） | ○ |
| `guardrail.ts` | ガードレールと `humanMergePaths`（人が Merge するパス）に当たるファイルの判定 | ○ |
| `issue-form.ts` | Issue Form の本文（Goal・Requirements・Acceptance Criteria など）の読み取り | ○ |
| `issue-triage.ts` | Issue の分類（種類・領域・優先度）を Jev に問い、提案をまとめる | 対象外 |
| `jev.ts` | Jev（TypeSafe AI の判定モデル）に Risk の8問を問い、答えを読む | ○ |
| `label-rules.ts` | 必須ラベルの検査（Issue・Epic・PR ごとに足りないラベルと違反） | ○ |
| `merge-route.ts` | App の受け付けの記録と、必須チェック merge-route の評価（自動 Merge してよいか） | ○ |
| `patch-id.ts` | 差分の `git patch-id --verbatim`（main に追従しても差分が同じか）を求める | ○ |
| `plan.ts` | 計画コメント（```` ```agent-plan ````）の読み取りと、計画ゲートの判定 | ○ |
| `queue.ts` | 次にやること（queue）を決める。状態は毎回 GitHub から読み直す | 対象外 |
| `report.ts` | 判定の集計（Jev の切り替え判断用）の計算と表示 | ○ |
| `scope.ts` | 範囲照合：PR の変更ファイルが計画の触るファイル一覧に収まるか | ○ |
| `session-inputs.ts` | 付き添いのセッションで Reviewer・plan-critic に渡す入力と、判定コメントの組み立て | ○ |
| `state.ts` | GitHub 上の状態（ラベル・コメント・Timeline）の読み取り。App の名義で書かれたものだけを信頼する | ○ |
| `test-tamper.ts` | テストの改ざん検査（必須チェック `agent/tests`）：テストの削除や skip の追加、アサーションの書き換えを見つける | ○ |
| `title.ts` | Issue・PR のタイトルの形式（Conventional Commits の `type(scope): 説明`）の読み取り | ○ |
| `usage.ts` | セッションの記録からトークン数を数え、推定料金（目安）を出す | 対象外 |
| `validate.ts` | 依存の無い小さな検証の補助（エラーを場所付きで集める） | ○ |
| `verdict.ts` | 判定コメント（```` ```agent-verdict ````）の読み取りと、自動 Merge・修正ループの条件 | ○ |
| `worktree.ts` | 作業用の git worktree（リポジトリの外の作業場所）の作成と削除 | 対象外 |
