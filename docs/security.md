# 安全設計

安全設計と、受け入れているリスク。

Claude はユーザー本人の GitHub 名義で動くため、名義では人と区別できない。信頼の置き場所は「起動経路」と「専用 GitHub App の操作（既定ブランチの workflow からのみ）」の2つに絞る。

## 仕組み

| 観点 | 実装 |
| --- | --- |
| 起動 | Claude は付き添いのセッションと定期 Routine だけ。`gate.yml` は Claude を動かさない |
| 信頼の根 | App の名義で書かれたラベルイベント・コメント・Check Run だけを信頼する（`harness/lib/state.ts`）。GraphQL で読んだ作者（Bot の `login` に `[bot]` が無い）・関係（`authorAssociation`）・コメントの ID（`fullDatabaseId`）も、`harness/lib/graphql-prefetch.ts` の変換（`restUser` など）で REST の形にそろえてから同じ判定をする（ダッシュボード・`fleet-status`・`step`・`judge-input` の過去の PR の節） |
| 次にやること | App が Actions で queue を計算し、ダッシュボード Issue に公開する。Routine はそれに従う。「`agent:plan-ok` を付けたのが App か」「判定が現在の差分に有効か」は App 側で判断する |
| Routine の GitHub 操作 | Routine に組み込みの GitHub MCP ツールのみ（`gh` と API 用トークンは環境にない）。push は `git` |
| ゲートの起動 | `issue_comment` / `issues` / `pull_request_target`（`ready_for_review` は App 自身のものを除く。Stacked PR に組まれた `stacked` も）/ `push`（既定ブランチ）/ `schedule`。いずれも既定ブランチの workflow が動く |
| PR のコード | ゲートは既定ブランチを checkout し、PR の head は checkout も実行もしない。diff は API で読む |
| 埋め込み | イベントの中身は `GITHUB_EVENT_PATH` から読み、`${{ }}` で run に埋め込まない |
| コメントの作成者 | ゲートは `author_association` が OWNER / MEMBER / COLLABORATOR のコメントだけ受け付ける |
| 秘密 | App と Jev の鍵は Environment `gate` の Secret。`gate` は既定ブランチからの実行に限定。ログ・コメントは伏せ字にする |
| 必須チェック | `agent/review`・`merge-route` は App の `integration_id` に固定。本人名義で同名のステータスを書いても通らない。bypass なし |
| 段階ゲート | `agent:plan-ok` は App だけ。App 以外が付けたら App が外す |
| 計画の紐付け | すべての PR（付き添いのセッションの Agent PR も、人の PR も含む）に、計画のある Issue への `Closes` を必須チェック `agent/plan-link` で求める。例外は人が付ける `plan:exempt`（App が記録）。Stacked PR の層は本文の `Refs #N`（一番上は `Closes #N`）で紐付け、App が `stack-link` を記録して、層が Merge されたら Issue を閉じる |
| 計画の写し | ゲート通過時の計画を App の記録に写す。後で計画コメントが編集されても写しを使う |
| テストの改ざん | テストの削除、skip・only・todo の追加、アサーションの削除・書き換え、テストの名前の変更を必須チェック `agent/tests` で検出する（差分だけを見る決定論的な検査。fork の PR も）。例外は人が付ける `test:exempt`（App が付けた時点の差分の patch-id を記録し、差分が変わると効かない）。人が Merge する PR（ガードレール・`humanMergePaths`・自動 Merge の対象外の判定）では止めずに neutral にし、見つけた行を Human Merge の依頼に載せて人の Merge の判断にまとめる（テストを弱めた PR が自動で Merge されるのを防ぐ目的は変わらない。経路が自動 Merge に変わると止める側に戻る）。`jev.testTamper` が enforce なら、アサーションの書き換えとテストの名前の変更だけの差分は Jev の確率が下限以上で通る（下記「Jev」の「テストの改ざん」）。auto mode の経路に乗る PR は neutral にせず、すべての種類の検出を、Issue と計画に合った妥当な直しかを Jev に問い、検出ごとの確率の最小値が `jev.thresholds.autoModeTestsProbability` 以上なら通す（答えが無い・読めない・差分が変わったときは止める。下記「Jev」の「テストの改ざん」の auto mode） |
| ガードレール | `harness.config.json` の `guardrailPaths`（除外 `guardrailExclude`、一覧自身は外せない、一覧が無ければすべて）に触れる PR は、Risk Agent の答えに関わらず自動 Merge せず理由を受け付けのコメントに書く（変更ファイルはリネームの旧パスも）。触れる計画は想定 Risk に関わらず計画ゲートで止める（`harness/lib/guardrail.ts`）。委任承認の間の例外は [risk-policy.md](risk-policy.md#委任承認) |
| 範囲照合 | 計画の `files` と PR の変更ファイル（リネームは旧パスも）を照合する。最初の階層にワイルドカードがあるパターンは拒否。全件取得できなければ不可 |
| 判定の鮮度 | 判定時と現在の head で、PR 自身の差分の `git patch-id --verbatim` が同じときだけ受け付ける（`--stable` は空白を無視するため使わない） |
| 順序 | push を検知したら最初に auto-merge を解除する。受け付け時は auto-merge → merge-route（直前に PR を取り直す）→ agent/risk → agent/review の順に書き、書き終えた後に auto-merge が変わっていれば merge-route を書き直す |
| 定期照合 | 1時間ごとに、条件を満たさない auto-merge を外す（`GITHUB_TOKEN` による操作はゲートを起動しないため） |
| 失敗した実行のやり直し | `gate.yml` のジョブ `rerun-failed` だけが `GITHUB_TOKEN` の `actions: write` を持つ（ほかのジョブとファイル全体は `contents: read` のまま。App に Actions の権限は与えない）。ジョブは定期実行と手動の起動のときだけ動き、既定ブランチを checkout して `harness/gates/rerun.ts` を動かす。やり直すのは、直近6時間に失敗した1回目（`run_attempt` が 1）の `issue_comment` の実行で、計画・判定・決定の記録のコメントに結び付き、まだ処理されていないものだけ（`harness/gates/rerun-failed.ts`）。`GITHUB_TOKEN` は Actions の API（実行の一覧・`rerun-failed-jobs`）だけに使い、コメントと App の記録は App のトークンで読む。App の上限の残りが少ないときはやり直さない |
| 直接マージ | `.claude/settings.json` の deny（`gh pr merge`、merge API、MCP の merge / PR 編集、auto-merge、`gh pr ready`、Secret・変数・Ruleset、main への push、信頼ラベル）。文字列のパターンなので完全ではない |
| gh stack | 見張りの hook（`.claude/hooks/guard.ts`）が `gh stack` の `merge`・`push`・`sync`・`rebase`・`submit`・`modify`・`alias` など許す一覧の外の操作、ブランチ名やフラグを渡す `link`、スタックの Merge の API（`gh api -X PUT …/pulls/<番号>/merge-async`）を止める（`gh extension exec stack`・`gh-stack` の直接の実行も）。通すのは link（PR 番号・URL だけ）・view・移動だけ |
| 判定の対象 | 同じリポジトリの PR は、計画のある Issue に紐付いていればブランチに関係なく判定する。人の PR は判定が出るまで `agent/review` を通さない。例外は人が付ける `review:exempt`（App が付けた時点の差分の patch-id を記録し、差分が変わると効かない）。fork からの PR は判定せず、例外でのみ通る |
| Agent PR | 同じリポジトリの `claude/` ブランチからの PR。自動 Merge の経路に乗るのはこれだけ |
| 停止スイッチ | ダッシュボードの `agent:auto-merge-stopped`。ダッシュボードが無い・読めない場合は停止扱い |
| 委任承認のスイッチ | ダッシュボードの `agent:delegate-plan`（計画）と `agent:delegate-merge`（計画＋Merge）は人だけが付ける（App・Bot が付けたもの、付けた時刻が未来のものは無効）。セッションは本人の名義で動き GitHub では区別できないため、hook（`.claude/hooks/guard.ts` の保護ラベル）と `.claude/settings.json` の deny、規則の「やってはいけないこと」で止める。自動 Merge の仕組みそのもの（`delegateMergeExclude`、`harness.config.json` は常に）は、計画ゲートでも Merge でも委ねない。停止スイッチが優先する |
| bypass モードのスイッチ | ダッシュボードの `agent:bypass-merge` は人だけが付ける。`agent:delegate-merge` と同じく、hook（`.claude/hooks/guard.ts` の保護ラベル）と `.claude/settings.json` の deny、規則の「やってはいけないこと」で止める。App・Bot が付けたものは無効 |
| 書き換えの場所 | main の checkout と fleet のワークスペース（一番上に印のファイル `.agent-harness-workspace` がある作業ツリー）の中の Edit・Write・NotebookEdit と、作業ツリー・索引を変える git（commit・add・reset など、`--ff-only` も `pull.ff=only` の設定も無い pull と、rebase を伴う pull）を、PreToolUse の hook（`.claude/hooks/workspace-guard.ts`）がどのセッションでも止める（人の決定、#281・#286・#296）。`pull.ff=only` の素の pull も、同じコマンドの中で git の設定の読み先・設定を変える形（前置きの代入・`env X=`・`-c`・`--config-env`、pull より前の文の `export HOME=…` などの環境変数の代入・`source`・`git config` の書き込み）なら場所で判定する（#331）。main の checkout は `git-dir` と `git-common-dir` が同じ作業ツリー（`--separate-git-dir` を含む）で見分ける。書き換えは Issue の worktree の中だけ。OS の一時ディレクトリと `~/.claude` は通す。判定できないとき・hook が動けないときは止める。PreToolUse の hook はこれと `guard.ts`（push・Merge・保護ラベル）の2つ |
| 別リポジトリの参照 | `Closes`・親 Issue・依存の参照先が別リポジトリなら無視する |

## 受け入れているリスク

| リスク | 内容 | 残る守り |
| --- | --- | --- |
| 既存 CI の偽装 | `pull_request` の CI は PR 側の YAML で動くため、CI を書き換えた PR は自分の CI を緑にできる | `.github/**` はガードレールで、App が自動 Merge から外す（人が Merge する） |
| ガードレールの外のハーネス | implement・fleet の skill・テストなど、ガードレールに入れないハーネスの変更は low なら自動 Merge され得る | Risk の判定、`agent/tests`、一覧は人が PR で決める |
| 本人名義の操作 | 直接マージ、`agent:hold` の解除、偽の判定コメントは GitHub 側では防げない | deny、App による記録、段階を別の実行に分けること、将来は Jev を Actions から呼ぶ |
| auto-merge 付与と CI 完了の競合 | 本人名義で medium の PR に auto-merge を付け、ゲートが merge-route を書き換える前に CI が終わると Merge され得る（数秒） | deny |
| `GITHUB_TOKEN` による auto-merge | PR 側の workflow が `GITHUB_TOKEN` で別の PR に auto-merge を付けるとゲートが起動しない | 定期照合（最大1時間） |
| やり直しの権限 | ジョブ `rerun-failed` の `actions: write` のトークンは、同じリポジトリのほかの workflow の実行もやり直せ・取り消せる。実行とコメントの結び付けは、実行の API がコメントを返さないので作成者と作成時刻（120 秒以内）で推定する | ジョブは定期実行と手動の起動のときだけ動き、既定ブランチのコードだけを動かし、トークンを環境変数でスクリプトに渡すだけで外に出さない（`persist-credentials: false`）。結べない実行はやり直さない。誤って結んでも、やり直すのは失敗した1回目の実行で、ゲートは今の状態で判定し直すだけ。やり直した実行は `run_attempt` が 2 になり、二度と選ばない |
| 委任承認の外し忘れ | 委任承認に期限は無く、ダッシュボードのラベルを外すまで続く。外し忘れると、人が見ていない間もガードレール・Risk だけで止まる計画が通り、委任承認（計画＋Merge）なら同じ理由の PR が自動 Merge されうる | ラベルは人だけが付け、停止スイッチが優先する。`delegateMergeExclude`（`harness.config.json` は常に）は委ねない。ダッシュボードの状態の行に委任承認の段階と付けた人が出て、委任で Merge された PR は節「委任承認で Merge された PR」と記録（`delegated-merge`）で見返せる。`agent:delegate-merge` を外すと委任で付けた auto-merge を外す |
| bypass モードの間のハーネス自身の変更 | bypass モードの間は、ハーネス自身の守り（ゲート・ガードレールの一覧・hook・deny・workflow・`harness.config.json`）を変える Agent PR も、ブロッキング指摘が無く範囲照合と `agent/tests` を通れば、人を通らずに Merge される（持ち主の決定、#245） | 見ていないときはラベルを外す、停止スイッチ、`agent:hold`。ダッシュボードの「bypass で Merge された PR」と PR の記録（`bypass-merge`）で見返す |
| auto mode の外し忘れと危険の判定の見落とし | auto mode（ダッシュボードの `agent:auto-mode`）に期限は無く、ラベルを外すまで続く。外し忘れると、人が見ていない間も、中核（ゲート・ガードレールの一覧・hook・deny・workflow・`harness.config.json`）に触れる計画が計画ゲートを通り、同じような Agent PR が、Jev が危険と答えなければ人を通らずに Merge されうる。Jev が守りを弱める変更を見落としたときも同じ（持ち主の決定、Epic #339） | ラベルは人だけが付け（hook・deny）、App・Bot が付けたものは無効、停止スイッチが優先する。Jev の記録が無い・読めない・`skipped`・`error`（`JEV_API_KEY` が無いときを含む）なら保留にする（安全側）。Planner の申告・人の印・批評の関所・必須の条件（`agent/review`・範囲照合・`agent/tests`・`agent:hold`）は auto mode でも止める。auto mode の判断（`harness/lib/auto-mode.ts`・`harness/gates/**`）と問い（`harness.config.json`）は `delegateMergeExclude` の中にあり委任では緩められず、問いを変える PR も危険の判定の対象。ダッシュボードの状態の行と、auto mode で通した・保留にした計画と PR の一覧、PR の記録（`auto-mode-merge`）で見返せる。ラベルを外すと auto mode で付けた auto-merge を外す。詳細は [risk-policy.md](risk-policy.md#auto-mode) |
| auto mode の独立した危険の判定は Jev だけ | Claude（plan-critic・Risk Agent）の危険の判定は、セッションが書く記録（計画ブロックの `critique`・判定コメント）になり、App は写しが本物か見分けられない（セッションが自分の計画に「危険ではない」と書くのは自分で承認を出す形）。そのため Claude の判定は使わず、App の集めた材料による独立した判定は Jev の1つだけで、見落としは Jev の1モデルに懸かる（人の決定、#382。古い計画・判定コメントの `danger` の欄は読まない） | Jev には App が集めた材料（計画コメントの本文と `files`、PR の diff と変更ファイル）だけを渡し、セッションが書いた `facts` などは渡さない。問いは分からなければ危険（yes）と答えるよう書き、下限（`autoMode.jev.dangerSafe`）未満は保留。Reviewer の判定・範囲照合・`agent/tests` は Jev と別に効く |
| 書き換えの場所の抜け道 | `workspace-guard.ts` は Edit・Write・NotebookEdit と git だけを見る。Bash のリダイレクト（`>`）・`sed -i`・`rm`・`cp` など git 以外の書き換え、スクリプトや別のプロセス（`node harness/scripts/agent.ts` など）の中の git、xargs・find -exec で動かす git、印のファイルを消すこと、ヒアストリング（`bash <<< 'git pull'`）の中の git、`export GIT_DIR=…`・`GIT_WORK_TREE` で後の文の作業場所を変える形、スクリプト・別のプロセスの中で設定や環境を変えてから pull する形、外で定義した alias・関数で git を動かす形は止めない（字句から書き先・効く設定を決めきれない） | 規則「作業は常に worktree で行う」（`harness/CLAUDE.harness.md`）、main への push は `guard.ts`・deny・Ruleset が止める、変更は PR と App の判定を通る |
| 既定ブランチ以外が base の PR | base が既定ブランチ以外の PR（Stacked PR の層など）は既定ブランチの Ruleset の外なので、必須チェックでは Merge を止められない | App が orphan-base を Draft に留め、Stacked PR は Human Merge。人が Ready にしてからゲートが Draft に戻すまでの短い間は防げない |
| gh の別名 | `gh alias set` で作った gh の別名、`gh stack alias` で前に作った別名（`gs` など）は hook で中身を追えない | 規則の「やってはいけないこと」、`gh stack alias` は hook が止める、Merge は Ruleset と App の判定を通る |
| コメントの編集 | ゲートは `created` だけを見る | 計画は写しを使う |
| auto mode のテストの判定の材料 | auto mode の経路の PR でテストを弱める変更を Jev に問う材料（Issue の本文と計画の本文）は、人とセッションが書いたもの。計画に理由を書けば、Jev が妥当と答えうる | 計画は計画ゲートを通ったもの・ゲートの停止で止まったもの・人が進めると決めたものだけで、その後に編集されていないもの。auto mode の計画には危険の判定（Jev）がかかる。通した記録は通した差分にだけ効き、人は `agent:hold` で止められる。`report.ts` で通した件数と人が後から直させた件数を見る |
| Routine の push 先 | `claude/` 以外のブランチにも push できる可能性がある | その PR は自動経路に乗らない |
| 合体版の記録の偽り | 合体版のレビューの記録（`agent-review-panel`）はセッションが書くので偽れる。判定コメントより前の記録だけを数えることで防げるのは、App の受け付け・変更要求を見てから記録を合わせることだけで、shadow ではセッションが今の reviewer の出力を見てから記録を合わせることは防げない | 判定コメントより前・未編集・head の一致・コラボレーターの記録だけ数える、集計の表で事実の列と申告の列を分ける、本物・誤検知は事実の裏付けで数える、切り替えの前に人が全件を確かめる（裏付けのうち人のレビューコメントは、セッションも本人の名義で書くので Claude の目印の有無でしか人のものと分けられず、目印の無いセッションのコメントは人のものとして数えてしまう）、担当の定義と組み立て（`.claude/agents/review-*.md`・review-panel の skill・`harness/scripts/review-panel.ts`・`harness/lib/**`）はガードレール（[plan.md](plan.md) の Q91） |
| 決定の記録の名義 | 決定の記録（```` ```agent-decision ````）は人の名義で書かれ、App は人が書いたかセッションが書いたかを区別できない。Routine が書くことも、`.claude/routine.md` の禁止だけで止めている（hook の入力・環境変数では Routine と付き添いのセッションを見分けられない。Routine を再開するときに専用の環境と環境変数を用意すれば hook で止められる見込み） | 外すのは Planner の申告の停止だけ（App のゲートの停止・人が付けた印・AC の変更提案は外さない）、答え済みの計画をゲートがもう一度判定する、既定は `shadow`、ガードレール・critical の停止と Human Merge・判定の受け付けは変えない |
| 外部のプラグイン | 登録したマーケットプレイスの skill・agent の中身がセッションの文脈に入る | コミットに固定・`autoUpdate: false`、更新は人が差分を読んで PR（[setup.md](setup.md#8-プラグイン全員に同じ版で入れる)）、コードを動かす部品（hook・MCP）が無いことを更新のたびに確かめる、判定の担当（reviewer・risk-agent）は WebFetch を持たず判定は reviewer・risk-agent と App だけで決まる |
| Orca の skill | 固定した入口（`.claude/skills/orca-cli`・`orchestration`）が、手元の Orca の `skills get` の案内をセッションの文脈に読み込ませる。案内の中身は手元の Orca の版次第で、リポジトリでは固定されない | 入口はコミットに固定し、改行を LF にそろえた sha256 をテストで確かめる（`harness/test/orca-skills.test.ts`）、更新は Issue と PR（[docs/upstream/README.md](upstream/README.md#stablyaiorca)）、入口にコードを動かす部品（スクリプト・hook）が無い、判定は reviewer・risk-agent と App だけで決まる、Orca の worker も CLAUDE.md とハーネスの規則に従う |
| 権限モード | Orca の既定の起動引数（`--dangerously-skip-permissions`）や各自の `~/.claude/settings.json` はリポジトリから直せない（ハーネスは書き換えない） | プロジェクトの `permissions.disableBypassPermissionsMode: "disable"`（bypass を拒む）、`permissions.deny` と PreToolUse の hook はどのモードでも効く、ゲートと App の判定はモードに関係しない、手で直す手順は [setup.md](setup.md#11-orca標準の実行環境) |

## Jev

Risk 判定を Jev（TypeSafe AI）に任せる前の、シャドー運用の材料と切り替えの基準。段階移行の全体は [plan.md](plan.md#jev-への段階移行)。

**材料**：Jev に渡すのは App が API と設定から集めたものだけにする。

- `diff`：PR の差分
- `changed_files`：変更ファイル（リネームは旧パスも）
- `guardrail_paths`・`guardrail_exclude`：`harness.config.json` のガードレールの一覧

判定コメントの `facts`・level・answers など、セッションが書いたものは渡さない（セッションが Jev を誘導できないように）。例外は auto mode の危険の問いの見解ありの問い（Issue #426）：計画・判定の `authorView`（作業したセッションの見解）を別の欄 `author_view` で渡すが、保留するかは見解なしの確率だけで決め、見解ありの結果は記録（`autoMode.jev.withView`）にだけ残す（自己申告で危険が安全に寄るおそれを、結論に使わないことで抑える。`report.ts` の「auto mode の見解あり・なし（shadow）」で差を見る）。`facts` は記録と人の確認用に残る。Jev はリポジトリを読めないため、diff に見えない影響（変えた関数の呼び出し元など）は分からないものとして安全側に倒すよう問う。

**決定の記録の確かめ**：Planner の申告への人の答え（```` ```agent-decision ````）を確かめるときは、App の計画ゲートの記録にある計画の写しの `needsHumanReasons`・`openQuestions` と、答えの `to`・`choice`・`quote` だけを渡す（本文の要約と日時は渡さない）。`jev.decisionRelease` は `shadow` から始め、`report.ts` の「人の決定の記録（Jev の判定と人の判断）」の一致率を見て、`enforce` にするかを人が PR で決める。

**基準**（`harness/lib/report.ts` の `JEV_ENFORCE_CRITERIA`）：

| 項目 | 値 | 意味 |
| --- | --- | --- |
| 否定側 | 20 件以上 | Claude が自動 Merge 不可とした PR のうち、今の問いの版で Jev が応答したもの。Jev の見落としを検出できるだけの件数 |
| Jev の low の外れ | 0 件 | Jev が low（P(low) が `jev.thresholds.lowProbability` 以上）とした PR のうち、外れたもの |
| Jev だけが「可」 | 0 件 | Claude は不可、Jev は可とした PR |

外れ＝ Merge 後 7 日以内に revert された、または元の PR を直す fix の PR（タイトルが `fix`・`hotfix` で始まるか「修正」を含む、またはブランチ名に `fix`）が Merge された。fix の PR は、変更ファイルが重なるうえで、次のどちらかに当たるときだけ結び付ける（`harness/lib/report.ts` の `fixLinksFor`。偶然同じファイルを触っただけの PR を外れと数えないため。#267）：**行**＝重なるファイルで、fix の PR が元の PR の足した行を消した（書き換えた）か、元の PR の消した行を足し戻した（行番号ではなく内容で比べる。空行・記号だけの行・4文字未満の行は比べない）、**参照**＝fix の PR の題名・本文に、元の PR の番号か元の PR が Closes した Issue の番号がある、または fix の PR が元の PR と同じ Issue を Closes する（Closes する Issue の本文は見ない。背景として過去の PR を名指しする Issue を Closes する PR が、直していない PR に結び付くため）。材料は GitHub の PR の patch・本文・Closes する Issue の番号だけで、GitHub が patch を返さないファイルは参照だけで見る。Jev の low の外れ・Claude の「可」の外れ・合体版の比較の `fix-pr` の裏付け（根拠になったファイルだけ）は、どれもこの結び付けを使う。集計の表の「fix PR」列には、結び付いた PR ごとに根拠（`#244（行）`・`（参照）`・`（行・参照）`）が出る。比べる相手は Claude ではなく結果とする。plan.md の「Jev の『可』に外れがない」を、より厳しい「Jev の low の外れ 0 件」に置き換えた。Jev の「可」の外れと、Claude と Jev の一致率は参考として表に残す（基準には入れない）。集計の表には、ほかに修正の往復（App の修正要求レビューの数）、停滞時間（作成から Merge、未 Merge は Close まで）の中央値、受け付けられなかった判定コメントの数も出る。表の後には、日本語の割合（`jev.size.jaRatio`）の区分ごとに、文字数とトークン数（`usage.input_tokens`）の比も出る（`jev.maxDiffChars` を文字数からトークンでの見積もりに切り替えるかを決めるための実測。docs/plan.md の Q90）。

**問いの版**：Jev への問いの版（`harness/lib/jev.ts` の `JEV_QUESTION_SET`）を受け付けの記録の `jev.questionSet` に残す（無い古い記録は版 1）。基準の3項目（否定側・Jev の low の外れ・Jev だけが「可」）は今の版の記録だけで数え、否定側は Jev が今の版で応答した PR に限る（問いを書き直す前の記録で基準を満たさないように）。表には版の違う記録の件数も出る。集計の最後には「問いごとの確率（Jev）」の節が出て、版ごとに問いごとの確率の分布（最小・25%・中央・75%・最大）と、しきい値で落とした件数・その問いだけで落とした件数を示す（しきい値の決め方は plan.md の Q88）。

**実行のしかた**：付き添いのセッションが手で `node harness/scripts/report.ts <owner>/<repo> [日数]` を実行する（ship・fleet の終わりなど）。基準を満たすかと、満たさない項目が表の下に出る。定期実行は Routine の再開と一緒に決める。

**切り替え**：`jev.mode` を `enforce` にするのは、基準を満たしたうえで人が決め、`harness.config.json` を PR で変える（ガードレールなので人が Merge する）。

### テストの改ざん

`agent/tests` が見つけたアサーションの書き換えとテストの名前の変更を、App が Jev に問う（`jev.testTamper`。`jev.mode` とは独立。docs/plan.md の Q95、手順は [operations.md](operations.md#テストの改ざん検査) の「Jev の判定」）。

- **材料**：App が diff から検出した行（ファイル名・変更前・変更後）だけ。PR 本文・コメント・判定などセッションが書いたものは渡さない。
- **問わないもの**：fork の PR（自動 Merge の経路に乗らず、外部の中身を Jev に送らない）。削除系（テストファイルの削除・リネーム、組にならないテスト定義の削除、skip / only / todo の追加）と対にならないアサーションの削除を含む差分は、問わずに今までどおり止める。
- **Agent が書いた行を問う**：変更前・変更後の行そのものは Agent が書く。行の中に Jev への指示を書き込めば確率を上げられるおそれがあるので、`enforce` にする前に、shadow の記録で人の判断との一致率と「Jev は通す・人は直させた」件数を見る。
- **集計の見方**：`node harness/scripts/report.ts` の指標の表に「テストの改ざん：Jev と人の判断（件数 / 一致率）」「Jev は通す・人は直させた」「Jev は止める・人は通した」が出る。PR ごとに最後の `test-tamper-jev` の記録を使い、人の判断は、同じ差分に `test:exempt` を付けたか同じ差分のまま Merge したら「通した」、違う差分で Merge したら「直させた」（未 Merge は数えない。enforce で Jev が通した記録も、自分で自分を数えないので数えない）。Jev の「通す」は確率が `jev.thresholds.testTamperProbability` 以上（下限が未設定なら0件）。「Jev は通す・人は直させた」が enforce で危険側に外れる件数。enforce の基準は決めておらず、表を見て人が決める。
- **このリポジトリの切り替え**：2026-09-30 に `enforce` にした（持ち主の決定、#364。docs/plan.md の Q104）。上の「`enforce` にする前に一致率を見る」は導入先向けの一般の説明で、このリポジトリでは一致率を見ずに持ち主が切り替えた（`report.ts` が読めなかった。受け入れているリスク：行の中の指示で Jev の確率を上げられるおそれを、一致率で確かめる前に受け入れる）。enforce で Jev が通した記録は一致率に数えないので、切り替えの後は一致率の材料が減る。雛形の既定は `shadow` のまま。

#### テストファイルの削除（Issue #511）

テストファイルを消した PR は、本文に対応表があれば、消したテストの確かめが足したテストに残っているかを Jev に問い、通れば `agent/tests` を止めない（手順は [operations.md](operations.md#テストの改ざん検査) の「テストファイルの削除（移し先の確かめ）」。docs/plan.md の Q105）。

- **材料**：App が diff から集めたもの（消したファイルの削除の行と、移し先の追加の行）だけ。PR 本文は表があるかの確かめにだけ使い、Jev には渡さない。
- **受け入れているリスク**：移し先の行は Agent が書くので、行の中の指示で Jev の確率を上げうる。表の確かめは、消したファイルの名前が本文に出るかだけの印で、通すかは Jev の1モデルの判定だけで決まる（Claude には問わない。人の決定）。

#### auto mode の間（Issue #349）

auto mode の経路に乗る PR では、`agent/tests` のすべての種類の検出を、Issue と計画が求める振る舞いの変更に合った妥当な直しかを Jev に問う（手順は [operations.md](operations.md#テストの改ざん検査) の「auto mode の間（Jev が妥当か）」）。危険の判定は Jev だけ（人の決定、#382）。

- **材料**：PR が Closes する Issue の本文、使える計画の本文（ゲートの後に編集されたものは使わない）、検出した行と前後の差分だけ。PR 本文・コメント・判定などセッションが PR の上で書いたものは渡さない。
- **安全側**：答えが欠けた・読めない、Jev のエラー、問わない条件（件数・大きさ・Issue や計画が無い・鍵が無い・fork）、記録の差分（patch-id）が今の差分と違うときは、今までどおり failure（人に回す）。
- **材料を書いた側**：Issue の本文と計画は人とセッションが書く。計画に理由を書けば Jev が妥当と答えうる（受け入れているリスクの表）。
- **集計の見方**：`node harness/scripts/report.ts` の「テストの改ざん：auto mode で通した」「auto mode で通した・人が後から直させた」。PR ごとに最後の `auto-mode-tests` の記録を使い、通した（`allows`）もので Merge 済みのものを「通した」、そのうち最後の受け付けの patch-id が記録と違う（通した差分のまま Merge されなかった）ものを「直させた」に数える（危険側に外れた件数）。未 Merge は数えない。通した後に Reviewer の指摘の fix など、テストと関係の無い push で差分が変わった PR も「直させた」に数えるので、この件数は多めに出る。

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
