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

## Jev

`jev.mode` が `shadow` の間は、Actions から Jev に同じ8問を1回で問い、結果を記録するだけにする。Jev には同じ8問を、Jev 向けの英文と境界の例（`criteria`）で問う（文は `harness/lib/jev.ts`）。Jev に渡すのは App が集めたもの（diff・変更ファイル・ガードレールの一覧）だけで、Risk Agent の `facts` や Claude の判定などセッションが書いたものは渡さない。切り替え（`enforce`）の判断は `harness/scripts/report.ts` の集計で行い、基準は [security.md](security.md#jev) に置く。
