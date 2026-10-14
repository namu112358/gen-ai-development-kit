# 計画と決定ログ

計画と決定ログ（なぜこの形にしたか）。

今の規則は `harness/docs/` にある。前半にあった古い設計書は #641 で規則を `harness/docs/` に移した後の古い写しだったので外した。読むときは git の履歴（d334f2f の `docs/plan.md`）を見る。

## 今の規則の文書

| 前半の節 | 今の置き場所 |
| --- | --- |
| 目的と前提・アーキテクチャ・安全設計 | [仕組み](../harness/docs/security.md#仕組み)・[受け入れているリスク](../harness/docs/security.md#受け入れているリスク) |
| Issue 契約・ラベルと状態モデル | [ラベル](../harness/docs/operations.md#ラベル)・[formats.md](../harness/docs/formats.md) |
| <a id="開発フロー"></a>開発フロー | [付き添いのセッションで進める](../harness/docs/operations.md#付き添いのセッションで進める)・[glossary.md](../harness/docs/glossary.md)。Stacked PR の層の Issue（本文は `Refs #N`）は、既定ブランチへの push を見て App が閉じる |
| <a id="risk-ポリシーと自動-merge-条件"></a>Risk ポリシーと自動 Merge 条件 | [risk-policy.md](../harness/docs/risk-policy.md) |
| <a id="jev-への段階移行"></a>Jev への段階移行 | [Jev](../harness/docs/security.md#jev) |
| <a id="運用"></a>運用 | [止める仕組み](../harness/docs/operations.md#止める仕組み) |
| 段階の制御をコードに移す | [agent.ts step の出力](../harness/docs/formats.md#agentts-step-の出力)・決定ログ Q92 |
| 元計画からの主な変更点・Phase 計画・将来の移行先：GitHub Actions 版 | 今の規則には無い（経緯は決定ログ Q1〜Q44 と git の履歴） |
| 規約・費用の確認事項 | [規約・費用の確認事項](../harness/docs/security.md#規約費用の確認事項) |

## 決定ログ

レビューでの質疑（Q1〜Q44）の結論。「Actions 版」は以前の版のこのファイルの『将来の移行先：GitHub Actions 版』の章（git の履歴）にのみ当たり、今の構成では置き換わっている。

| # | 論点 | 決定 | 現行構成での扱い |
| --- | --- | --- | --- |
| 前提 | リポジトリ | 個人アカウント・パブリックで構築、後に GitHub Team の private へ | 有効 |
| 前提 | AC 変更 | Agent はコメントで提案のみ | 有効 |
| Q1 | Risk 段階 | low=R0+R1 / medium / high / critical、付与は Agent のみ | 有効 |
| Q2 | low の範囲 | low はすべて自動 Merge | 有効 |
| Q3 | low 判定の方式 | Risk 判定専用の Agent を置く | 有効 |
| Q4 | 決定論的チェック | 併置せず Risk Agent の判定のみ | ガードレールのパスだけ App が判定する（Q82） |
| Q5 | Risk Agent の入力 | diff＋リポジトリ＋ポリシー（自然言語の主張は見せない） | 有効 |
| Q6 | Merge への接続 | head SHA 紐付け＋決定論的ジョブ | 有効（Actions が SHA 検証） |
| Q7・Q8 | 計画承認 | 要判断または high 以上のみ停止 | 有効（ゲートは Actions） |
| Q9 | 帰属 | App＋Timeline・Co-authored-by・PR フッター | Actions 版。現行は実行セッション URL を記録 |
| Q10 | Reviewer | 自動 Merge の必須条件、ブロッキングは AC 未達・範囲外のみ | 有効 |
| Q11 | 修正ループ | 3回まで | 有効 |
| Q12 | 同時実行 | Issue 単位排他・2並列・main 追従必須 | 並列は Actions 版。main 追従は有効 |
| Q13 | 外部入力 | コラボレーターのコメントのみ | 有効（Claude のコメントは目印で区別） |
| Q14 | ラベル権限 | Agent は plan-review / in-pr / blocked / risk:\* のみ | Actions 版。現行は信頼ラベルを Actions のみが付与 |
| Q15 | 依存待ち | `agent:waiting`＋自動再開 | 有効 |
| Q16 | Draft | Draft＝Agent 作業中 | 有効 |
| Q17'・Q18 | 実行基盤・書き込み | 公式 Action＋2ジョブ構成 | Actions 版 |
| Q19 | 保護対象 | App 権限＋Risk ポリシー | Actions 版。現行は Risk ポリシー＋Phase 0 で確認 |
| Q20 | 隔離 | 許可ツール＋通信許可リスト | 現行は Routine の環境設定で実現 |
| Q21 | 利用上限 | `agent:waiting` で自動再開 | 現行は次の定期実行で再試行 |
| Q22 | Close | 子も親も自動 | 有効 |
| Q23 | 計測 | 成果物＋PR フッター | 有効（PR フッター） |
| Q24〜Q30 | Risk ポリシー・Jev | 影響範囲＋revert 可否、8問、事実のみの状態、Claude は3択、一致率で切り替え | 有効 |
| Q31 | 結果の記録 | Check Run、`agent/review` のみ Required | 有効 |
| Q32 | 待ち合わせ | 標準 auto-merge に任せる | 有効 |
| Q33 | fix の起動 | 変更要求レビューに統一 | 有効 |
| Q34 | 計画と実装 | 別ジョブ（停止をコードで強制） | 有効（段階分割＋Actions ゲート） |
| Q35・Q36 | 並列・resume | 前処理で数えて待機、理由別起動 | Actions 版 |
| Q37・Q38 | Phase | Phase 0 で先に検証、Phase 4 で即有効化 | 有効 |
| Q39・Q40 | Actions の範囲 | Claude は人のセッションか定期 Routines、決定論的処理は軽い Actions | 有効 |
| Q41 | GitHub 名義 | 本人のアカウントのまま | 有効 |
| Q42 | 承認 | 要承認は人のセッションで実装 | 有効 |
| Q43 | Routine 構成 | 毎時1本、段階ごと＋Actions ゲート | 有効 |
| Q44 | 判定の受け渡し | SHA 付きコメント → Actions が Check Run 化、Jev は Actions から | 有効 |

**外部レビュー（Keishin の事故記録・ADR との突き合わせ）の反映**。上の表のうち Q10・Q11・Q27 と、`github-actions[bot]` を信頼の根にしていた箇所は、以下で置き換わる。

| # | 指摘 | 決定 |
| --- | --- | --- |
| Q45 | 1. `github-actions[bot]` は PR 側から名乗れる | ゲートは `issue_comment`＋`pull_request_target`（head を checkout しない）。必須チェックの出どころを App に固定 |
| Q46 | 8. `GITHUB_TOKEN` 起点のイベントは後続を起動しない | Actions の書き込みは専用 GitHub App のトークン |
| Q47 | 2. medium を Routine がマージできる | merge-route を必須チェックに＋`.claude/settings.json` で直接マージを deny、bypass なし |
| Q48 | 9. SHA 紐付けと main 追従の衝突 | `git patch-id` が同じなら過去の判定を有効 |
| Q49 | 11. 人と Routine の二重着手 | `agent:working` の着手宣言＋期限、各段階は冪等 |
| Q50 | 3. 決定論的な下限 | 置かない（Q4 のまま）。Q82 でガードレールだけ置く |
| Q51 | 4. low の定義 | 今の定義のまま |
| Q52 | 5. BLOCKING の範囲 | 型・テスト失敗、データ破壊、秘密の漏えい、AC 外の退行も常にブロッキング。敵対的レビューは入れない |
| Q53 | 6. 計画ゲートの入力が自己申告 | 計画に触るファイル一覧を必須化し、実装後の diff を App が照合 |
| Q54 | 7. Jev の切り替え基準 | 結果ベース（revert・fix PR）＋否定側の最低件数、「Jev だけが可」ゼロは維持 |
| Q55 | 10. 止める仕組み | 停止スイッチ、`agent:hold`、revert 1件で自動停止、暴走時の runbook のすべて |
| Q56 | （反映中に判明）PR 内の workflow から鍵を読める | App・Jev の鍵は Environment に置き、既定ブランチからの実行に限定 |
| 小 | 修正回数 | 通常2回、3回目は critical のみ。数え方は PR の Timeline |
| 小 | PR の大きさ | 上限なし |
| 小 | 停滞検知 | 24 時間動きがないものを一覧化 |
| 小 | 追加項目 | 書式とパーサのテスト、書式検査・集計スクリプト（Phase 3）、秘密の伏せ字、private 移行時の Jev の判断 |

**再レビューの反映**

| # | 指摘 | 決定 |
| --- | --- | --- |
| Q57 | B. 既存 CI は PR 側の YAML で動き、緑を偽れる | merge-route にパスの下限は入れない（Q50 のまま）。受け入れるリスクとして明記。Q82 で `.github/**` はガードレールになった |
| Q58 | C. `issue_comment` はだれのコメントでも起動する | private 移行を前提に、受け付け条件・編集対応・埋め込み対策は入れない。受け入れるリスクとして明記 |
| Q59 | E. hold と working の弱点 | `agent:hold` が外されたら App が通知。終了済みの Routine の `agent:working` は次の Routine が引き継ぐ |
| — | D. 時刻による比較 | 対応不要（判定の受け付けは patch-id による比較で、時刻を使っていない） |

**上の表で、その後の決定により変わった行**

- Q6：head SHA 紐付けは Q48 により「PR 自身の差分（patch-id）が同じなら有効」に拡張
- Q31：必須チェックは `agent/review` に加えて merge-route（Q47）。出どころは App に固定（Q45）
- Q41：本人名義のままは変わらないが、信頼できる印は専用 App が付ける（Q46）

**実装開始時の追加決定（2026-09-26）**

| # | 論点 | 決定 |
| --- | --- | --- |
| Q60 | Q58 の作成者チェック | ゲートは `author_association` が OWNER / MEMBER / COLLABORATOR のコメントのみ受け付ける（1行で済むため追加）。`${{ }}` 埋め込みはイベント JSON をファイルから読む実装で発生しない |
| Q61 | 実装言語 | TypeScript（ビルドなし、Node 24 の type stripping、実行時依存ゼロ、`tsc --noEmit`＋`node:test`） |
| Q62 | 質問8の対象 | `harness/**`・`harness.config.json` を追加（Q82 でガードレールに置き換え） |
| Q63 | コードの置き場所 | ハーネスは `harness/` に置き、導入先の製品コードと分ける |
| Q64 | 自動 Merge モード | ダッシュボード Issue の `agent:auto-merge-stopped` ラベルで持つ（App の権限で変数を書けないため）。ダッシュボードが無ければ停止 |
| Q65 | Agent PR | 同じリポジトリの `claude/` ブランチからの PR。それ以外は `agent/review` を判定対象外で通し、自動経路に乗せない |
| Q66 | 人の修正依頼 | PR の Review（Comment）で行う（同じ名義の PR には Request changes を付けられない）。Reviewer の変更要求は App が付ける |
| Q67 | claim の引き継ぎ | 別の Routine の実行の claim は 90 分で引き継ぐ |
| Q68 | deny | Phase 2（Routine 作成）で有効化 |
| Q69 | 変更要求の解除 | 合格した判定を受け付けたら App の過去の変更要求を解除する（修正回数は解除済みも数える） |
| Q70 | patch-id | `--verbatim` を使う（`--stable` は空白を無視する） |
| Q71 | 質問4 の範囲 | 「挙動を変える変更がテストで検証されているか（挙動を変えない変更だけなら yes）」に言い換え |
| Q72 | Routine の GitHub 操作 | GitHub MCP ツールのみ（Routine の環境に `gh` と API 用トークンがない）。queue は App が計算してダッシュボードに公開し、Routine はそれに従う。メトリクスは PR コメントに残す |
| Q79 | タイトルの形式 | Issue と PR のタイトルを Conventional Commits にそろえる。Issue は agent:ready で検査、PR は必須チェック `agent/title`。Routine は PR とコミットに Issue のタイトルを使う |
| Q80 | 作業場所と処理量 | 作業は常に worktree（リポジトリの外）で行う。1回の実行で進める件数は 5 |
| Q81 | Merge 衝突 | main が進むたびにすべての Agent PR を追従させ、衝突したものは Routine が main を取り込んで解消する（触るファイルの重なりは許す） |
| Q82 | ガードレール | critical を「Agent が自分を縛る仕組み（ガードレール）を変える変更」に絞る。一覧は `harness.config.json` の `guardrailPaths`（除外 `guardrailExclude`、一覧自身は外せない、一覧が無ければすべて）。触れる PR は App がパスで自動 Merge から外し、触れる計画は計画ゲートで止める。質問8は「ガードレールに触れるか」に言い換える（キー名は互換のため残す）。Q4・Q50・Q57・Q62 の「パスによる下限は置かない／質問8に任せる」を改める |
| Q83 | Epic とガードレール | Epic に分ける計画（`split`）では、子課題の files がガードレールに触れても計画ゲートで止めない。分ける段階では子 Issue を作るだけで、子課題はそれぞれの計画でゲートがガードレールを判定する（Q82 の「触れる計画は止める」を、split の子課題については子課題の計画で行う） |
| Q84 | ラベルの規則 | 必須ラベルは、Issue が `type:*`・`area:*`・`priority:*`、PR が `type:*`・`area:*`・`size:*`。子を持つ Issue は `epic` が必須で `type:*` を付けない。`type:*` はタイトルの type と同じ一覧。人が付けたラベルは上書きしない。`classification.issueTriage` に `label`（足りないラベルを Jev が付ける。確率の下限は `jev.thresholds.labelProbability`）を足す（Q75 のシャドーのみを改める。付与は #99、検査は #98 で入る） |
| Q85 | 判定の連鎖とガードレール | 判定の入力の作り方・組み立て・手順を変える変更も人が Merge する。`guardrailPaths` に `harness/scripts/agent.ts`、judge・plan の skill、`.claude/routine.md`、plan-critic・test-designer の定義を足し、`guardrailExclude` から `harness/lib/facts.ts`（queue が judge・fix を決める材料として、判定の受け付け・人のレビューなどの事実を集める）を外す。残りの除外（usage・classify・worktree・issue-triage・queue・concurrency）は判定の材料を作らないので残す。`harness/lib/session-inputs.ts` は `harness/lib/**` で既に入っていて扱いを変えない。導入先で人が Merge するパスを足す仕組みは `humanMergePaths` を採る（#105）。Jev の切り替えの基準は harness/docs/security.md に置く（#104）。Q82 の「保護するのは Agent が自分を縛る仕組みだけ」を、判定の連鎖と導入先の下限に広げる |
| Q86 | 判定の連鎖の残り | `guardrailPaths` に sync・fix・ship の skill、`CLAUDE.md`、`harness/scripts/report.ts` を足す（判定の引き継ぎ、再レビューの範囲とテストの改ざん検査、段階のつなぎ、有人セッションで計画の批評の止める条件を上書きする規則、Jev の切り替えの集計を緩められるため）。`harness/lib/queue.ts` は `guardrailExclude` に残す：queue は次にやること（いつ judge・fix するか）を決めるだけで、Merge の条件は App が確かめる（判定は `agent/review` の必須チェックと patch-id に結び付き、範囲照合は計画ゲートを通った計画だけを使い、修正回数は App の `fix-request` で数える）。緩めても判定・修正をしない／余計にするだけで、判定なしの Merge にはならない。事実を集める `harness/lib/facts.ts` はガードレールに入っている（Q85）。implement・fleet の skill はこの決定の対象外 |
| Q87 | テストの改ざん検査と Human Merge | 人が Merge する PR では `agent/tests` を止めず（neutral）、Human Merge の依頼に見つけた行を載せて Merge の判断にまとめる（施策 A、2026-09-27 の人の決定）。Human Merge とみなすのは Agent PR で、変更ファイルがガードレール・`humanMergePaths` に当たるか、現在の差分に対する最新の受け付けが合格かつ自動 Merge の対象外のとき。hold・自動 Merge モードの停止だけが理由のもの、人の PR・fork、auto-merge が付いた PR は対象外（今までどおり `test:exempt`）。経路が自動 Merge に変わると auto-merge を付ける前に failure に戻す |
| Q88 | Jev の問いとしきい値 | これまでの受け付けの記録 64 件（jev-1.13.0）は Jev の `allows` がすべて false で、Claude が low とした 11 件もすべて q2 で落ちた（q2 の yes は 0.77〜0.89。ガードレールに触れる critical の PR でも 0.91 で区別に役立たない）。Jev は問いを文字どおりに読むので、条件を直接書き、境界の例を `criteria` に置く形に書き直した（文は `harness/lib/jev.ts` の `JEV_NOUL_QUESTIONS`）。q2 は instructions を「Would running git revert on this change restore the state from before the change?」にし、criteria の true は「Every change in diff is an edit to files in this repository (documentation, tests, source code, or configuration), and the changed code does not write stored data, call an external service, send messages, or publish or deploy anything when it runs. Changes that only edit documentation or tests are yes.」、false は「diff adds or changes code that, when it runs, writes, deletes, or migrates stored data, calls an external service that changes remote state, sends messages, or publishes, deploys, or releases something. Reverting the files does not undo those effects. This includes changes to CI or deployment workflow files that publish, deploy, or release something when they run.」とした。実行されると外部の状態を変えるコード（このリポジトリでは GitHub API を呼ぶ `harness/gates` など）の変更が q2 で no 側に倒れるのは意図どおり（revert してもラベルやコメントは残る。こうした変更はガードレールで人が Merge する）。q5 は instructions を「Does diff add or change code that writes, deletes, or migrates persistent data?」にし、criteria の true は「diff adds or changes code that, when it runs, writes to, deletes from, or changes the schema of a database, files that the program keeps between runs, or external storage.」、false は「diff changes only documentation, tests, or code that does not write stored data. The edits to repository files shown in diff are not themselves persistent data writes.」とした。q3・q6 は instructions を変えずに criteria を足した（q3：criteria の true は「diff changes the name, parameters, or return value of an exported function, type, or class, or changes the fields, keys, or allowed values of a configuration file, schema, API, command-line option, or event or comment format.」、false は「diff changes only explanatory documentation, tests, code comments, or code that is not exported, and changes no configuration, schema, API, command-line option, or event or comment format.」。q6：criteria の true は「diff changes code or configuration that checks identity or permissions, handles tokens, keys, or passwords, stores or reads secrets, or charges money.」、false は「diff changes no such code or configuration. Documentation that only mentions these topics without changing how they work is no.」）。q1・q4・q7・q8 は変えない。問いの版（`JEV_QUESTION_SET`、今は 2、それまでを 1）を受け付けの記録の `jev.questionSet` に残し、`report.ts` の集計で版ごとに問いごとの確率の分布としきい値で落とした件数を出す。切り替えの基準（否定側・Jev の low の外れ・Jev だけが可）は今の版の記録だけで数える（版 1 は全件が不可なので、混ぜると今の問いを見ないまま「Jev だけが可 0 件」を満たすため）。しきい値は一律の `noulSafe` 0.9 のまま据え置き、問いごとのしきい値は入れない：今の記録で q2 だけを 0.75 に下げると Claude が不可とした PR（#10）も通り「Jev だけが可」が出る。書き直した問いは確率の出方が変わるので今の記録から問いごとの値を決められない。Jev のドキュメント（Confidence）もしきい値は保守的に始めて自分のデータで調整するとしている。決め直すのは版 2 の受け付けの記録が 20 件以上になったとき：`report.ts` の「問いごとの確率」を見て人が決め、問いごとの値を入れるのはその値でも記録の上で「Jev だけが可」が 0 件のままのときに限る。入れるときは別の Issue で `harness.config.json` と `jevAllows` を変える（ガードレールなので人が Merge する）。`jev.mode` は shadow のまま、切り替えの判断は security.md の「Jev」の基準で人が行う |
| Q89 | README の説明の生成 | README の表の「説明」は各ファイル・ディレクトリの先頭のコメントの1文目から生成する（新しいスクリプト `harness/scripts/readme.ts`。ガードレールの外に置き、`agent.ts` には足さない）。表が生成結果と食い違う、表の名前が実在しない、`overview.html` のラベルと設定が食い違う、をそれぞれテストで検査する（#132） |
| Q90 | Jev の材料の大きさ | Jev の上限は state と最も長い問いの合計で 32k トークンで、`jev.maxDiffChars`（80000）は文字数で数えている。日本語は1文字あたりのトークンが多いので、受け付けの記録の `jev.size` と `label-triage` の記録の `size` に、応答の `usage.input_tokens` と、送った材料（state と問いを JSON にしたもの）の文字数・日本語の割合を残し、`harness/scripts/report.ts` の集計に日本語の割合の区分ごとの「文字数 / トークン数」を出す。`jaRatio` は要求全体での割合（英語の問いの文とガードレールの一覧を含むので、diff だけの割合より薄まる）で、diff の文字数は `diffChars` に残す。上限をトークンで見積もる方式（文字の種類ごとの係数など）に切り替えるかは、区分ごとに実測が貯まってから決める。人の決定（2026-09-27）：それまで `maxDiffChars` は 80000 のまま据え置く（下げると shadow の記録が減る。shadow では上限を超えても Jev の結果は記録だけで経路に影響しない。上限を超えたときの Jev の挙動はドキュメントに無いので、enforce に切り替える前にこの比で見直す）。Jev のトークナイザーは再現しない。`label-triage` の記録は集計に入れない（Issue ごとのコメントを読む必要があり API の呼び出しが増えるため。必要になったら別の Issue で足す）（#129） |
| Q91 | 合体版のレビューに切り替える基準 | 記録だけ（shadow）の期間の合体版の記録と、App が受け付けた今の reviewer の判定を head ごとに組にして、`node harness/scripts/report.ts` の最後の節「合体版のレビュー（記録だけの期間の比較）」で比べる。切り替えの基準（`REVIEW_PANEL_SWITCH_CRITERIA`、人が計画で決めた値）は5つ：(1) 組になった PR が 20 件以上、(2) 今の reviewer だけが出して裏付けのあるブロッキング（合体版の見落とし）が 0 件、(3) 合体版だけのブロッキングのうち誤検知の疑いが半分以下（合体版だけが 0 件なら満たす）、(4) 合体版の仮の往復（組のうち合体版が不合格の数）の合計が実際の往復（組になった PR の App の変更要求の合計）の 1.5 倍以下（実際が 0 で仮が 1 以上なら満たさない）、(5) 1判定あたりの推定料金の中央値が今の reviewer の 3 倍以下（どちらかの値が1つも無ければ満たさない）。実際の往復は PR の全部の head、仮は組になった head だけを数えるので範囲がずれる。仮は参考の「今の reviewer が不合格の組」と並べて見る（記録の抜けた head があると仮が少なく出る）。合体版の記録はセッションが書くので偽れる。そのため数えるのは、コラボレーターが書き、Claude の目印があり、ブロックが読め、編集されておらず、head が App の受け付けの `verdictHeadSha` と同じで、判定コメントより前に作られた shadow の記録だけにする（同じ head に複数あれば判定コメントの直前の1つ。外したものは理由ごとの件数を出す）。今の reviewer の指摘は App の変更要求（fix-request）の本文から読み、無ければ未編集の判定コメントから読む。指摘は同じファイル（ファイルが無ければ同じ種類）で1対1に対応させる。片方だけの指摘は、後の head の App の変更要求・判定コメントより後の人のレビューコメント・Merge 後 7 日以内の fix の PR の同じファイル・revert のどれかがあれば「裏付けあり」、無ければ「未確認」。今の reviewer だけの指摘で、そのファイルを後の最初の合格の head までの PR 自身のコミット（main の取り込みを除く）が変えたものは「後の head で直された」として裏付けとは別に数える（指摘を受けたセッションは誤りでも直すので強い証拠ではない。人の決定で基準 (2) には数えず、基準の判定の文に件数を添える。#268）。合体版だけの指摘で、Merge され裏付けが無いものを「誤検知の疑い」とする。表は「App・GitHub の事実」の列と「セッションの申告」の列に分ける。基準を満たしても自動では切り替えない。人が「合体版だけ」の指摘と誤検知の疑いの全件を PR の diff と照らして確かめてから決め、切り替えるなら人が `reviewPanel.mode` を `enforce` にする Issue を立てる（`agent:ready` は 20 件に達して人が決めてから付ける。変更は `harness.config.json` の1行で、ガードレールなので人が Merge）（#150） 比較の節とコードは #1008 で削除（`reviewPanel.mode` は enforce、Q102）。 |
| Q92 | 段階の制御をコードに移す | 段階のつなぎを skill の文章（AI の判断）からコードに移す。段階のグラフを1か所のデータにし、`agent.ts step` が次のノードを1つだけ返し、hook（`guard.ts`）が段階に合わない GitHub への書き込みを止めるところまで（ノードごとに `claude -p` を呼ぶ実行役は作らない）。付き添いのセッションは段階を選ばない窓口にする。担当は Issue の Assignee を正にし、設定が有効なときはちょうど1人で自分のときだけ取る。アサインは人か、人に頼まれた付き添いのセッションが決め、エージェントは自分の判断ではアサインしない（#172）。着手宣言は最初の宣言を持ち主にし、ほかのセッションの宣言は `--takeover` のときだけ持ち主を移す（#171）。Q49・Q67・Q76 の着手宣言による判断に、Assignee の確認を先に足し、持ち主を「最新」から「最初」に改める。Cloudflare・LangGraph へは移さない。人の決定（2026-09-28）。中身は「段階の制御をコードに移す」の節（#169） |
| Q93 | 人の決定の記録で Planner の申告を外す | 付き添いのセッションが、Planner の申告（`needsHuman`・`openQuestions`）への人の答えを ```` ```agent-decision ```` のコメントで記録し（`agent.ts post-decision`）、App が Jev に「すべての理由・質問に答えているか」を問う。材料は App の計画ゲートの記録にある計画の写しと答えだけ。`jev.decisionRelease` は `shadow` から始め（記録だけでラベルは変えない）、`enforce` でしきい値（`jev.thresholds.decisionProbability`）以上なら答え済みとして計画を判定し直す（通れば App が `agent:plan-review` を外す）。App のゲートの停止・人が付けた印（ラベルの時刻で見分ける）・`acChangeProposed` はこの経路で外さない。Routine は `.claude/routine.md` で記録を禁止するだけ（hook では Routine を見分けられない）。切り替えは `report.ts` の一致率を見て人が決める。人の決定（2026-09-27）（#151） |
| Q94 | ラベルを付ける確率の下限の見直し | Jev が `priority:medium` と答えても確率が `labelProbability`（0.8）に届かず、priority の無い Issue が残り続けた（#216 79%・#218 66%・#219 65%・#229 66%）。下限をラベルごとに分けられるようにし（`jev.thresholds.labelProbabilityByLabel`）、`priority:medium` だけ 0.5 に下げる。ラベルの無い Issue は queue で medium として並ぶので、medium を誤って付けても並び順は変わらない。0.5 は過半（medium がほかの選択肢の合計より確からしい）。`priority:high`・`low` などは並び順を、`area:*` は `areaConcurrency` の数え方を変えるので 0.8 のまま。既存の Issue は、最新の `label-triage` の記録の確率で App が1回だけ付け直す（`label-reapply`。Jev に問い直さない）。Jev の材料を足して確信度を上げる案は別の Issue にする（人の決定。#229） |
| Q95 | テストの改ざんの検査が止めた変更を Jev に問う | `agent/tests` が見つけたアサーションの書き換えと、同じ位置で名前だけ変えたテスト定義の組（テストの名前の変更、#421）を、App が Jev に「弱めていないか」を対ごとに問い、確率を `test-tamper-jev` の記録に残す（`jev.testTamper`。`jev.mode` と独立）。材料は App が diff から検出した行（ファイル名・変更前・変更後）だけで、セッションが書いたものは渡さない。削除系（テストファイルの削除・リネーム、組にならないテスト定義の削除、skip / only / todo の追加）と対にならない削除は問わずに止める。fork の PR は問わない。1つの差分（patch-id）に1回だけ問い、使い回すときは今の設定で通すかを決め直す。既定は `shadow`（記録だけで結果は変えない）。`enforce` では確率の最小値が `jev.thresholds.testTamperProbability` 以上なら success（優先順は `test:exempt` → Human Merge の neutral → Jev の enforce → failure。委任・bypass で自動経路に乗る PR も進む）。`enforce` への切り替えは、`report.ts` の人の判断（`test:exempt` か同じ差分で Merge ＝通した、違う差分で Merge ＝直させた）との一致率と「Jev は通す・人は直させた」件数を見て人が決める（基準は決めない）（#126） |
| Q96 | Jev に渡す材料を英訳するか | 英訳しない（人の決定、2026-09-30）。英訳の実験のスクリプト（#1008 で削除） で、Merge 済みの PR 30 件（diff の長さで短・中・長の3層に各10件、`skipped` なし）と Issue Form の Issue 24 件を、日本語版と英訳版（セッションが下書きし人が確かめた）で各2回、本番と同じ問いで Jev（jev-1.13.0）に投げた（216 回、見積もり約 168 万トークン・約 $0.07）。PR の正解（Risk の8問）は埋めない決定のため、Brier score・一致率は判断に使わず、対の差・回ごとのぶれ・input_tokens の比で見た。PR の問いは、対の差（日本語 − 英訳、2回の平均どうし）の平均が q2〜q8 で ±0.011 以内、|差|平均が 0.0015〜0.037 で、回ごとのぶれ（0.002〜0.042）と同程度。q1_risk（正解が無いので総変動距離）は 0.042 で、ぶれ（日本語 0.036・英訳 0.042）と同じ。確率最大の選択肢が入れ替わったのは medium と critical が拮抗した3件だけ。input_tokens の比（日本語 ÷ 英訳）は合計 1.120・項目ごとの中央値 1.144。言語による差がぶれと同程度で、トークンも1割ほどしか変わらず、英訳には #104 の守り（Jev に渡すのは App が API と設定から集めたものだけ）を保つ仕組みとゲートの変更が要るため、見合わないと判断した。注意として、Issue の問いには偏りが残る：priority の |差|平均 0.071（ぶれ約 0.018）、requirements_clear は英訳のほうが高い（平均 −0.035、英訳が上回り 18 件・日本語 6 件）、ac_verifiable は日本語のほうが高い（平均 +0.022、17 件・6 件）。ラベルの付く・付かないが変わったのは priority の2件。長さの3層では短い層ほど差が大きい（|差|平均の平均 0.044・0.031・0.024。短い層は Issue が多い）。Issue のラベルや計画ゲートの判断でこの偏りが問題になれば、別の Issue で問いの言い回しかしきい値を見直す（#137、Epic #130） |
| Q97 | Jev にラベルを問う材料 | Q94 で見たとおり Jev の priority の答えは medium の 65〜79% に集まり、high・low の確信度が低かった。材料に、本文の Dependencies 節、Issue に付いている `type:*`・`risk:*`・`area:*`・`epic`、子の数を足し、priority の基準を `classification.priorityCriteria` で導入先ごとに書き換えられるようにした（このリポジトリ向けの基準を入れた）。どれも App が API と設定から集めたもの（#104 の守り）。較正の例（few-shot）は例ごとに events を読む費用がかかるため、計画の後の問い直しは「一度だけ問う」規則と計画（セッションが書いたもの）を材料にすることになるため、見送った。材料の言語は英訳しない（Q96）。`dependencies` が増えたので、英訳の実験のスクリプト（#1008 で削除） の実験を走らせ直すと Issue の要求はこの版から変わる（Q96 の結果とは同じ材料で比べられない）。材料を足す前と後で #216・#218・#219・#229 を各2回問うた（前・基準だけ・全部の3列、24 回、入力 約3.6万トークン。表は #295 の本文）。priority の最も高い選択肢の確率は、medium のままの3件で 79→81%・68→87%・68→81%（基準だけでも 75〜87%）に上がり、#218（`risk:critical`・`type:fix`）は全部を足すと high 60% に変わった。high・low が 0.8 に届いた Issue は無く、area は前後とも harness 100%。`priority:high`・`low`・`area:*` の下限（0.8）は変えない：下げると、1件だけ・2回とも 57〜63% の high で並び順を変えることになり、根拠が足りない（Issue #259） |
| Q98 | 合体版のレビューのしきい値 | 確信度のしきい値（`harness/lib/review-panel.ts` の `SCORE_THRESHOLD`）を 80 から 75 にする。人の決定（2026-09-30）。80 は公式の code-review の段階6の値だが、公式は人向けのコメントで確実なものだけを出す用途で、採点の刻み（0/25/50/75/100）では実質 100 だけが通る。shadow の記録 80 件（2026-09-27〜09-30）では合体版の不合格が 0 件で、担当が出した指摘 15 件の採点は 75 前後が 8 件・80 以上は 0 件だった。記録から模擬すると 75 なら組になった 74 head のうち 7 件が不合格になり、今の reviewer のブロッキング 2 件のうち #295（AC の未達）と一致した（#231 の退行は 75 でも見落とす）。合体版だけの 6 件のうち、#288 の2件（`harness/test/README.md` に新しいテストの行が無い）と #173（記録の目印の確認が必ず通る）は main に残っている本物だった。採点の基準の文（公式の写し）は変えない。続けて、今の reviewer にあって合体版に無いものを足し（#318）、`reviewPanel.mode` を `enforce` に切り替える（#319）（#317） |
| Q99 | 合体版のレビューに今の reviewer の中身をそろえる | `enforce` に切り替えても判定の強さと中身が落ちないよう、今の reviewer にあって合体版に無いものを足す（人の決定、2026-09-30）。⑦（review-safety）を opus にする（#231 の退行を合体版が見落とした）。⑦の採点にも Issue 本文と計画を渡す。⑥⑦の指摘の採点（review-scorer）は Agent の model を opus にして呼ぶ（人の決定：見つける担当が opus なのに haiku の採点が覆せる作りで、置き換える reviewer は opus で自分で判断している。⑥⑦の指摘は 80 記録で3件と少なく料金はほぼ増えない。haiku が⑥⑦を誤って落とした明らかな例は無く、実績ではなく作りの筋からの判断）。担当が Merge を止めない提案（`suggestions`）を返し、組み立てが採点せず `nonBlocking` に入れる（80 記録で `nonBlocking` が一度も入っていなかった）。⑥⑦に「ハーネス自体・公開インターフェース・データに触れる変更、テストで確かめきれない変更では humanNotes を必ず書く」を足す。料金の見込み：セッションの記録の 57 組では合体版の中央値 $0.757（reviewer $0.272 の 2.78 倍）、うち⑦は $0.102。⑦を opus にすると 3.16 倍（⑦が 1.5 倍なら約 2.97 倍）の見込みで、Q91 の基準 (5)（3 倍以下）の境目にある。基準 (5) の扱いは、切り替え（#319）のときに Merge 後の実際の値を見て人が決める（#318） |
| Q100 | 合体版のレビューで過剰さを見る | 合体版に観点⑨の担当 review-overbuild（sonnet）を足し、計画・AC が求めていない過剰な実装・過剰なテスト・オーバーエンジニアリングを見る。人の決定（2026-09-30）：提案だけで止めない、`enforce` への切り替え（#319）の前に入れる。PR の段階でこれを見るところが無かった（plan-critic は計画の文章だけ、reviewer のブロッキングは6種類だけ、①〜⑤は公式どおり nitpick を避け、⑥は範囲外のファイルだけ）。①〜⑤・⑥に混ぜると公式の文言と今の基準が崩れるので担当を分けた。指摘は1判定5件まで、haiku で採点して点を記録に残すが、確信度・再レビューに関わらず `nonBlocking`（計画の方針ごと過剰なら `humanNotes.checkPoints` にも）。公式の基準の 75 は「機能に直接響く問題」なので過剰さは本物でも 50 前後に出る見込みで、点は「25 以下＝採点の担当が本物と確かめられなかった、50 以上＝本物と確かめた」と当たり具合の材料として読む。出力が無ければ組み立てを止めず、`humanNotes.concerns` に「⑨の記録なし」を残す。料金は +$0.10 前後の見込みで、#318 の後の見込み（reviewer の約 3.16 倍）と合わせて約 3.5〜3.7 倍。基準 (5) の扱いは #319 で人が決める。記録が 20 件ほどたまったら、人が当たり具合を見て止めるようにするか・採点をやめるかを決める（#325） |
| Q101 | 上限の数値の置き場所と検査 | 運用の上限はすべて `harness.config.json` で変える（ガードレールなので人が Merge する）。リポジトリの変数・環境変数では上書きしない（人の決定、2026-09-29。#272）。コードに直書きだった4つ（Jev に分類を問う Issue の数・判定コメントへの App の返答を待つ時間・決定の記録を Jev に問う項目数と文字数）を省略できるキーにし（既定は今の値）、`loadConfig` が上限の数値のキーを型と範囲で検査して、誤りがあればキーと値を示して止まる（上限が効かないまま動かない）。上限でない設定の検査は広げない #640 で `project` の書式の検査を `loadConfig` に足した（Issue の Requirement）。 |
| Q102 | 合体版のレビューへの切り替え | 付き添いのセッションの judge を合体版の組み立ての出力で判定する（`reviewPanel.mode` を `enforce` に）。人の決定（2026-09-30）：今すぐ切り替え、料金の基準 (5) を超えるのを受け入れる。Q91 の集計（組になった PR 52）は「満たす」だったが、しきい値 80 では合体版の不合格が 80 記録で0件だったので、先にしきい値を 75 にし（Q98、#317）、今の reviewer との差を埋め（Q99、#318）、⑨ 過剰さの提案を足した（Q100、#325）。Merge 後の記録の料金は、#321 が合体版 $0.565 / reviewer $0.218（2.60 倍）、#334 が $0.711 / $0.383（1.86 倍）、#335（⑦ opus、⑨なし）が $1.035 / $0.366（2.83 倍）で、⑨の分を足すと約 3.1 倍の見込み。新しい構成（しきい値 75・⑦ opus・⑨）での shadow の記録は1〜2件しかないまま切り替えた。Routine（`.claude/routine.md`）と導入先の雛形（`harness/templates/harness.config.json` の `shadow`）は変えない。`enforce` では合体版が失敗すると判定しないので、⑨の出力の形の誤りでも判定が止まる。起きたら⑨の誤りを組み立てを止めない扱いにする Issue を立てる（#319） |
| Q103 | 合体版のレビューの⑨の扱い（見直し） | 確信度 75 以上の⑨（review-overbuild）の指摘をブロッキングにし、75 未満は今のまま提案（`nonBlocking`）にする。人の決定（2026-09-30。#352）。#386 で入れた：種類は⑨の3つ（`over-implementation`・`over-testing`・`over-engineering`）を判定の `BLOCKING_KINDS` に足した（`out-of-scope` などに寄せると⑥と見分けられず、report の比較と誤検知の数え上げが判定コメントから読めなくなるため。`CRITICAL_BLOCKING` は変えず、修正の上限は通常）。再レビューは①〜⑤と同じく変わった行に当たるものだけをブロッキングにし、ほかは `nonBlocking`。`planLevel` は扱いに関わらず `humanNotes.checkPoints` にも入れる。材料は enforce の記録（2026-09-30T05:25Z 以降、15 PR）の⑨の指摘 52 件、同じ PR・ファイル・内容の重複を除いて 40 件（全件の表は #352 のコメント）。見立ては当たり 13・一部当たり 22・外れ 5。点の帯ごとに、75 以上 2 件（当たり 2）・50〜74 が 33 件（当たり 11）・25〜49 が 5 件（当たり 0）。種類は over-testing 28・over-implementation 10・over-engineering 2。一部当たりの多くは、事実は正しいが計画のテスト方針が明記していたもので、外れ 5 件は事実の誤り 3・AC が求めていたもの 2。Merge 済みの PR の指摘 16 件は main で1件も直されていない。⑨の出力の形の誤りで合体版が失敗した判定は 0 件。表の見立ては付き添いのセッションの担当が各 head のコードと Issue の AC・計画を照らしたもので、人は全件を確かめず、その表を材料として受け入れて扱いを決めた（#352 の AC の「人の見立て」はこの形で満たした）。75 以上は件数が少なく確かではないので、切り替えた後の 20 件ほどで人が誤検知を見る。拾われていない提案（Merge 済みの 16 件）は今は何もしない（残った過剰なテストは、人が test-prune を呼んだときに拾う） |
| Q104 | テストの改ざんの Jev を enforce にする | このリポジトリの `jev.testTamper` を `shadow` から `enforce` にする（人の決定、2026-09-30、#364）。`report.ts` の一致率は読めなかったが、Jev と Claude で妥当かを確かめる仕組み（#349、Epic #339）より先に、`test:exempt` を付ける手間を早く減らす。下限（`jev.thresholds.testTamperProbability` 0.9）・問い・削除系の扱いは変えない。導入先の雛形の既定は `shadow` のまま | 有効 |
| Q106 | 実装のモデルを Jev で振り分ける | `jev.modelRouting`（既定 `shadow`。`off` / `shadow` / `enforce`）。計画ゲートで、App が集めた材料（Issue のタイトルと本文、計画の `files` とその件数・種類、ガードレールに触れるか。計画の本文は渡さない）だけを Jev に問い、実装に勧めるモデル（`opus` / `sonnet`）と確率を `plan-gate` の記録の `modelRouting` に残す（ゲートの結果は変えない）。止まった計画（`agent:plan-review`）も記録する（人の決定、2026-10-01：shadow の材料を多くする）。`enforce` で勧めに従うのはゲートを通った計画だけで、`shadow`・`off`・記録なし・止まった計画は `fleet.implementModel`（今は `sonnet`）のまま。使ったモデルは PR 本文の `実装のモデル:` の行の申告で、`report.ts` の節「実装のモデルの勧めと結果」で人が見るだけ（ゲート・Merge の経路は読まない）。切り替えは人が決め、`harness.config.json` を PR で変える。目安（数えるのはゲートを通過した計画の `modelRouting` が `ok` で、受け付け記録のある Agent PR）：shadow → enforce は、(1) 使ったモデルが `sonnet` の PR が 20 件以上で、勧めが `opus` のものと `sonnet` のものがそれぞれ 5 件以上、かつ (2) 勧めが `opus` で `sonnet` を使った PR の1回で合格の割合が、勧めが `sonnet` で `sonnet` を使った PR より 20 ポイント以上低い、または修正の往復の平均が 0.5 以上多い（Jev が難しい作業を見分けている）。enforce → shadow に戻す目安は、enforce の後の勧め `opus`（opus で実装）の PR の1回で合格の割合が、shadow のときの勧め `opus` × 使った `sonnet` の割合を上回らないとき（人が戻すかを決める）。mutation の survived は PR 側のコードが決める情報なので表に出すだけで基準に使わない。止まった計画の PR も表に出すが基準には数えない（#139） | 有効 |
| Q105 | テストファイルの削除の移し先を Jev に問う | テストファイルの削除を、本文に対応表があれば、移し先の確かめを Jev に問って通す（`jev.testTamper` の `enforce` と下限 `jev.thresholds.testTamperProbability` を使う。Epic #511、#514）。Issue #511 の Requirements は Jev と Claude の両方に問うだったが、App は Claude を呼べず、Claude の判定はセッションの記録で App が本物か見分けられないので（#382）、Jev だけに問う（人の決定、2026-10-09、hq 経由「Jev だけに問う（おすすめ）」） | 有効 |
| Q78 | 人の PR の判定 | 計画のある Issue に紐付いた人の PR も Routine が判定し、判定が出るまで `agent/review` を通さない（自動 Merge はしない、修正は人）。例外は人が付ける `review:exempt` |
| Q77 | 計画の紐付け | すべての PR に計画のある Issue への `Closes` を必須チェック `agent/plan-link` で求める（人のセッションの PR も）。例外は人が付ける `plan:exempt`。Stacked PR の層は本文の `Refs #N`／`Closes #N`（1つだけ）で紐付ける |
| Q76 | 状態ラベルの整理 | `agent:working`・`agent:in-pr` を廃止し、着手宣言コメントと開いた PR から判断する。止めるときは理由コード必須。ラベル定義はコードで一元管理し、文書との一致をテストで検査、定義に無いラベルは `setup.ts` が消す |
| Q75 | 分類ラベル | PR の `size:*`・`area:*` は App が差分から付ける（area は足すだけ）。Issue の種類・領域・優先度・書き方は Jev が提案コメントだけ出す（シャドー） |
| Q74 | 優先度 | `priority:*` の5段階（highest・high・medium・low・lowest）のラベルで queue を並べ替える（優先度 → 先着順）。付いていなければ medium、複数付いていれば最も高いもの。フォームには入れない（Q84 で `priority:high` / `priority:low` の2つから5段階に改めた） |
| Q73 | 汎用化 | 固有名は `harness.config.json` と `setup.ts` の引数に寄せ、別のリポジトリに導入できるようにする |
