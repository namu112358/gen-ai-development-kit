# Risk ポリシー

自動 Merge は Risk Agent（`.claude/agents/risk-agent.md`）の判定だけで決める。Risk Agent は Issue 本文・PR 説明・コメント・ラベルといった自然言語の主張を読まず、**diff・リポジトリ全体・このポリシー**だけを入力にする。

判断の軸は「壊れたときの影響範囲」と「revert で完全に元に戻るか」の2つ。

## 8問

| # | キー | 質問 | 型 | 安全側（自動 Merge を止めない答え） |
| --- | --- | --- | --- | --- |
| 1 | `level` | Risk レベルはどれか | low / medium / high / critical | `low` |
| 2 | `q2_revertible` | revert すれば完全に元に戻るか | Noul | `yes` |
| 3 | `q3_publicInterface` | 公開インターフェース（API・スキーマ・イベント形式・設定形式）を変えるか | Noul | `no` |
| 4 | `q4_tested` | 挙動を変える変更は、既存または追加されたテストで検証されているか（挙動を変えない変更だけなら yes） | Noul | `yes` |
| 5 | `q5_persistentData` | 永続データの書き込み・削除・移行を伴うか | Noul | `no` |
| 6 | `q6_authBillingSecrets` | 認証・認可・課金・秘密情報に関わるか | Noul | `no` |
| 7 | `q7_dependencies` | 依存関係（パッケージ・lockfile）を追加・更新するか | Noul | `no` |
| 8 | `q8_harnessConfig` | この仕組み自体（`.claude/**`、`CLAUDE.md`、CODEOWNERS、`.github/**`、`harness/**`、`harness.config.json`）に触れるか | Noul | `no` |

Claude 判定期間の Noul は `yes` / `no` / `unsure` の3択。**`unsure` は常に止める答え**。1つでも止める答えがあれば自動 Merge しない。

> 質問4は「挙動を変える変更」に限って聞く。docs・コメント・typo など実行時の挙動を変えない変更だけなら `yes`（テストが無いことを理由に止めない）。挙動を変えるかどうかの判断に迷えば `unsure`（決定ログ Q71、2026-09-27）。

> 質問8の対象に `harness/**` と `harness.config.json` を加えている。ゲートのコードと設定は「この仕組み自体」であり、Merge されると次のイベントから効くため（2026-09-26 実装時の追加。決定ログ Q62）。

## レベルの目安

- **low**（R0+R1）：壊れても利用者のデータ・認証・課金・外部連携に影響せず、revert で完全に戻る。docs、typo、独立した UI、挙動を変えない小さなリファクタ
- **medium**：業務ロジックや API の挙動が変わり得るが、revert で戻る
- **high**：revert しても戻らない影響があり得る、または影響が広い。マイグレーション、データの書き込み・削除、認証、課金、インフラ
- **critical**：この仕組み自体、権限、秘密情報、依存関係

## 自動 Merge の条件

すべて**現在の差分**（patch-id が同じ）に対して有効な判定で：

1. 既存 CI が成功（Ruleset の必須チェック）
2. `agent/review` が合格（ブロッキング指摘なし）
3. Risk が `low` かつ全 Noul が安全側
4. 範囲照合 OK（diff が計画の `files` に収まる）
5. `agent:hold` なし
6. 自動 Merge モードが有効（ダッシュボード Issue に `agent:auto-merge-stopped` ラベルがない）
7. （Jev を `enforce` にした後）Jev が許可

merge-route（必須チェック）が 3〜7 をまとめて検査する。`agent/risk` は Required にせず、常に success で結果をサマリーに書く。PR の大きさに上限は置かない。

## 保護対象

`.github/**`、`.claude/**`、`CLAUDE.md`、CODEOWNERS などの保護対象にも、パスによる決定論的な下限は置かない（Q4・Q50）。質問8の判定に任せる。

ただし副作用として、App に `workflows` 権限を与えていないため、`.github/workflows/**` を変更する PR は App の auto-merge では Merge できない（GitHub が拒否する）。これは意図した下限ではないが、外す理由もないためそのままにしている（[security.md](security.md)）。
