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

## 委任 Merge

人が期限つきで Merge の判断を App に委ねる。ダッシュボード Issue に `agent:delegate-merge` を人が付けると、`delegateMerge.hours`（既定2時間）の間、ガードレールや Risk を理由に Human Merge になる Agent PR も、ほかの条件を満たせば自動 Merge する。

- 有効な条件：ダッシュボードにラベルがあり、人が付けていて（App・Bot が付けたものは無効）、付けてから `delegateMerge.hours` 以内。停止スイッチ（`agent:auto-merge-stopped`）が優先する。
- 飛ばす理由は2つだけ：ガードレールに触れること、Risk が `low` でない・8問のどれかが安全側でないこと。
- 今のまま必須の条件：既存 CI、`agent/review` の合格、範囲照合（ゲートを通った計画か、ゲートの停止で止まった計画と照らす）、`agent:hold` なし、base が既定ブランチ、`agent/tests`（委任で乗る PR ではテストの改ざんの検出で止める）、`jev.mode` が `enforce` のときの Jev。
- 中核は委ねない：`delegateMergeExclude` に当たるファイル（`harness.config.json` は常に）に触れる PR は、委任の間も人が Merge する。
- 期限までの残りが `delegateMerge.minRemainingMinutes`（既定30分）未満なら、新しく auto-merge を付けない。
- 委任で auto-merge を付けたときは PR に App の記録（`delegated-merge`）を残す。ラベルを外す・期限が切れる（定期実行がラベルを外す）・停止スイッチを入れると、委任で付けた auto-merge を外し、記録（`delegated-merge-end`）と人へのレビュー依頼を出す。merge-route は書くたびに今の委任の状態で評価するので、委任が終わった後に書かれた merge-route は委任を理由に通さない。
- 期限の限り：期限の前に付けた auto-merge は、次のゲートの起動（PR・Issue のイベントか定期実行）までは外れない。[security.md](security.md#受け入れているリスク) の「委任 Merge の期限切れの後の窓」。

ダッシュボードには委任の状態（期限・付けた人）と、直近 `staleHours` 時間に委任で Merge された PR の一覧が出る。

## ガードレール

ガードレールは Agent が自分を縛る仕組み（App が機械的に強制している部分）で、既定ブランチの `harness.config.json` の `guardrailPaths` に並べる（範囲パターンの書式。`guardrailExclude` に当たるものは除く）。一覧自身（`harness.config.json`）は除外できない。一覧が無い設定では、すべてのファイルをガードレールとして扱う。

判定の連鎖もガードレールに入る。判定の入力の作り方（`harness/lib/**` の事実集め・`harness/scripts/agent.ts`）、組み立て（Risk Agent・Reviewer・plan-critic・test-designer の定義）、手順（`.claude/routine.md`、`CLAUDE.md` とそれが読み込む `harness/CLAUDE.harness.md`、judge・plan・sync・fix・ship の skill）、Jev の切り替えの集計（`harness/scripts/report.ts`）を変える変更は、判定そのものを緩められるので、人が Merge する。判定の材料を作らないもの（使用量の集計、分類ラベル、worktree、Issue の分類、同時実行の上限）は `guardrailExclude` で外す。queue も外す：次にやることを決めるだけで、Merge の条件は App が確かめる（判定は `agent/review` と patch-id、範囲は計画ゲートを通った計画、修正回数は App が数える）。

- ガードレールに触れる PR は、Risk Agent の答えに関わらず自動 Merge の対象外にする（Human Merge）。App が PR の変更ファイル（リネームは旧パスも）から判定し、理由を受け付けのコメントに書く。
- 計画の `files` がガードレールに触れると、想定 Risk に関わらず計画ゲートで止める。Epic に分ける計画（`split`）では子課題の `files` は見ない。子課題はそれぞれの計画でゲートが判定する。
- ガードレールに触れないハーネスの変更は、ほかの変更と同じく質問1〜8で判定する。

## Jev

`jev.mode` が `shadow` の間は、Actions から Jev に同じ8問を1回で問い、結果を記録するだけにする。Jev には同じ8問を、Jev 向けの英文と境界の例（`criteria`）で問う（文は `harness/lib/jev.ts`）。Jev に渡すのは App が集めたもの（diff・変更ファイル・ガードレールの一覧）だけで、Risk Agent の `facts` や Claude の判定などセッションが書いたものは渡さない。切り替え（`enforce`）の判断は `harness/scripts/report.ts` の集計で行い、基準は [security.md](security.md#jev) に置く。
