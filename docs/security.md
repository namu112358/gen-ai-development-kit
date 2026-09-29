# 安全設計

安全設計と、受け入れているリスク。

Claude はユーザー本人の GitHub 名義で動くため、名義では人と区別できない。信頼の置き場所は「起動経路」と「専用 GitHub App の操作（既定ブランチの workflow からのみ）」の2つに絞る。

## 仕組み

| 観点 | 実装 |
| --- | --- |
| 起動 | Claude は付き添いのセッションと定期 Routine だけ。`gate.yml` は Claude を動かさない |
| 信頼の根 | App の名義で書かれたラベルイベント・コメント・Check Run だけを信頼する（`harness/lib/state.ts`） |
| 次にやること | App が Actions で queue を計算し、ダッシュボード Issue に公開する。Routine はそれに従う。「`agent:plan-ok` を付けたのが App か」「判定が現在の差分に有効か」は App 側で判断する |
| Routine の GitHub 操作 | Routine に組み込みの GitHub MCP ツールのみ（`gh` と API 用トークンは環境にない）。push は `git` |
| ゲートの起動 | `issue_comment` / `issues` / `pull_request_target` / `push`（既定ブランチ）/ `schedule`。いずれも既定ブランチの workflow が動く |
| PR のコード | ゲートは既定ブランチを checkout し、PR の head は checkout も実行もしない。diff は API で読む |
| 埋め込み | イベントの中身は `GITHUB_EVENT_PATH` から読み、`${{ }}` で run に埋め込まない |
| コメントの作成者 | ゲートは `author_association` が OWNER / MEMBER / COLLABORATOR のコメントだけ受け付ける |
| 秘密 | App と Jev の鍵は Environment `gate` の Secret。`gate` は既定ブランチからの実行に限定。ログ・コメントは伏せ字にする |
| 必須チェック | `agent/review`・`merge-route` は App の `integration_id` に固定。本人名義で同名のステータスを書いても通らない。bypass なし |
| 段階ゲート | `agent:plan-ok` は App だけ。App 以外が付けたら App が外す |
| 計画の紐付け | すべての PR（付き添いのセッションの Agent PR も、人の PR も含む）に、計画のある Issue への `Closes` を必須チェック `agent/plan-link` で求める。例外は人が付ける `plan:exempt`（App が記録） |
| 計画の写し | ゲート通過時の計画を App の記録に写す。後で計画コメントが編集されても写しを使う |
| テストの改ざん | テストの削除、skip・only・todo の追加、アサーションの削除・書き換えを必須チェック `agent/tests` で検出する（差分だけを見る決定論的な検査。fork の PR も）。例外は人が付ける `test:exempt`（App が付けた時点の差分の patch-id を記録し、差分が変わると効かない）。人が Merge する PR（ガードレール・`humanMergePaths`・自動 Merge の対象外の判定）では止めずに neutral にし、見つけた行を Human Merge の依頼に載せて人の Merge の判断にまとめる（テストを弱めた PR が自動で Merge されるのを防ぐ目的は変わらない。経路が自動 Merge に変わると止める側に戻る） |
| ガードレール | `harness.config.json` の `guardrailPaths`（除外 `guardrailExclude`、一覧自身は外せない、一覧が無ければすべて）に触れる PR は、Risk Agent の答えに関わらず自動 Merge せず理由を受け付けのコメントに書く（変更ファイルはリネームの旧パスも）。触れる計画は想定 Risk に関わらず計画ゲートで止める（`harness/lib/guardrail.ts`）。委任承認の間の例外は [risk-policy.md](risk-policy.md#委任承認) |
| 範囲照合 | 計画の `files` と PR の変更ファイル（リネームは旧パスも）を照合する。最初の階層にワイルドカードがあるパターンは拒否。全件取得できなければ不可 |
| 判定の鮮度 | 判定時と現在の head で、PR 自身の差分の `git patch-id --verbatim` が同じときだけ受け付ける（`--stable` は空白を無視するため使わない） |
| 順序 | push を検知したら最初に auto-merge を解除する。受け付け時は auto-merge → merge-route（直前に PR を取り直す）→ agent/risk → agent/review の順に書き、書き終えた後に auto-merge が変わっていれば merge-route を書き直す |
| 定期照合 | 3時間ごとに、条件を満たさない auto-merge を外す（`GITHUB_TOKEN` による操作はゲートを起動しないため） |
| 直接マージ | `.claude/settings.json` の deny（`gh pr merge`、merge API、MCP の merge / PR 編集、auto-merge、`gh pr ready`、Secret・変数・Ruleset、main への push、信頼ラベル）。文字列のパターンなので完全ではない |
| 判定の対象 | 同じリポジトリの PR は、計画のある Issue に紐付いていればブランチに関係なく判定する。人の PR は判定が出るまで `agent/review` を通さない。例外は人が付ける `review:exempt`（App が付けた時点の差分の patch-id を記録し、差分が変わると効かない）。fork からの PR は判定せず、例外でのみ通る |
| Agent PR | 同じリポジトリの `claude/` ブランチからの PR。自動 Merge の経路に乗るのはこれだけ |
| 停止スイッチ | ダッシュボードの `agent:auto-merge-stopped`。ダッシュボードが無い・読めない場合は停止扱い |
| 委任承認のスイッチ | ダッシュボードの `agent:delegate-plan`（計画）と `agent:delegate-merge`（計画＋Merge）は人だけが付ける（App・Bot が付けたもの、付けた時刻が未来のものは無効）。セッションは本人の名義で動き GitHub では区別できないため、hook（`.claude/hooks/guard.ts` の保護ラベル）と `.claude/settings.json` の deny、規則の「やってはいけないこと」で止める。自動 Merge の仕組みそのもの（`delegateMergeExclude`、`harness.config.json` は常に）は、計画ゲートでも Merge でも委ねない。停止スイッチが優先する |
| 別リポジトリの参照 | `Closes`・親 Issue・依存の参照先が別リポジトリなら無視する |

## 受け入れているリスク

| リスク | 内容 | 残る守り |
| --- | --- | --- |
| 既存 CI の偽装 | `pull_request` の CI は PR 側の YAML で動くため、CI を書き換えた PR は自分の CI を緑にできる | `.github/**` はガードレールで、App が自動 Merge から外す（人が Merge する） |
| ガードレールの外のハーネス | implement・fleet の skill・テストなど、ガードレールに入れないハーネスの変更は low なら自動 Merge され得る | Risk の判定、`agent/tests`、一覧は人が PR で決める |
| 本人名義の操作 | 直接マージ、`agent:hold` の解除、偽の判定コメントは GitHub 側では防げない | deny、App による記録、段階を別の実行に分けること、将来は Jev を Actions から呼ぶ |
| auto-merge 付与と CI 完了の競合 | 本人名義で medium の PR に auto-merge を付け、ゲートが merge-route を書き換える前に CI が終わると Merge され得る（数秒） | deny |
| `GITHUB_TOKEN` による auto-merge | PR 側の workflow が `GITHUB_TOKEN` で別の PR に auto-merge を付けるとゲートが起動しない | 定期照合（最大3時間） |
| 委任承認の外し忘れ | 委任承認に期限は無く、ダッシュボードのラベルを外すまで続く。外し忘れると、人が見ていない間もガードレール・Risk だけで止まる計画が通り、委任承認（計画＋Merge）なら同じ理由の PR が自動 Merge されうる | ラベルは人だけが付け、停止スイッチが優先する。`delegateMergeExclude`（`harness.config.json` は常に）は委ねない。ダッシュボードの状態の行に委任承認の段階と付けた人が出て、委任で Merge された PR は節「委任承認で Merge された PR」と記録（`delegated-merge`）で見返せる。`agent:delegate-merge` を外すと委任で付けた auto-merge を外す |
| コメントの編集 | ゲートは `created` だけを見る | 計画は写しを使う |
| Routine の push 先 | `claude/` 以外のブランチにも push できる可能性がある | その PR は自動経路に乗らない |
| 合体版の記録の偽り | 合体版のレビューの記録（`agent-review-panel`）はセッションが書くので偽れる。判定コメントより前の記録だけを数えることで防げるのは、App の受け付け・変更要求を見てから記録を合わせることだけで、shadow ではセッションが今の reviewer の出力を見てから記録を合わせることは防げない | 判定コメントより前・未編集・head の一致・コラボレーターの記録だけ数える、集計の表で事実の列と申告の列を分ける、本物・誤検知は事実の裏付けで数える、切り替えの前に人が全件を確かめる（裏付けのうち人のレビューコメントは、セッションも本人の名義で書くので Claude の目印の有無でしか人のものと分けられず、目印の無いセッションのコメントは人のものとして数えてしまう）、担当の定義と組み立て（`.claude/agents/review-*.md`・review-panel の skill・`harness/scripts/review-panel.ts`・`harness/lib/**`）はガードレール（[plan.md](plan.md) の Q91） |
| 決定の記録の名義 | 決定の記録（```` ```agent-decision ````）は人の名義で書かれ、App は人が書いたかセッションが書いたかを区別できない。Routine が書くことも、`.claude/routine.md` の禁止だけで止めている（hook の入力・環境変数では Routine と付き添いのセッションを見分けられない。Routine を再開するときに専用の環境と環境変数を用意すれば hook で止められる見込み） | 外すのは Planner の申告の停止だけ（App のゲートの停止・人が付けた印・AC の変更提案は外さない）、答え済みの計画をゲートがもう一度判定する、既定は `shadow`、ガードレール・critical の停止と Human Merge・判定の受け付けは変えない |
| 外部のプラグイン | 登録したマーケットプレイスの skill・agent の中身がセッションの文脈に入る | コミットに固定・`autoUpdate: false`、更新は人が差分を読んで PR（[setup.md](setup.md#8-プラグイン全員に同じ版で入れる)）、コードを動かす部品（hook・MCP）が無いことを更新のたびに確かめる、判定の担当（reviewer・risk-agent）は WebFetch を持たず判定は reviewer・risk-agent と App だけで決まる |

## Jev

Risk 判定を Jev（TypeSafe AI）に任せる前の、シャドー運用の材料と切り替えの基準。段階移行の全体は [plan.md](plan.md#jev-への段階移行)。

**材料**：Jev に渡すのは App が API と設定から集めたものだけにする。

- `diff`：PR の差分
- `changed_files`：変更ファイル（リネームは旧パスも）
- `guardrail_paths`・`guardrail_exclude`：`harness.config.json` のガードレールの一覧

判定コメントの `facts`・level・answers など、セッションが書いたものは渡さない（セッションが Jev を誘導できないように）。`facts` は記録と人の確認用に残る。Jev はリポジトリを読めないため、diff に見えない影響（変えた関数の呼び出し元など）は分からないものとして安全側に倒すよう問う。

**決定の記録の確かめ**：Planner の申告への人の答え（```` ```agent-decision ````）を確かめるときは、App の計画ゲートの記録にある計画の写しの `needsHumanReasons`・`openQuestions` と、答えの `to`・`choice`・`quote` だけを渡す（本文の要約と日時は渡さない）。`jev.decisionRelease` は `shadow` から始め、`report.ts` の「人の決定の記録（Jev の判定と人の判断）」の一致率を見て、`enforce` にするかを人が PR で決める。

**基準**（`harness/lib/report.ts` の `JEV_ENFORCE_CRITERIA`）：

| 項目 | 値 | 意味 |
| --- | --- | --- |
| 否定側 | 20 件以上 | Claude が自動 Merge 不可とした PR のうち、今の問いの版で Jev が応答したもの。Jev の見落としを検出できるだけの件数 |
| Jev の low の外れ | 0 件 | Jev が low（P(low) が `jev.thresholds.lowProbability` 以上）とした PR のうち、外れたもの |
| Jev だけが「可」 | 0 件 | Claude は不可、Jev は可とした PR |

外れ＝ Merge 後 7 日以内に revert された、または同じファイルを直す fix の PR（タイトルが `fix`・`hotfix` で始まるか「修正」を含む、またはブランチ名に `fix`）が Merge された。比べる相手は Claude ではなく結果とする。plan.md の「Jev の『可』に外れがない」を、より厳しい「Jev の low の外れ 0 件」に置き換えた。Jev の「可」の外れと、Claude と Jev の一致率は参考として表に残す（基準には入れない）。集計の表には、ほかに修正の往復（App の修正要求レビューの数）、停滞時間（作成から Merge、未 Merge は Close まで）の中央値、受け付けられなかった判定コメントの数も出る。表の後には、日本語の割合（`jev.size.jaRatio`）の区分ごとに、文字数とトークン数（`usage.input_tokens`）の比も出る（`jev.maxDiffChars` を文字数からトークンでの見積もりに切り替えるかを決めるための実測。docs/plan.md の Q90）。

**問いの版**：Jev への問いの版（`harness/lib/jev.ts` の `JEV_QUESTION_SET`）を受け付けの記録の `jev.questionSet` に残す（無い古い記録は版 1）。基準の3項目（否定側・Jev の low の外れ・Jev だけが「可」）は今の版の記録だけで数え、否定側は Jev が今の版で応答した PR に限る（問いを書き直す前の記録で基準を満たさないように）。表には版の違う記録の件数も出る。集計の最後には「問いごとの確率（Jev）」の節が出て、版ごとに問いごとの確率の分布（最小・25%・中央・75%・最大）と、しきい値で落とした件数・その問いだけで落とした件数を示す（しきい値の決め方は plan.md の Q88）。

**実行のしかた**：付き添いのセッションが手で `node harness/scripts/report.ts <owner>/<repo> [日数]` を実行する（ship・fleet の終わりなど）。基準を満たすかと、満たさない項目が表の下に出る。定期実行は Routine の再開と一緒に決める。

**切り替え**：`jev.mode` を `enforce` にするのは、基準を満たしたうえで人が決め、`harness.config.json` を PR で変える（ガードレールなので人が Merge する）。

### 日本語の材料の実験

Jev は英語が主言語のため、日本語の材料（PR の diff・Issue の本文）を渡したときに答えが変わらないかを、手で実行する実験で確かめる（Epic #130）。ゲート（`gate.yml`）には組み込まず、ゲートでの自動の英訳もしない。スクリプトは `harness/scripts/jev-language.ts`。

**目的**：本番と同じ問い（`harness/lib/jev.ts` の `buildJevRequest`、`harness/lib/issue-triage.ts` の `buildTriageRequest`）に、同じ材料の日本語版・英訳版を投げ比べ、Brier score・一致率・問いごとの確率の対の差などで、言語による答えのぶれを見る。

**素材の選び方**：Merge 済みの PR 30〜40 件を diff の長さで3層（短・中・長）に分けてそれぞれから選び、日本語を含むものに限る。Issue 20〜30 件は Issue Form の本文のもの（`harness/lib/issue-form.ts` が読める形）から選ぶ。候補が層ごとに足りなければ件数を減らし、減らしたことを実行結果（決定ログ、AC2）に書く。

**訳**：付き添いのセッションが下書きし、人が確かめてから `manifest.json` の項目ごとの `translationReviewed` を `true` にする（`jev-language.ts check` が未確認・残る日本語・diff の食い違い・タイトルの説明部分の訳し忘れ（空のまま）を検出する）。Issue のタイトルは `type(scope):` の部分を残し、後ろの説明だけを英訳する（人の決定、2026-09-27）。Issue の `type`（Jev の `type` の選択肢）はラベルの `type:*`（Conventional Commits の type）とは語彙が違うため、`prepare` が対応表（`feat`→`feature`、`fix`→`bug` など）で合わせて下書きする。

**実行の手順**：承認してから手で実行する。

1. `node harness/scripts/jev-language.ts prepare <owner/repo> <出力先> --prs <番号,…> --issues <番号,…>` で材料と manifest を作る。出力先に既に manifest.json があれば、そこに人が入れた `translationReviewed`・`truth` を新しい manifest に引き継ぐ（材料自体は毎回 GitHub から取り直す）。引き継がずに作り直すときは `--force` を付ける
2. 人が訳を確かめ、`translationReviewed` を `true` にする
3. `node harness/scripts/jev-language.ts check <manifest>` で訳の問題が無いことを確かめる
4. `node harness/scripts/jev-language.ts run <manifest> <結果の出力先> --confirm` で Jev に投げる（`JEV_API_KEY` と `--confirm` が無ければ見積もりだけ）。見積もりは `state` だけでなく問い（`instructions`・`criteria`）ぶんの文字数も数え、既に結果がある項目・言語・回（再開できるように結果の出力先を見て決める）は除く
5. `node harness/scripts/jev-language.ts summarize <manifest> <結果>` で集計する（Brier score・一致率は run1・run2 をまとめて出す。回ごとのぶれ（`runToRunSpread`）、日本語版の input_tokens による3層の対の差も出す）

**費用の見積もり**：文字数からトークン数への換算は日本語・英語で分ける（目安。実測で差し替える前提の係数で、日本語は1文字あたり約 1.5 文字/トークン、英語は約4文字/トークン）。単価は https://docs.typesafe.ai/models を出どころとし、既定は jev-1.13.0 の入力単価（100 万トークンあたり $0.042。出力トークンは無料）（`estimateCost` の引数で差し替え可能）。この式で、上記の規模（PR 30〜40 件・Issue 20〜30 件を日本語版・英訳版・各2回）を見積もると、おおよそ入力トークン数320万・費用$0.13 程度になる（実際の値は選んだ素材で変わるため、`run` は `--confirm` の前に実測の見積もりを出す）。

**結果**：決定ログ（別 Issue、Epic #130 の AC2）に書く。
