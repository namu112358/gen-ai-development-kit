# 運用

## Issue の書き方

「Agent タスク」の Issue Form で作り、着手してよければ `agent:ready` を付ける。タイトルは Conventional Commits の形式（`type(scope): 説明`、type は feat / fix / docs / refactor / test / chore / ci / build / perf / style / revert）で、PR とコミットのタイトルにもそのまま使われる。タイトルの形式や見出しが違うとゲートが読めず `agent:blocked` になる。PR のタイトルは必須チェック `agent/title` で検査される。

| 見出し | 必須 | 書くこと |
| --- | --- | --- |
| Goal | ○ | 達成したいこと（1〜3文） |
| Background | | なぜ必要か |
| Requirements | ○ | 満たすべき要件 |
| Non-goals | | やらないこと |
| Acceptance Criteria | ○ | 検証できる受け入れ条件。`- [ ]` で1項目1条件、観測できる形で書く |
| Dependencies | | 補足のみ。順序は Issue Dependencies（blocked by）で設定する |
| Validation Requirements | | 検証方法 |

`agent:ready` を付けると、App が Jev に種類・領域・優先度・AC の書き方を問い、提案をコメントする（ラベルは付けない。`classification.issueTriage`）。Risk と Priority は本文に書かない。急ぐものには `priority:high` を付ける（queue は優先度 → `agent:ready` が付いた順に並ぶ。PR の段階は元の Issue の優先度を引き継ぐ）。大きな機能は親 Issue と Sub-issues に分ける（全部閉じると App が親を閉じる）。計画の段階で Claude が分けることもある（下記「Epic」）。

## 付き添いのセッションで進める

Issue を進めるのは、人が付き添う Claude のセッション。「#番号 を ship して」と頼むと、ship の skill（[.claude/skills/ship/SKILL.md](../.claude/skills/ship/SKILL.md)）が Issue の状態を読み、段階ごとの skill を次の順につなぐ。

| skill | 段階 |
| --- | --- |
| plan | 計画を書き、plan-critic に批評させて投稿する。App の計画ゲートの結果を待つ |
| implement | 計画ゲートを通った計画を実装し、Draft PR を出す |
| judge | Reviewer と Risk Agent に判定させ、判定コメントを投稿する。合格なら App が Ready にする |
| fix | ブロッキング指摘や人のレビューを直し、判定をやり直す |
| sync | main を取り込んで衝突を解消し、判定が引き継がれたかを確かめる |

ship は人の Merge 待ち（App が auto-merge を付けたか、`kind=human-review` のコメントを付けた）か、人の判断待ち（計画ゲートで止まった、修正の上限、判断できない衝突など）で止まり、人がすること（Merge、例外ラベルを付けるかの判断、`setup.ts` の実行が要るか、Merge 後の確かめ）を一覧にする。段階を1つだけ頼めば、その skill だけを行う。

毎時の Routine（[.claude/routine.md](../.claude/routine.md)）が queue に従って同じ段階を進めるのは将来の構想。この文書の「Routine」は、付き添いのセッションで同じ段階を行うときはそのセッションに読み替える。

## ラベル

| ラベル | 付ける者 | 意味 |
| --- | --- | --- |
| `agent:ready` | 人 | 着手してよい |
| `agent:plan-review` | Routine / App | 計画に人の判断が必要。人のセッションで実装する |
| `agent:plan-ok` | App のみ | 計画ゲート通過 |
| `agent:waiting` | Routine / App | 依存待ち（blocker が閉じると App が外す） |
| `agent:blocked` | Routine / App / 人 | 人の対応が必要。付けるときは理由コードを残す（下記） |
| `agent:hold` | 人 | 個別停止 |
| `epic` | App | 子課題に分けた親 Issue。queue は計画・実装の対象にしない。Close しても残る |
| `risk:*` | Routine | 計画時の想定 Risk（表示用） |
| `priority:high` / `priority:low` | 人 | queue で先に・後に処理する（付いていなければ通常。両方付くと App が指摘する） |
| `size:*` | App | PR の差分の行数（XS〜XXL、lockfile は数えない）。push のたびに付け替える |
| `review:exempt` | 人 | 判定を待たずに `agent/review` を通す（人の PR の急ぎ、fork からの PR）。付けた時点の差分にだけ効く（下記「例外ラベルの効く範囲」）。付け外しを App が記録する |
| `plan:exempt` | 人 | 計画のある Issue に紐付かない PR を例外として通す（付け外しを App が記録する） |
| `test:exempt` | 人 | テストを弱める変更を例外として `agent/tests` を通す（Issue 本文にテストを変える理由があるとき）。付けた時点の差分にだけ効く（下記「例外ラベルの効く範囲」）。付け外しを App が記録する |
| `area:*` | App | PR の変更ファイルの領域（`harness.config.json` の `classification.areas`）。足すだけで外さない |

着手中かどうかと PR の有無はラベルにしない。着手宣言コメントと、Issue を `Closes` する開いた PR から App が判断し、ダッシュボードの queue に出す。

止めた理由は、`agent:blocked` / `agent:plan-review` を付けるコメントに理由コード（`<!-- agent-harness:reason code=… -->`）で残す。ダッシュボードの「人の対応待ち」は理由別に並び、理由が無いものは「要確認」になる。

| 理由コード | 意味 |
| --- | --- |
| `form-error` | Issue 本文が Issue Form の書式でない |
| `plan-invalid` | 計画の構造化出力が読めない |
| `needs-decision` | 仕様・設計・AC について人の判断が必要 |
| `high-risk` | 想定 Risk が high 以上 |
| `split-invalid` | Epic の分け方（`split`）が検査に通らない |
| `resplit` | Epic を子課題に分けた後に、別の分け方の計画が来た |
| `split-failed` | Epic の子課題を作る途中で失敗した |
| `fix-limit` | 修正回数の上限に達した |
| `external` | 権限・外部サービス・手作業など Claude の外の対応が必要 |
| `other` | その他（コメントに詳細） |

## Epic（大きな課題を分ける）

1つの PR に収まらない課題は、Claude が計画に `split`（子課題の一覧。書式は [formats.md](formats.md#子課題に分けるsplit)）を書いて Epic にする。分け方は人が承認しない。

1. 計画ゲートが `split` を検査する（タイトルの形式、各子課題の `files` の規則、兄弟どうしの `files` の重なり、依存の順序）。Risk と空の `files` では止めない。通らなければ `agent:plan-review`（理由コード `split-invalid`）。
2. 通ったら App が親に `epic` を付け（`agent:plan-ok` は付けない）、子 Issue を Issue Form の見出しで作り、Sub-issues と依存（blocked by）を登録する。親の停止（`agent:hold`・`agent:blocked`・`agent:waiting`）と、親の開いた blocker（同じリポジトリのもの）は全部の子に引き継ぐ。その後で子に親の `agent:ready` と `priority:*` を付け、最後に `kind=epic-split` の記録を親に残す。
3. 途中で失敗したら、App が親に `agent:blocked`（理由コード `split-failed`）を付け、実行を失敗にする。人が原因を直して `agent:blocked` を外し、失敗した実行をやり直すと続きから作る（本文の目印 `<!-- agent-harness:epic-child parent=N index=i -->` で子 Issue を見つけて使い回し、二重に作らない）。
4. 既に子課題に分けた親（`epic-split` の記録か、App が作った目印付きの子がある）に別の計画が来て検査を通っても、分け直さずに `agent:plan-review`（理由コード `resplit`）で止める。既存の子課題をどうするかは人が決める。同じ計画コメントの再実行は分け直しとみなさない。
5. 子 Issue はふつうの Issue として、それぞれ計画ゲート・批評・判定を通る。分け方の誤りはそこで拾う。queue は `epic` の親を飛ばす。
6. 子 Issue がすべて閉じると、App が親を閉じる。

## 同時に開ける PR の数

同じ領域（`area:*`）の PR が長く開いたまま重なると、1本 Merge されるたびに残りが衝突する。`harness.config.json` の `areaConcurrency`（既定は `{"harness": 3}`）で、領域ごとに同時に開いてよい PR の数を決める。数えるのは同じリポジトリの開いた PR すべて。

- 上限に達した領域に計画の触るファイルが入る Issue は、queue が implement を出さずに skip にする（理由はダッシュボードに出る）。
- 付き添いのセッションの `agent.ts claim <番号> --manual` も同じ条件で止まる。急ぐときは `--force` を付ける。
- 計画・判定・修正の段階は止めない。

## テストの改ざん検査

App は PR の差分（`base...head`）から、テストを弱める変更を必須チェック `agent/tests` で検出する。fork の PR も対象。テストファイルは `harness.config.json` の `testPatterns`（範囲照合と同じパターンの書式）で見分ける。

- 検出するもの：テストファイルの削除とテストファイルでないパスへのリネーム、テスト定義（`test(` / `it(` / `describe(`）の行の削除（同じファイルに同じ名前の定義が足されていれば移動とみなす）、`skip` / `only` / `todo` の追加（`.skip(`、`{ skip: … }`、`xit(` など）、アサーション（`assert` / `expect(`）を含む行の削除・書き換え。
- 検出したら failure で、ファイルと行を一覧にする。テストの追加だけ、テスト以外だけの差分は success。
- failure の概要の先頭には、技術者でなくても分かる説明を置く：何を見張っているか（テストを甘くして通すこと）、なぜ止まったか（テストの行が変わると中身に関わらず止める）、人が確かめること（期待する結果・メッセージ・確認の数が変わっていないか、テストが消えていないか）、通し方（理由を書いて `test:exempt` を付ける。付けたあとに push したら付け直す）。一覧は検出の種類ごとに分け、種類ごとに一言の説明を付ける。
- アサーションの書き換えは、同じ場所の削除と追加が対になるとき（hunk の中の連続する削除と、その直後に続く連続する追加で、移動として相殺した残りの k 番目どうし）、変更前と変更後の行を並べる。対は表示のためだけで、検出の件数や failure の条件は変えない。
- アサーションの行は、整形だけの変更（インデント以外の空白・改行位置・引用符の違いなど）でも検出する。同じ内容の行を同じファイルの中で動かしただけなら数えない。
- 誤検出や、Issue 本文にテストを変える理由がある変更は、人が PR に `test:exempt` を付けて通す（付け外しを App が記録し、外すと検査し直す）。例外は付けた時点の差分にだけ効く（次節）。

## 例外ラベルの効く範囲

`test:exempt`（`agent/tests`）と `review:exempt`（`agent/review`）は、人が付けた時点の PR の差分にだけ効く。人が見ていない後からの変更まで例外で通さないため（判定の引き継ぎと同じく、差分の `git patch-id --verbatim` で比べる）。`plan:exempt` は PR の差分ではなく紐付けの例外なので対象外。

- 付けたとき：App が付け外しの記録（`kind=test-exempt` / `kind=review-exempt`）に、付けた時点の head とその差分の patch-id を残す。ゲートが動くまでに push されていても、イベントに入っている「付けた時点の head」の差分で記録する。
- push したとき：現在の差分の patch-id が記録と同じなら例外は効き続ける。変わっていれば、ラベルが付いたままでも効かない。`agent/tests` は通常どおり検査し、`agent/review` は判定待ち（同じ差分に受け付け済みの判定があればその結果）になり、判定前の PR は Draft に戻る。App が「効いていない」ことをコメントで知らせる（`kind=exempt-stale`。同じ head には1回だけ）。
- 通すには：差分を確認して、ラベルを外して付け直す。その時点の差分で新しい記録ができ、効くようになる。
- 付け外しの記録のうち最新のものが「付けた」で、その patch-id が現在の差分と同じときだけ効く。App 以外が書いた記録は数えない。
- この仕組みの前に付けた例外ラベル（patch-id の記録が無いもの）は効かない。付いたままの PR は、差分を確認して付け直す。

## 人が関わる場面

| 場面 | 操作 |
| --- | --- |
| PR を出すとき（人のセッションを含む） | Issue を立てて計画を投稿し、PR 本文に `Closes #番号` を書く。計画のある Issue に紐付かない PR は必須チェック `agent/plan-link` で止まる |
| `agent:plan-review` の Issue | 人が付き添う Claude のセッションで、人が進めてよいと言えば ship が続きを進める（`node harness/scripts/agent.ts claim <番号> --manual` してから実装し、`claude/` ブランチで同じ書式の PR を出す。Agent PR として判定される）。やめるときは `release <番号>` |
| Agent PR に直してほしい点がある | PR の Review を **Comment として Submit** する（同じ名義の PR には Request changes を付けられない）。最後の push 以降のレビューを fix が修正依頼として扱う |
| Human Merge の依頼 | App のコメント（`kind=human-review`）が付いた PR を確認して Merge する |
| 人が自分で書いた PR（`claude/` 以外のブランチ） | 計画のある Issue に紐付いていれば judge の skill で判定する。判定が出るまで `agent/review` は通らない。ブロッキング指摘は App の変更要求レビューで返るので、人が直す。急ぐときは `review:exempt` |
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

PR に残る実行メトリクスのトークン数と推定料金（`harness.config.json` の `pricing` で計算）はセッションの累計による目安で、実際の請求額ではない。手元では `node harness/scripts/agent.ts usage` で確認できる。

## よくある質問

### Q. 急ぎの Issue を先に進めたいときはどうするか

Issue に `priority:high` を付ける。queue（`node harness/scripts/agent.ts queue`）は優先度 → `agent:ready` が付いた順に並ぶので、先に処理される。PR の段階は元の Issue の優先度を引き継ぐ。

### Q. 自動 Merge を一時的に止めたいときはどうするか

「Agent ダッシュボード」Issue に `agent:auto-merge-stopped` を付ける。App が全 PR の auto-merge を外し、merge-route が自動経路を failure にする（Human Merge は通る）。再開は同じラベルを外すだけ。

### Q. 特定の PR だけ自動 Merge を止めたいときはどうするか

その PR に `agent:hold` を付ける。merge-route が自動経路を failure にし、他の PR には影響しない。再開は同じラベルを外すだけ。
