# Risk ポリシー

自動 Merge は Risk Agent（`.claude/agents/risk-agent.md`）の判定だけで決める。Risk Agent は Issue 本文・PR 説明・コメント・ラベルを読まず、**diff・リポジトリ・このポリシー**だけで判断する。判断の軸は「壊れたときの影響範囲」と「revert で完全に元に戻るか」。

## 8問

| # | キー | 質問 | 安全側の答え |
| --- | --- | --- | --- |
| 1 | `level` | Risk レベル（low / medium / high / critical） | `low` |
| 2 | `q2_revertible` | revert すれば完全に元に戻るか | `yes` |
| 3 | `q3_publicInterface` | 公開インターフェース（API・スキーマ・イベント形式・設定形式）を変えるか | `no` |
| 4 | `q4_tested` | 挙動を変える変更は、既存または追加されたテストで検証されているか（挙動を変えない変更だけなら yes） | `yes` |
| 5 | `q5_persistentData` | 永続データの書き込み・削除・移行を伴うか | `no` |
| 6 | `q6_authBillingSecrets` | 認証・認可・課金・秘密情報に関わるか | `no` |
| 7 | `q7_dependencies` | 依存関係（パッケージ・lockfile）を追加・更新するか | `no` |
| 8 | `q8_harnessConfig` | ガードレール（`harness.config.json` の `guardrailPaths`）に触れるか | `no` |

キー名 `q8_harnessConfig` は過去の判定との互換のため残す。

質問2〜8は `yes` / `no` / `unsure` の3択で、`unsure` は常に止める答え。1つでも安全側でなければ自動 Merge しない。確率は記録するだけで判定には使わない。

## レベルの目安

- **low**：壊れても利用者のデータ・認証・課金・外部連携に影響せず、revert で完全に戻る。docs、typo、独立した UI、挙動を変えない小さなリファクタ
- **medium**：業務ロジックや API の挙動が変わり得るが、revert で戻る
- **high**：revert しても戻らない影響があり得る、または影響が広い。マイグレーション、データの書き込み・削除、認証、課金、インフラ
- **critical**：ガードレール、権限、秘密情報、依存関係

## 自動 Merge の条件

すべて現在の差分（patch-id が同じ）に対して有効な判定で：

1. 既存 CI が成功
2. `agent/review` が合格（ブロッキング指摘なし）
3. Risk が `low` かつ全問が安全側
4. 範囲照合 OK（diff が計画の `files` に収まる）
5. `agent:hold` なし
6. 自動 Merge モードが有効（ダッシュボードに `agent:auto-merge-stopped` がない）
7. `jev.mode` が `enforce` のときは Jev も許可
8. base が既定ブランチ（Stacked PR の層は Human Merge。GitHub の auto-merge も従来の Merge API も使えない。[operations.md](operations.md#stacked-pr)）

merge-route（必須チェック）が 3〜7 をまとめて検査する。`agent/risk` は必須にせず、結果をサマリーに書く。PR の大きさに上限は置かない。

## 委任承認

人が計画ゲートの承認と Merge の判断を App に委ねる。ダッシュボード Issue に人だけが付けるラベルで、2段階がある。

| ラベル | 呼び名 | 委ねるもの |
| --- | --- | --- |
| `agent:delegate-plan` | 委任承認（計画） | 計画ゲートの承認だけ |
| `agent:delegate-merge` | 委任承認（計画＋Merge） | 計画ゲートの承認と Merge の判断 |

- 有効な条件：ダッシュボードにラベルがあり、人が付けている（App・Bot が付けたもの、付けた時刻が未来のものは無効）。期限は無く、ラベルが付いている間ずっと有効。停止スイッチ（`agent:auto-merge-stopped`）が優先し、停止スイッチの間は計画の委任も無効。
- ラベルの名前は `harness.config.json` の `delegate`（`planLabel`・`mergeLabel`）。古い `delegateMerge.label` だけの設定は `mergeLabel` として読む（`delegate` が優先）。古い設定の `hours`・`minRemainingMinutes` は読まない。

### 計画の委任

委任承認（どちらのラベルでも）が有効な間、計画ゲートで「ガードレールに触れる」「想定 Risk が high / critical」だけで止まる計画には、App が `agent:plan-ok` を付ける。通過の記録（`plan-gate`）に `delegated` が残り、コメントに飛ばした理由・ラベル・付けた人・付けた時刻を書く。

- 委任でも止まるもの：Planner の申告（`needsHuman`・`acChangeProposed`・`openQuestions`）、`issue` の不一致、`files` の欠落・書式の誤り、`split` の不正、人が付けた `agent:plan-review`、批評の関所（`critique` が無い・計画より前に `plan-critique` の着手宣言が無い。[formats.md](formats.md)）、`delegateMergeExclude` か `harness.config.json` に重なりうる `files`（`harness/**` のような広いパターンも、重なりうれば止まる）。`delegateMergeExclude` が無い設定ではすべて止まる。
- ラベルを付けたとき（計画の委任が有効になったとき）と定期実行で、App のゲートの停止（ガードレール・Risk だけで、印を App が付けた）で止まっている Issue を判定し直し、通れば `agent:plan-ok` にする。Planner の申告・人の印・exclude に当たるもの・批評の関所に当たるもの・計画コメントの本文が変わったものは止まったまま。
- ラベルを外しても、委任で付けた `agent:plan-ok` は外さない。

### Merge の委任

委任承認（計画＋Merge）が有効な間は、ガードレールや Risk を理由に Human Merge になる Agent PR も、ほかの条件を満たせば自動 Merge する。`agent:delegate-plan` だけでは Merge の委任は無効。

- 飛ばす理由は2つだけ：ガードレールに触れること、Risk が `low` でない・8問のどれかが安全側でないこと。
- 今のまま必須の条件：既存 CI、`agent/review` の合格、範囲照合（ゲートを通った計画か、ゲートの停止で止まった計画か、人が進めると決めた計画と照らす。人が進めると決めた計画は、Planner の申告か前の印で止まった計画のうち、付き添いのセッションが人の「進める」を決定の記録（`agent-decision` の `proceed`、`post-decision`）で残し、App が `plan-proceed` の記録（`status: ok`）を付けたもので、その後に計画コメントの本文が変わっていないものだけ。記録が無い・計画を出し直した・本文が変わったときは照合に使わない。[formats.md](formats.md#決定の記録agent-decision)）、`agent:hold` なし、base が既定ブランチ、`agent/tests`（委任で乗る PR ではテストの改ざんの検出で止める）、`jev.mode` が `enforce` のときの Jev。
- 中核は委ねない：`delegateMergeExclude` に当たるファイル（`harness.config.json` は常に）に触れる PR は、委任の間も人が Merge する。
- 委任で auto-merge を付けたときは PR に App の記録（`delegated-merge`）を残す。`agent:delegate-merge` を外す・停止スイッチを入れると、委任で付けた auto-merge を外し、記録（`delegated-merge-end`）と人へのレビュー依頼を出す。merge-route は書くたびに今の委任の状態で評価するので、委任が終わった後に書かれた merge-route は委任を理由に通さない。
- `agent:delegate-plan` を外しても、計画の委任が終わるだけで、PR には何もしない。
- ラベルを外し忘れると委任が続く。[security.md](security.md#受け入れているリスク) の「委任承認の外し忘れ」。

ダッシュボードには委任承認の状態（計画のみ・計画＋Merge・無効と、付けた人）と、直近 `staleHours` 時間に委任で Merge された PR の一覧（節「委任承認で Merge された PR」）が出る。

## bypass モード

人が期限なしで、ブロッキング指摘の無い Agent PR の Merge を App に任せる。ダッシュボード Issue に `agent:bypass-merge`（`harness.config.json` の `bypassMerge.label` で変えられる）を人が付けている間、Human Merge になる Agent PR も、ブロッキング指摘が無く範囲照合と `agent/tests` を通れば自動 Merge する。委任承認とは別のスイッチで（計画ゲートは委ねない）、委任承認（計画＋Merge）が飛ばさない `delegateMergeExclude` も飛ばす。

- 有効な条件：ダッシュボードにラベルがあり、人が付けている（App・Bot が付けたものは無効）。期限は無い。停止スイッチ（`agent:auto-merge-stopped`）が優先する。
- 飛ばす理由：Risk が `low` でない・8問のどれかが安全側でないこと、ガードレールに触れること、`humanMergePaths` に触れること、`delegateMergeExclude`（`harness.config.json` を含む）に触れること、`jev.mode` が `enforce` のときの Jev。
- 今のまま必須の条件：既存 CI、`agent/review` の合格（ブロッキング指摘なし）、範囲照合（委任と同じく、ゲートを通った計画か、ゲートの停止で止まった計画か、人が進めると決めた計画（App の `plan-proceed` の記録がある）と照らす）、`agent/tests`（bypass で乗る PR ではテストの改ざんの検出で止める）、`agent:hold` なし、base が既定ブランチ、自動 Merge モードが有効。
- 順序：自動 Merge の対象 → 委任承認（計画＋Merge） → bypass の順に見て、最初に当たったもので乗せる。bypass は、自動 Merge の対象でも委任でも乗らない PR だけを扱う。委任と bypass が両方有効な間に片方が終わったら、もう片方で乗る PR は auto-merge を外さずに引き継ぐ（前の乗り方の終わりの記録を書き、人へのレビュー依頼は出さない）。
- ハーネス自身の守りも委ねる：ゲート（`harness/gates/**`）・ガードレールの一覧（`harness.config.json`）・hook・deny・workflow を変える Agent PR も、人を通らずに Merge される（持ち主の決定。[security.md](security.md#受け入れているリスク)）。bypass の判断そのもの（`harness/gates/bypass.ts`）は `delegateMergeExclude` の中にあり、委任承認では緩められない。
- bypass で auto-merge を付けたときは PR に App の記録（`bypass-merge`）を残す。ラベルを外す・停止スイッチを入れると、bypass で付けた auto-merge を外し、記録（`bypass-merge-end`）と人へのレビュー依頼を出す（停止スイッチのときも出す）。merge-route は書くたびに今の bypass の状態で評価するので、bypass が終わった後に書かれた merge-route は bypass を理由に通さない。
- 窓：付けた auto-merge は、次のゲートの起動（PR・Issue のイベントか定期実行）までは外れない。

ダッシュボードには bypass の状態（付けた人）と、直近 `staleHours` 時間に bypass で Merge された PR の一覧が出る。

## auto mode

人が期限なしで、計画ゲートの承認と Merge の判断の両方を App に任せ、Jev が危険と答えたものだけを人の判断に保留する（Epic #339）。ダッシュボード Issue に `agent:auto-mode`（`harness.config.json` の `autoMode.label` で変えられる）を人が付けている間、ガードレール・Risk・`delegateMergeExclude` を理由に止まる計画と Agent PR も、ほかの条件を満たし Jev の危険の判定で保留にならなければ App が通す。

- 有効な条件：bypass と同じ。ダッシュボードにラベルがあり、人が付けている（App・Bot が付けたもの、付けた記録が読めないものは無効）。期限は無い。停止スイッチ（`agent:auto-merge-stopped`）が優先する。
- 乗り方の順番：計画ゲートは 通常のゲート → 委任承認（計画の委任）→ auto mode、Merge は 自動 Merge の対象 → 委任承認（計画＋Merge）→ auto mode → bypass。狭いものから順に見て、最初に当たったもので乗せる。委任で通る計画・乗る PR には危険の判定をかけない。auto mode が保留にした PR も、bypass が有効なら bypass が今までどおり乗せる。

### 計画ゲート

- 飛ばす理由：ガードレールに触れること、想定 Risk が high / critical であること、`delegateMergeExclude` か `harness.config.json` に重なりうる `files`（委任では止まるもの）。
- auto mode でも止めるもの：Planner の申告（`needsHuman`・`acChangeProposed`・`openQuestions`）、人が付けた `agent:plan-review`、批評の関所（`critique` が無い・`plan-critique` の着手宣言が無い）、`files` の欠落・書式の誤り、`split` の不正、`issue` の不一致（委任と同じ）。
- 止める理由が飛ばす理由だけのとき、Jev に計画の危険を問い、保留にならなければ `agent:plan-ok` を付ける。通過の記録（`plan-gate`）に `autoMode` が残り、コメントに飛ばした理由・ラベル・付けた人・付けた時刻と Jev の1行を書く（[formats.md](formats.md#app-の記録agent-app)）。
- ラベルを付けたとき（auto mode が有効になったとき）と定期実行で、App のゲートの停止で止まっている計画を判定し直す。委任の判定し直しと同じく、Planner の申告・人の印・批評の関所に当たるもの・計画コメントの本文が変わったものは止まったまま。保留のままの計画と、auto mode の記録の無い古い停止には、保留のコメントを増やさない。
- ラベルを外しても、auto mode で付けた `agent:plan-ok` は外さない。

### Merge

- 飛ばす理由：Risk が `low` でない・8問のどれかが安全側でないこと、ガードレールに触れること、`humanMergePaths` に触れること、`delegateMergeExclude`（`harness.config.json` を含む）に触れること、`jev.mode` が `enforce` のときの Jev の自動 Merge の許可。
- 今のまま必須の条件：Agent の PR、base が既定ブランチ、`agent/review` の合格（ブロッキング指摘なし）、範囲照合（委任・bypass と同じく、ゲートを通った計画か、ゲートの停止で止まった計画か、人が進めると決めた計画（App の `plan-proceed` の記録がある）と照らす）、既存 CI、`agent/tests`（下の「agent/tests の扱い」）、`agent:hold` なし、自動 Merge モードが有効。
- 判定の受け付けで、必須の条件を満たし自動 Merge の対象でない PR にだけ Jev に PR の危険を問い、受け付けの記録（`acceptance`）に `autoMode`（乗せてよいか・乗せない理由・飛ばす理由・Jev の記録）を残す。受け付けは auto mode の今の状態を見ずに書くので、後からラベルを付けても同じ記録で乗れる。merge-route は書くたびに今の auto mode の状態で評価する。
- auto mode で auto-merge を付けたときは PR に App の記録（`auto-mode-merge`）を残す。

### 危険の判定

- 危険の判定は Jev だけに問う（人の決定、[Epic #339 のコメント](https://github.com/namu112358/gen-ai-development-kit/issues/339#issuecomment-5906306309)、#382）。plan-critic・Risk Agent には問わない。セッションが自分の計画・判定に「危険ではない」と書くのは自分で承認を出す形で、App は写しが本物か見分けられないため（[security.md](security.md#受け入れているリスク)）。
- 問い：守り（ゲート・必須チェック・hook・deny・ラベルの権限・Secret の保護）を弱める・外すか、データを戻せない形で壊すか、auto mode が保留にするものを減らすか（Noul の1問。yes が危険）。既定の英文と境界の例（criteria）は `harness/lib/auto-mode.ts` にあり、`harness.config.json` の `autoMode.jev.plan`・`autoMode.jev.pr` で上書きできる。分からなければ yes と答えるよう問う。
- 材料：計画は計画コメントの本文と `files`、PR は App が集めた diff と変更ファイルだけ。Risk Agent の `facts` などセッションが書いたものは渡さない。
- 保留にする条件：安全側の確率（1 − 危険の確率）が `autoMode.jev.dangerSafe`（既定 0.9）未満、記録が無い・確率が読めない、Jev が `skipped`・`error`（diff が `jev.maxDiffChars` を超えるときも `skipped`）。
- Jev の危険の問いは `jev.mode` と独立（`jev.testTamper` と同じ）で、`jev.mode` が `shadow` でも auto mode の間は問う。`JEV_API_KEY` が無いと問わずに `skipped` になるので、いつも保留になる（auto mode は実質、人の判断に戻る）。
- 同じ計画コメントで本文の同じもの（sha256）、同じ patch-id には1回だけ問い、`ok` の記録を使い回す（判定し直し・定期実行のたびに問い直さない）。問いの版（`questionSet`）が変わったら問い直す。
- 問いを変える PR は `harness.config.json` か `harness/lib/auto-mode.ts` に触れ、どちらも `delegateMergeExclude` の中にあるので委任承認では緩められず、auto mode の中でも危険の判定（「auto mode が保留にするものを減らすか」）の対象になる。

### 保留と終わり

- 保留にした計画は、理由（Jev の確率と下限）をコメントに書いて `agent:plan-review` にする。人が進めると決めたら、ほかの停止と同じく決定の記録（`agent-decision` の `proceed`）で残す。
- 保留にした PR は、受け付けの記録の `autoMode.reasons` に理由を残し、Human Merge の依頼（`kind=human-review`）にする。
- 終わり：ラベルを外す・停止スイッチを入れると、auto mode で付けた auto-merge を外し、記録（`auto-mode-merge-end`）と人へのレビュー依頼を出す（停止スイッチのときも出す）。停止スイッチ以外では、委任・bypass で乗り続ける PR は auto-merge を外さずに引き継ぐ（順番は委任 → bypass。前の乗り方の終わりの記録を書き、人へのレビュー依頼は出さない）。今の差分が自動 Merge の対象の PR には何もしない。終わりを取りこぼしても、定期照合が外す。
- 窓：付けた auto-merge は、次のゲートの起動（PR・Issue のイベントか定期実行）までは外れない。
- ラベルを外し忘れると auto mode が続き、中核に触れる変更も人を通らずに Merge されうる。[security.md](security.md#受け入れているリスク) の「auto mode の外し忘れと危険の判定の見落とし」。

ダッシュボードには auto mode の状態（有効・無効と付けた人・無効の理由）と、直近 `staleHours` 時間に auto mode で通した計画・保留にした計画と、Merge した PR・保留にした PR が出る。ダッシュボードの切り替えのコメント（`auto-mode-switch`）に、有効になったか・ならなかった理由が出る。

### agent/tests の扱い

auto mode（Epic #339）の間の `agent/tests` の扱い（Issue #349）。

- auto mode で自動経路に乗る PR（自動 Merge の対象でも委任でも乗らず、auto mode で乗るもの）は、Risk critical・ガードレール・`humanMergePaths` に触れても `agent/tests` を Human Merge の neutral にしない。
- テストを弱める変更（すべての種類）が見つかったら、Issue と計画が求める振る舞いの変更に合った妥当な直しかを Jev に問い、検出ごとの確率の最小値が `jev.thresholds.autoModeTestsProbability` 以上なら `agent/tests` を success にする。Jev が妥当でない、答えが無い・読めない、記録の差分が今の差分と違うときは failure（人に回す）。妥当とみなさない例：Issue・計画に理由が無いのに期待値を緩める、落ちるテストを消す・skip する、確かめる数を減らすだけで置き換えが無い、実装の不具合に合わせて期待値を変える。
- 委任で乗る PR・bypass だけで乗る PR・自動 Merge の対象の PR・Human Merge の PR の扱い（`test:exempt`・Human Merge で neutral・`jev.testTamper`）は変えない。
- この判断（`harness/gates/auto-mode-tests.ts`・`harness/lib/auto-mode-tests.ts`）は `delegateMergeExclude` の中にあり、委任承認では緩められない。手順は [operations.md](operations.md#テストの改ざん検査) の「auto mode の間（Jev が妥当か）」。

## ガードレール

ガードレールは Agent が自分を縛る仕組み（App が機械的に強制している部分）で、既定ブランチの `harness.config.json` の `guardrailPaths` に並べる（範囲パターンの書式。`guardrailExclude` に当たるものは除く）。一覧自身（`harness.config.json`）は除外できない。一覧が無い設定では、すべてのファイルをガードレールとして扱う。

判定の連鎖もガードレールに入る。判定の入力の作り方（`harness/lib/**` の事実集め・`harness/scripts/agent.ts` とそのサブコマンドの `harness/scripts/agent/**`）、組み立て（Risk Agent・Reviewer・plan-critic・test-designer の定義）、手順（`.claude/routine.md`、`CLAUDE.md` とそれが読み込む `harness/CLAUDE.harness.md`、judge・plan・sync・fix・ship の skill）、Jev の切り替えの集計（`harness/scripts/report.ts`）を変える変更は、判定そのものを緩められるので、人が Merge する。判定の材料を作らないもの（使用量の集計、分類ラベル、worktree、Issue の分類、同時実行の上限）は `guardrailExclude` で外す。queue も外す：次にやることを決めるだけで、Merge の条件は App が確かめる（判定は `agent/review` と patch-id、範囲は計画ゲートを通った計画、修正回数は App が数える）。

- ガードレールに触れる PR は、Risk Agent の答えに関わらず自動 Merge の対象外にする（Human Merge）。App が PR の変更ファイル（リネームは旧パスも）から判定し、理由を受け付けのコメントに書く。委任承認（計画＋Merge）の間の例外は[委任承認](#委任承認)。
- 計画の `files` がガードレールに触れると、想定 Risk に関わらず計画ゲートで止める（委任承認の間の例外は[委任承認](#委任承認)）。Epic に分ける計画（`split`）では子課題の `files` は見ない。子課題はそれぞれの計画でゲートが判定する。
- ガードレールに触れないハーネスの変更は、ほかの変更と同じく質問1〜8で判定する。

## 見直しの手順

8問・レベルの目安・自動 Merge の条件を見直すときは、付き添いのセッションで qa-retro の skill（`.claude/skills/qa-retro/SKILL.md`）を動かし、その報告（risk ごとの後追い修正と revert の割合、見落としの例と拾えたはずの問い、不安定なテスト）を根拠にする。

- 報告は人に示すだけで、判定の材料にしない（Reviewer・Risk Agent・Jev に渡さない）。
- しきい値・問いの変更は、報告を見て人が別の Issue で決める（qa-retro の skill の中では変えない）。

### /loop で続けて回す

付き添いのセッションの `/loop` から qa-retro を続けて回し、つながった期間の報告を見直しの根拠にできる（しきい値・問いは変えない）。詳しい手順は [qa-retro の skill の「/loop で回すとき」](../.claude/skills/qa-retro/SKILL.md#loop-で回すとき)、skill によらない共通の規則は [operations.md の「見直しを /loop で回す」](operations.md#見直しを-loop-で回す) に置く。

- 呼び方：`/loop 1d /qa-retro --loop`。間隔の目安は1日〜1週間。
- 1回分の期間：前回の回の終わりから、今の7日前まで（後追いの修正の窓の7日が閉じた PR だけを見る）。初回は14日幅。前回の回の終わりは手元の状態のファイル（`harness/scripts/qa-retro-loop.ts`）に持つので、回ごとの期間は重ならず抜けない。
- 止め方：`/loop` を止める。期間を進める前に止めた回は、次の回が同じ始まりから見直す。
- 下書き：ループの回では Issue にしない。人が「qa-retro の下書きを選ぶ」と頼んだときに、選んだものだけを作る。報告を判定の材料にしないのはループでも同じ。

## Jev

`jev.mode` が `shadow` の間は、Actions から Jev に同じ8問を1回で問い、結果を記録するだけにする。Jev には同じ8問を、Jev 向けの英文と境界の例（`criteria`）で問う（文は `harness/lib/jev.ts`）。Jev に渡すのは App が集めたもの（diff・変更ファイル・ガードレールの一覧）だけで、Risk Agent の `facts` や Claude の判定などセッションが書いたものは渡さない。切り替え（`enforce`）の判断は `harness/scripts/report.ts` の集計で行い、基準は [security.md](security.md#jev) に置く。
