# Issue 契約

Issue は Claude Code が読む契約です。「Agent タスク」の Issue Form で作ります（`.github/ISSUE_TEMPLATE/agent-task.yml`）。

## 項目

| 見出し | 必須 | 書くこと |
| --- | --- | --- |
| Goal | ○ | 何を達成したいか（1〜3文） |
| Background | | なぜ必要か |
| Requirements | ○ | 満たすべき要件（箇条書き） |
| Non-goals | | やらないこと。範囲外の変更を防ぐ |
| Acceptance Criteria | ○ | 検証可能な受け入れ条件 |
| Dependencies | | 補足のみ（順序は GitHub の Issue Dependencies で設定） |
| Validation Requirements | | 検証方法 |

Risk と Priority は書かない（Risk は Agent が付ける）。見出しを変えるとゲートが読めなくなり、`agent:blocked` になる。

## AC の書き方

- `- [ ]` の箇条書きで、**1項目1条件**。
- 観測できる形で書く：「`foo --bar` を実行すると `baz` が出力される」「`parse('')` が空配列を返す」。
- 「使いやすくする」「きれいにする」のような判定できない表現を避ける。
- 既存の挙動を変えないことが大事なら、それも AC に書く（「既存のテストがすべて通る」）。

## 状態（ラベル）

| ラベル | 付ける者 | 意味 |
| --- | --- | --- |
| `agent:ready` | 人 | 着手してよい |
| `agent:working` | Routine / 人のセッション | 着手宣言 |
| `agent:plan-review` | Routine / App | 人間の判断が必要。人のセッションで実装する |
| `agent:plan-ok` | App のみ | 計画ゲート通過 |
| `agent:in-pr` | Routine | Draft PR 作成済み |
| `agent:waiting` | Routine / App | 依存待ち |
| `agent:blocked` | Routine / App / 人 | 人の対応が必要 |
| `agent:hold` | 人 | 個別停止 |
| `risk:*` | Routine | 計画時の想定 Risk（表示用） |

PR や Checks から分かる状態（レビュー中・CI 中）と DONE（Close）はラベルにしない。

## 大きな機能

Epic を親 Issue にし、Sub-issues に分ける。順序は Issue Dependencies（blocked by）で表す。Sub-issues がすべて閉じると App が親を閉じる。未解決の blocker がある Issue は `agent:waiting` になり、blocker が閉じると App が外す。

## 人の修正依頼

Agent PR への指摘は、PR の **Review（Comment として Submit）** で行う。同じ名義の PR には「Request changes」を付けられないため、最後の push 以降のコラボレーターのレビュー（Comment / Request changes）を修正依頼として扱う。人のレビューによる修正は修正回数に数えない。
