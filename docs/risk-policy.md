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

## ガードレール

ガードレールは Agent が自分を縛る仕組み（App が機械的に強制している部分）で、既定ブランチの `harness.config.json` の `guardrailPaths` に並べる（範囲パターンの書式。`guardrailExclude` に当たるものは除く）。一覧自身（`harness.config.json`）は除外できない。一覧が無い設定では、すべてのファイルをガードレールとして扱う。

判定の連鎖もガードレールに入る。判定の入力の作り方（`harness/lib/**` の事実集め・`harness/scripts/agent.ts`）、組み立て（Risk Agent・Reviewer・plan-critic・test-designer の定義）、手順（`.claude/routine.md`、judge・plan の skill）を変える変更は、判定そのものを緩められるので、人が Merge する。判定の材料を作らないもの（使用量の集計、分類ラベル、worktree、Issue の分類、queue、同時実行の上限）は `guardrailExclude` で外す。

- ガードレールに触れる PR は、Risk Agent の答えに関わらず自動 Merge の対象外にする（Human Merge）。App が PR の変更ファイル（リネームは旧パスも）から判定し、理由を受け付けのコメントに書く。
- 計画の `files` がガードレールに触れると、想定 Risk に関わらず計画ゲートで止める。Epic に分ける計画（`split`）では子課題の `files` は見ない。子課題はそれぞれの計画でゲートが判定する。
- ガードレールに触れないハーネスの変更は、ほかの変更と同じく質問1〜8で判定する。

## Jev

`jev.mode` が `shadow` の間は、Actions から Jev に同じ8問を1回で問い、結果を記録するだけにする。Jev に渡すのは App が集めたもの（diff・変更ファイル・ガードレールの一覧）だけで、Risk Agent の `facts` や Claude の判定などセッションが書いたものは渡さない。切り替え（`enforce`）の判断は `harness/scripts/report.ts` の集計で行い、基準は [security.md](security.md#jev) に置く。
