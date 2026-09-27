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

`agent:ready` を付けると、App が Jev に種類・領域・優先度・AC の書き方を問い、提案をコメントする（ラベルは付けない。`classification.issueTriage`）。Risk と Priority は本文に書かない。急ぐものには `priority:high` を付ける（queue は優先度 → `agent:ready` が付いた順に並ぶ。PR の段階は元の Issue の優先度を引き継ぐ）。大きな機能は親 Issue と Sub-issues に分ける（全部閉じると App が親を閉じる）。

## ラベル

| ラベル | 付ける者 | 意味 |
| --- | --- | --- |
| `agent:ready` | 人 | 着手してよい |
| `agent:plan-review` | Routine / App | 計画に人の判断が必要。人のセッションで実装する |
| `agent:plan-ok` | App のみ | 計画ゲート通過 |
| `agent:waiting` | Routine / App | 依存待ち（blocker が閉じると App が外す） |
| `agent:blocked` | Routine / App / 人 | 人の対応が必要。付けるときは理由コードを残す（下記） |
| `agent:hold` | 人 | 個別停止 |
| `risk:*` | Routine | 計画時の想定 Risk（表示用） |
| `priority:high` / `priority:low` | 人 | queue で先に・後に処理する（付いていなければ通常。両方付くと App が指摘する） |
| `size:*` | App | PR の差分の行数（XS〜XXL、lockfile は数えない）。push のたびに付け替える |
| `review:exempt` | 人 | 判定を待たずに `agent/review` を通す（人の PR の急ぎ、fork からの PR）。付け外しを App が記録する |
| `plan:exempt` | 人 | 計画のある Issue に紐付かない PR を例外として通す（付け外しを App が記録する） |
| `area:*` | App | PR の変更ファイルの領域（`harness.config.json` の `classification.areas`）。足すだけで外さない |

着手中かどうかと PR の有無はラベルにしない。着手宣言コメントと、Issue を `Closes` する開いた PR から App が判断し、ダッシュボードの queue に出す。

止めた理由は、`agent:blocked` / `agent:plan-review` を付けるコメントに理由コード（`<!-- agent-harness:reason code=… -->`）で残す。ダッシュボードの「人の対応待ち」は理由別に並び、理由が無いものは「要確認」になる。

| 理由コード | 意味 |
| --- | --- |
| `form-error` | Issue 本文が Issue Form の書式でない |
| `plan-invalid` | 計画の構造化出力が読めない |
| `needs-decision` | 仕様・設計・AC について人の判断が必要 |
| `high-risk` | 想定 Risk が high 以上 |
| `fix-limit` | 修正回数の上限に達した |
| `external` | 権限・外部サービス・手作業など Claude の外の対応が必要 |
| `other` | その他（コメントに詳細） |

## 人が関わる場面

| 場面 | 操作 |
| --- | --- |
| PR を出すとき（人のセッションを含む） | Issue を立てて計画を投稿し、PR 本文に `Closes #番号` を書く。計画のある Issue に紐付かない PR は必須チェック `agent/plan-link` で止まる |
| `agent:plan-review` の Issue | 人が付き添う Claude のセッションで `node harness/scripts/agent.ts claim <番号> --manual` してから実装し、`claude/` ブランチで同じ書式の PR を出す（Agent PR として判定される）。やめるときは `release <番号>` |
| Agent PR に直してほしい点がある | PR の Review を **Comment として Submit** する（同じ名義の PR には Request changes を付けられない）。最後の push 以降のレビューを Routine が修正依頼として扱う |
| Human Merge の依頼 | App のコメント（`kind=human-review`）が付いた PR を確認して Merge する |
| 人が自分で書いた PR（`claude/` 以外のブランチ） | 計画のある Issue に紐付いていれば Routine が判定する。判定が出るまで `agent/review` は通らない。ブロッキング指摘は App の変更要求レビューで返るので、人が直す。急ぐときは `review:exempt` |
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

## よくある質問

### Q. 急ぎの Issue を先に進めたいときはどうするか

Issue に `priority:high` を付ける。queue は優先度 → `agent:ready` が付いた順に並ぶので、次の Routine の実行で先に処理される。PR の段階は元の Issue の優先度を引き継ぐ。

### Q. 自動 Merge を一時的に止めたいときはどうするか

「Agent ダッシュボード」Issue に `agent:auto-merge-stopped` を付ける。App が全 PR の auto-merge を外し、merge-route が自動経路を failure にする（Human Merge は通る）。再開は同じラベルを外すだけ。

### Q. 特定の PR だけ自動 Merge を止めたいときはどうするか

その PR に `agent:hold` を付ける。merge-route が自動経路を failure にし、他の PR には影響しない。再開は同じラベルを外すだけ。
