# 運用

## Issue の書き方

「Agent タスク」の Issue Form で作り、着手してよければ `agent:ready` を付ける。見出しを変えるとゲートが読めず `agent:blocked` になる。

| 見出し | 必須 | 書くこと |
| --- | --- | --- |
| Goal | ○ | 達成したいこと（1〜3文） |
| Background | | なぜ必要か |
| Requirements | ○ | 満たすべき要件 |
| Non-goals | | やらないこと |
| Acceptance Criteria | ○ | 検証できる受け入れ条件。`- [ ]` で1項目1条件、観測できる形で書く |
| Dependencies | | 補足のみ。順序は Issue Dependencies（blocked by）で設定する |
| Validation Requirements | | 検証方法 |

Risk と Priority は書かない。大きな機能は親 Issue と Sub-issues に分ける（全部閉じると App が親を閉じる）。

## ラベル

| ラベル | 付ける者 | 意味 |
| --- | --- | --- |
| `agent:ready` | 人 | 着手してよい |
| `agent:working` | Routine / 人のセッション | 着手中 |
| `agent:plan-review` | Routine / App | 計画に人の判断が必要。人のセッションで実装する |
| `agent:plan-ok` | App のみ | 計画ゲート通過 |
| `agent:in-pr` | Routine | Draft PR 作成済み |
| `agent:waiting` | Routine / App | 依存待ち（blocker が閉じると App が外す） |
| `agent:blocked` | Routine / App / 人 | 人の対応が必要 |
| `agent:hold` | 人 | 個別停止 |
| `risk:*` | Routine | 計画時の想定 Risk（表示用） |

## 人が関わる場面

| 場面 | 操作 |
| --- | --- |
| `agent:plan-review` の Issue | 手元のセッションで `node harness/scripts/agent.ts claim <番号> --manual` してから実装し、同じ書式で PR を出す |
| Agent PR に直してほしい点がある | PR の Review を **Comment として Submit** する（同じ名義の PR には Request changes を付けられない）。最後の push 以降のレビューを Routine が修正依頼として扱う |
| Human Merge の依頼 | App のコメント（`kind=human-review`）が付いた PR を確認して Merge する |
| `agent:blocked` | 理由のコメントを読み、直してからラベルを外す |

## 止める仕組み

| 仕組み | 操作 | 効き方 |
| --- | --- | --- |
| 停止スイッチ | 「Agent ダッシュボード」Issue に `agent:auto-merge-stopped` を付ける | App が全 PR の auto-merge を外し、merge-route が自動経路を failure にする。Human Merge は通る |
| 最終手段 | Settings → General → Allow auto-merge を切る | auto-merge が一斉に効かなくなる |
| 個別停止 | Issue / PR に `agent:hold` を付ける | PR は merge-route が failure、Issue は Routine が処理しない。外されると App が記録する |
| revert で自動停止 | 自動 Merge された PR を revert する | App が停止スイッチを入れる。人が確認して外すまで再開しない |
| Routine の停止 | Routine を無効化する | Claude が動かなくなる（ゲートは動く） |

暴走したときは、Routine を無効化 → 停止スイッチ → 開いている Agent PR に `agent:hold` か Close → 誤って入った変更を revert、の順に止める。再開は停止ラベルを外すだけ。

## 困ったとき

| 状態 | 見え方 | 対処 |
| --- | --- | --- |
| Issue 本文が読めない | `agent:blocked`＋App の `form-error` | 本文を Issue Form の見出しに直してラベルを外す |
| 修正回数の上限 | PR に `agent:blocked` | 指摘を確認して人が直すか Close |
| 判定が古い | App の `verdict-rejected` | 何もしない（次の実行で判定し直す） |
| コンフリクト・停滞 | ダッシュボードの各一覧 | 人が解消する |
| ゲートの失敗 | Actions の失敗 | ログを確認。`gate` の手動実行でダッシュボードと queue を更新できる |

判定の集計（Jev の切り替え判断用）は `node harness/scripts/report.ts <owner>/<repo> [日数]`。
