# 運用

運用：Issue の書き方、ラベル、人が関わる場面、止める仕組み、困ったときの対応。

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

`agent:ready` を付けたときに App が Jev に種類・領域・優先度・AC の書き方を問うかは、`harness.config.json` の `classification.issueTriage` で決める。`off` は問わない。`shadow` は提案をコメントするだけでラベルは付けない。`label` は提案のコメントを続け、そのうえで足りない `priority:*` と（計画が無ければ）`area:*` を Jev の答えから付ける（下記「足りないラベルを付ける」）。Risk と Priority は本文に書かない。優先度は `priority:*` の5段階（highest・high・medium・low・lowest）で、急ぐものには `priority:high` か `priority:highest` を付ける（queue は優先度 → `agent:ready` が付いた順に並ぶ。付いていなければ medium、複数付いていれば最も高いものとして扱う。PR の段階は元の Issue の優先度を引き継ぐ）。大きな機能は親 Issue と Sub-issues に分ける（全部閉じると App が親を閉じる）。計画の段階で Claude が分けることもある（下記「Epic」）。

## 付き添いのセッションで進める

Issue を進めるのは、人が付き添う Claude のセッション。「#番号 を ship して」と頼むと、ship の skill（[.claude/skills/ship/SKILL.md](../.claude/skills/ship/SKILL.md)）が Issue の状態を読み、段階ごとの skill を次の順につなぐ。

| skill | 段階 |
| --- | --- |
| plan | 計画を書き、plan-critic に批評させて投稿する。App の計画ゲートの結果を待つ |
| implement | 計画ゲートを通った計画を実装し、Draft PR を出す |
| judge | Reviewer と Risk Agent に判定させ、判定コメントを投稿する。合格なら App が Ready にする |
| fix | ブロッキング指摘や人のレビューを直し、判定をやり直す |
| sync | main を取り込んで衝突を解消し、判定が引き継がれたかを確かめる |

ship は人の Merge 待ち（App が auto-merge を付けたか、`kind=human-review` のコメントを付けた）か、人の判断待ち（計画ゲートで止まった、修正の上限、判断できない衝突など）で止まり、人がすること（Merge、例外ラベルを付けるかの判断（`test:exempt` は自動 Merge の対象の PR で `agent/tests` が止まったときだけ。Human Merge の PR では依頼のコメントのテストの変更を Merge の前に確かめる）、`setup.ts` の実行が要るか、Merge 後の確かめ）を一覧にする。段階を1つだけ頼めば、その skill だけを行う。

段階を始める前に、`node harness/scripts/agent.ts claim <番号> --manual --stage <段階>` で着手宣言を出し、段階が変わるたびに更新する（計画は `--stage plan`、批評は `--stage plan-critique`、実装は `--stage implement`、判定・修正・main の取り込みは PR 番号で `--stage judge`・`--stage fix`・`--stage sync`。`post-plan` は投稿の後に `plan-gate` の宣言を出し直す）。人の判断待ちで止めてセッションを終えるときは `release <番号>`。ほかのセッションの着手宣言があれば `claim` は止まり、引き継ぐのは人が決めたときだけ `--takeover` を付ける。`critic-input`・`post-plan`・`worktree` は、このセッションの着手宣言が無いと止まる。ローカルのセッションを複数動かすときは、段階を始める前に着手宣言を確かめ、セッション間でやり取りできる手段（`ListAgents`・`SendMessage` など）があれば、ほかのセッションと話して担当を決める。

複数の Issue をまとめて進めるときは fleet の skill（[.claude/skills/fleet/SKILL.md](../.claude/skills/fleet/SKILL.md)）を使う。`node harness/scripts/agent.ts fleet-status` で選び（番号を渡さなければ、`agent:ready`・`agent:plan-ok`・`agent:plan-review` の Issue と、`agent:*` の無い、コラボレーターか App（Epic の子課題など）が立てた Issue（作ったまま計画に進んでいないもの。次にやることは plan）が対象。衝突しない範囲で本数を制限しない。PR が無い段階は触るファイルの重なりで、両方に PR がある組は `git merge-tree` で試して衝突すれば後の側が待つ。本数を絞るときだけ `--max`）、ship の段階を Issue ごとに交互に進めて、人がすることを1つの一覧にする。

いま動いているエージェントの様子は、手元のダッシュボード（[harness/scripts/dashboard/README.md](../harness/scripts/dashboard/README.md)）で見られる。`node harness/scripts/dashboard.ts` を実行して表示された URL を開くと、どの Issue / PR がどの段階にいるか（着手宣言の段階を優先し、無ければ fleet-status と同じ判断）、依存・Epic・Closes・Stacked PR・担当のセッションの関係、手元のセッションで動いているサブエージェントが1画面に出る。読み取りだけで、GitHub には書かない。

毎時の Routine（[.claude/routine.md](../.claude/routine.md)）が queue に従って同じ段階を進めるのは将来の構想。この文書の「Routine」は、付き添いのセッションで同じ段階を行うときはそのセッションに読み替える。

## ラベル

| ラベル | 付ける者 | 意味 |
| --- | --- | --- |
| `agent:ready` | 人 | 着手してよい |
| `agent:plan-review` | App（計画ゲート）/ Planner（申告のとき） | 計画に人の判断が必要。付き添いのセッションで実装する。外せるのは人と、App（ゲートの停止で、出し直した計画が通ったとき） |
| `agent:plan-ok` | App のみ | 計画ゲート通過 |
| `agent:waiting` | Routine / App | 依存待ち（blocker が閉じると App が外す） |
| `agent:blocked` | Routine / App / 人 | 人の対応が必要。付けるときは理由コードを残す（下記） |
| `agent:hold` | 人 | 個別停止 |
| `epic` | App | 子課題に分けた親 Issue。queue は計画・実装の対象にしない。Close しても残る |
| `risk:*` | Routine（Issue） / App（PR） | Issue：計画時の想定 Risk（表示用）。PR：App が受け付けた判定の Risk（判定し直せば付け替える） |
| `priority:highest` / `priority:high` / `priority:medium` / `priority:low` / `priority:lowest` | 人 / App | queue の優先度（高い順）。付いていなければ medium、複数付いていれば最も高いものとして扱う。2つ以上付いたら App が指摘する |
| `type:*` | 人 / App | 課題の種類。タイトルの type（feat / fix / docs / refactor / test / chore / ci / build / perf / style / revert）と同じ一覧。`epic` の Issue には付けない |
| `size:*` | App | PR の差分の行数（XS〜XXL、lockfile は数えない）。push のたびに付け替える |
| `review:exempt` | 人 | 判定を待たずに `agent/review` を通す（人の PR の急ぎ、fork からの PR）。付けた時点の差分にだけ効く（下記「例外ラベルの効く範囲」）。付け外しを App が記録する |
| `plan:exempt` | 人 | 計画のある Issue に紐付かない PR を例外として通す（付け外しを App が記録する） |
| `test:exempt` | 人 | テストを弱める変更を例外として `agent/tests` を通す（Issue 本文にテストを変える理由があるとき）。付けた時点の差分にだけ効く（下記「例外ラベルの効く範囲」）。付け外しを App が記録する。自動 Merge の対象の PR で使う（Human Merge の PR では要らない。下記「テストの改ざん検査」） |
| `area:*` | App | PR の変更ファイルの領域、Issue の計画（計画ゲートを通ったもの）の files の領域（`harness.config.json` の `classification.areas`）。計画の無い Issue には Jev が付ける。足すだけで外さない |

着手中かどうかと PR の有無はラベルにしない。着手宣言コメントと、Issue を `Closes` する開いた PR から App が判断し、ダッシュボードの queue に出す。

止めた理由は、`agent:blocked` / `agent:plan-review` を付けるコメントに理由コード（`<!-- agent-harness:reason code=… -->`）で残す。ダッシュボードの「人の対応待ち」は理由別に並び、理由が無いものは「要確認」になる。

計画ゲートで止まった Issue に計画を出し直すとき、App は自分の計画ゲートの記録で前の印の出どころを見る。ゲートの停止（critical・ガードレールなど）で、最後に印を付けたのが App なら、新しい計画だけで判定し、止めた理由が当たらなければ `agent:plan-review` を外して通す。Planner の申告（`needsHuman`・`acChangeProposed`・`openQuestions`）や人が付けた印、出どころの無い古い記録は、人が外すまで止める。ゲートの停止の印は出し直しで外れうるので、計画を出し直しても止めておきたいときは `agent:hold` を付ける。書式は [formats.md](formats.md#計画)。

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

### 必須ラベルの規則

| 対象 | 必須のラベル |
| --- | --- |
| Issue | `type:*`・`area:*`・`priority:*` |
| 子を持つ Issue（Epic） | `epic`・`area:*`・`priority:*`（`type:*` は付けない） |
| PR | `type:*`・`area:*`・`size:*` |

人が付けたラベルは上書きしない（足りないものだけを足す）。

#### 足りないラベルを付ける

`harness/gates/label-apply.ts` が、Issue・PR の作成とタイトルの編集（イベント）と、定期実行で付ける。定期実行は、開いた Issue（ダッシュボードを除く。`agent:ready` の有無は問わない）と Agent PR を見て、ダッシュボードを書き直す前に付ける（「ラベルが足りない Issue・PR」は付けた後の状態を映す）。

- App（決定的に決まるもの）：タイトルの type から `type:*`。子（Sub-issues）を持つ Issue に `epic`。計画ゲートを通った Issue に、計画の files から `area:*`（計画ゲートの通過時にも付ける）。タイトルの形式が違う Issue・PR には `type:*` を付けない（ダッシュボードに出る）。
- `type:*` の付け替え：タイトルと食い違う `type:*` と、Epic の `type:*` は、App が付けたもの（Issue・PR の events API で、そのラベルを最後に付けた actor が App）だけを外して付け直す。人が付けたもの（見分けられないものを含む）は外さず、`label-mismatch` のコメントで知らせる。
- Jev（決まらないもの）：`classification.issueTriage` が `label` のとき、優先度の無い Issue に `priority:*`、計画が無く `area:*` の無い Issue に `area:*` を、Jev の答えの確率が `jev.thresholds.labelProbability` 以上のときだけ付ける。下限未満のもの、下限が未設定のとき（提案のみ）は付けずに `label-triage` のコメントで知らせる。本文が Issue Form として読めない Issue には問わない。同じ Issue には一度だけ問う（`issue-triage` か `label-triage` の記録があれば問い済み）。`agent:ready` が付いたときは提案のコメントを出したうえで足りないものを付ける。1回の定期実行で問う Issue は 5 件まで（残りは次の実行）。
- PR の `risk:*`：App が判定を受け付けたとき、受け付けた判定の Risk を付け、ほかの `risk:*` を外す（判定し直せば付け替える）。判定を受け付けなかったときは変えない。

必須ラベルの検査（`harness/lib/label-rules.ts`）は、足りないラベルと次の違反を返す：優先度（`priority:*`）が2つ以上、子（Sub-issues）を持つのに `epic` が無い、Epic に `type:*` がある、`type:*` がタイトルの type と食い違う（`type:*` が2つ以上を含む）、タイトルが `type(scope): 説明` の形式でない。`epic` が付いた Issue は、子課題を作る途中で子が 0 でも Epic として扱う。`area:*` と `size:*` は `harness.config.json` にある名前だけを数える。

- ダッシュボードの「ラベルが足りない Issue・PR」の節：定期実行のたびに、開いた Issue のうち `agent:*` か `epic` の付いたものと Agent PR を検査し、番号・タイトル・足りないもの・違反を1行ずつ出す（人がまだ整えていない Issue、人や bot の PR は出さない）。
- `node harness/scripts/agent.ts label-audit [番号..]`：同じ検査の一覧を出す。番号を渡せばその Issue・PR だけ、渡さなければダッシュボードと同じ範囲。ship の skill は最後に扱った Issue・PR をこれで確かめ、見つかったものを人がすることの一覧に書く。

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
- 付き添いのセッションの `agent.ts claim <番号> --manual` も同じ条件で止まる。急ぐときは `--force` を付ける。ほかのセッションの着手宣言があるときも止まり、こちらは `--force` では越えない。引き継ぐのは人が決めたときだけで、`--takeover` を付ける。
- 計画・判定・修正の段階は止めない。

## テストの改ざん検査

App は PR の差分（`base...head`）から、テストを弱める変更を必須チェック `agent/tests` で検出する。fork の PR も対象。テストファイルは `harness.config.json` の `testPatterns`（範囲照合と同じパターンの書式）で見分ける。

- 検出するもの：テストファイルの削除とテストファイルでないパスへのリネーム、テスト定義（`test(` / `it(` / `describe(`）の行の削除（同じファイルに同じ名前の定義が足されていれば移動とみなす）、`skip` / `only` / `todo` の追加（`.skip(`、`{ skip: … }`、`xit(` など）、アサーション（`assert` / `expect(`）を含む行の削除・書き換え。
- 検出したら、自動 Merge の対象の PR は failure、Human Merge の PR は neutral で、ファイルと行を一覧にする。テストの追加だけ、テスト以外だけの差分は success。
- 自動 Merge の対象の PR の failure の概要の先頭には、技術者でなくても分かる説明を置く：何を見張っているか（テストを甘くして通すこと）、なぜ止まったか（テストの行が変わると中身に関わらず止める）、人が確かめること（期待する結果・メッセージ・確認の数が変わっていないか、テストが消えていないか）、通し方（理由を書いて `test:exempt` を付ける。付けたあとに push したら付け直す）。一覧は検出の種類ごとに分け、種類ごとに一言の説明を付ける。
- アサーションの書き換えは、同じ場所の削除と追加が対になるとき（hunk の中の連続する削除と、その直後に続く連続する追加で、移動として相殺した残りの k 番目どうし）、変更前と変更後の行を並べる。対は表示のためだけで、検出の件数や failure の条件は変えない。
- アサーションの行は、整形だけの変更（インデント以外の空白・改行位置・引用符の違いなど）でも検出する。同じ内容の行を同じファイルの中で動かしただけなら数えない。
- 人が Merge する PR（Human Merge）では止めずに neutral にし、人の Merge の判断にまとめる（`test:exempt` は要らない）。Human Merge とみなすのは Agent PR で、次のどちらかに当たるとき：
  - 変更ファイル（リネームは旧パスも）がガードレールか `humanMergePaths` に当たる（判定の前から分かる。どの判定でも自動 Merge しない）
  - 現在の差分（patch-id）に対する最新の受け付けの記録が、Reviewer 合格かつ自動 Merge の対象外（critical・Risk の答え・範囲外・Jev の enforce など。App が Human Merge の依頼を出す条件と同じ）
- 書き直すのは、PR の作成・push・`test:exempt` の付け外しと、判定の受け付け（新しい判定、push での引き継ぎ、hold を外したときの付け直し）のとき。受け付けでは Ready 化と auto-merge の設定より前に書くので、判定のやり直しで経路が自動 Merge に変わると、auto-merge を付ける前に failure に戻る。
- neutral の要約には「人の確認が要る変更あり」と Human Merge とみなした理由、平易な説明（何を見張っているか、なぜ止めていないか、人が確かめること）、検出の一覧を載せる。Human Merge の依頼のコメント（`kind=human-review`）にも、懸念点より前に見つけた行を目立つ形で載せる。
- 次のときは緩めず、今までどおり failure（`test:exempt` が要る）：`agent:hold` や自動 Merge モードの停止だけが理由のとき（外すと判定のやり直し無しに自動 Merge に戻るため）、人の PR・fork の PR、PR に auto-merge が付いているとき、Reviewer が不合格の判定だけのとき。
- 誤検出や、Issue 本文にテストを変える理由がある変更は、人が PR に `test:exempt` を付けて通す（付け外しを App が記録し、外すと検査し直す）。自動 Merge の対象の PR で使う（Human Merge の PR では要らない）。例外は付けた時点の差分にだけ効く（次節）。

### 分かっている限界

行の形で見るので、次の変更は検出しない。これらは Reviewer と人のレビューで見る。

- 期待値を変数や定数に移してから変える（assert の行は変わらず、定義の行だけが変わる）。
- fixture・スナップショット・テストデータのファイルの変更（`testPatterns` に当たらない場所のファイルは見ない）。
- 弱い assert の追加（`assert.ok(true)` など。行の追加は検出しない）。
- JS 以外の書き方（`test(` / `it(` / `describe(` / `assert` / `expect(` 以外のテスト定義やアサーション）。

## 例外ラベルの効く範囲

`test:exempt`（`agent/tests`）と `review:exempt`（`agent/review`）は、人が付けた時点の PR の差分にだけ効く。人が見ていない後からの変更まで例外で通さないため（判定の引き継ぎと同じく、差分の `git patch-id --verbatim` で比べる）。`plan:exempt` は PR の差分ではなく紐付けの例外なので対象外。

- 付けたとき：App が付け外しの記録（`kind=test-exempt` / `kind=review-exempt`）に、付けた時点の head とその差分の patch-id を残す。ゲートが動くまでに push されていても、イベントに入っている「付けた時点の head」の差分で記録する。
- push したとき：現在の差分の patch-id が記録と同じなら例外は効き続ける。変わっていれば、ラベルが付いたままでも効かない。`agent/tests` は通常どおり検査し、`agent/review` は判定待ち（同じ差分に受け付け済みの判定があればその結果）になり、判定前の PR は Draft に戻る。App が「効いていない」ことをコメントで知らせる（`kind=exempt-stale`。同じ head には1回だけ）。
- 通すには：差分を確認して、ラベルを外して付け直す。その時点の差分で新しい記録ができ、効くようになる。
- 付け外しの記録のうち最新のものが「付けた」で、その patch-id が現在の差分と同じときだけ効く。App 以外が書いた記録は数えない。
- この仕組みの前に付けた例外ラベル（patch-id の記録が無いもの）は効かない。付いたままの PR は、差分を確認して付け直す。

## 人が Merge するパス（humanMergePaths）

導入先の製品で、Risk の判定に関わらず必ず人が Merge したい場所（認証・マイグレーション・課金など）を決めておく。

- 書き方：`harness.config.json` の `humanMergePaths` に範囲パターン（範囲照合と同じ書式）で並べる。`**/migrations/**` のように最初の階層から `**` も書ける。

  ```json
  "humanMergePaths": ["src/auth/**", "**/migrations/**", "src/billing/**"]
  ```

- 効き方：変更ファイル（リネームは旧パスも）が当たる PR は、Risk が low でも自動 Merge せず、Human Merge の依頼になる。受け付けのコメントに理由（「人が Merge するパスに触れます（humanMergePaths）」）と表の行（「人が Merge するパス」）が出る。計画ゲートには効かない（計画は止めない）。
- ガードレールとの違い：ガードレール（`guardrailPaths`）は Agent が自分を縛る仕組みで、計画ゲートでも止まり、一覧が無ければすべてのファイルが当たる。`humanMergePaths` は導入先の製品を守るためのもので、書かなければ何もしない。
- ゲートは既定ブランチの `harness.config.json` を読む。PR の中で `humanMergePaths` を変えても、その PR の判定には効かない。

## 必須チェック

既定ブランチの Ruleset（`node harness/scripts/setup.ts ruleset` が作る）の必須チェックは2種類ある。

- プロジェクトの CI が出すもの：`harness.config.json` の `projectChecks` に並べる（既定は GitHub Actions の `ci`）。プロジェクトが正しいか（lint・テスト・ビルドなど）は CI が判断し、ゲートは CI を動かさない。
- ハーネスが出すもの：`agent/review`・`merge-route`・`agent/plan-link`・`agent/title`・`agent/tests`（App）。Merge してよいかの判断で、コードに固定していて設定から外せない。

`projectChecks` の書式の誤りはゲートでは検出されず、`setup.ts ruleset` の実行時にエラーになる。変えたら `ruleset` を実行し直す（手順は [setup.md](setup.md)）。

## 人が関わる場面

| 場面 | 操作 |
| --- | --- |
| PR を出すとき（付き添いのセッションの Agent PR も、人の PR も） | Issue を立てて計画を投稿し、PR 本文に `Closes #番号` を書く。計画のある Issue に紐付かない PR は必須チェック `agent/plan-link` で止まる |
| `agent:plan-review` の Issue | 人が付き添う Claude のセッションで、人が進めてよいと言えば ship が続きを進める（`node harness/scripts/agent.ts claim <番号> --manual --stage implement` してから実装し、`claude/` ブランチで同じ書式の PR を出す。Agent PR として判定される）。やめるときは `release <番号>`。ゲートの停止（critical・ガードレールなど）なら、止めた理由を直した計画の出し直しで外れうる |
| ほかのセッションの着手宣言がある（`claim` が止まった） | 宣言の段階とセッションを見て、そのセッションが続けるか、こちらが引き継ぐかを人が決める。引き継ぐと決めたら `claim <番号> --manual --stage <段階> --takeover` |
| Agent PR に直してほしい点がある | PR の Review を **Comment として Submit** する（同じ名義の PR には Request changes を付けられない）。最後の push 以降のレビューを fix が修正依頼として扱う |
| Human Merge の依頼 | App のコメント（`kind=human-review`）が付いた PR を、依頼のコメントにテストの変更（`agent/tests` が neutral のとき）があれば、その行も確かめて確認して Merge する |
| 人の PR（`claude/` 以外のブランチから人が自分で書いた PR） | 計画のある Issue に紐付いていれば judge の skill で判定する。判定が出るまで `agent/review` は通らない。ブロッキング指摘は App の変更要求レビューで返るので、人が直す。急ぐときは `review:exempt` |
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
| ラベルの不足・違反 | ダッシュボードの「ラベルが足りない Issue・PR」、`agent.ts label-audit` | 人が足りないラベルを付け、違反を直す（Epic の `type:*` を外す、優先度を1つにする、タイトルか `type:*` を直す） |
| ゲートの失敗 | Actions の失敗 | ログを確認。`gate` の手動実行でダッシュボードと queue を更新できる |

判定の集計（Jev の切り替え判断用）は `node harness/scripts/report.ts <owner>/<repo> [日数]`。集計のしかたと切り替えの基準は [security.md](security.md#jev) を見る。同じ集計の最後に、合体版のレビューの記録と今の判定を比べる節（「合体版のレビュー（記録だけの期間の比較）」）が出る。その切り替えの基準は [plan.md](plan.md) の決定ログの Q91。

PR に残る実行メトリクスのトークン数と推定料金（`harness.config.json` の `pricing` で計算）はセッションの累計による目安で、実際の請求額ではない。手元では `node harness/scripts/agent.ts usage` で確認できる。

## よくある質問

### Q. 急ぎの Issue を先に進めたいときはどうするか

Issue に `priority:high`（もっと急ぐなら `priority:highest`）を付ける。優先度は highest・high・medium・low・lowest の5段階で、付いていなければ medium、複数付いていれば最も高いものとして扱う。queue（`node harness/scripts/agent.ts queue`）は優先度 → `agent:ready` が付いた順に並ぶので、先に処理される。PR の段階は元の Issue の優先度を引き継ぐ。

### Q. 自動 Merge を一時的に止めたいときはどうするか

「Agent ダッシュボード」Issue に `agent:auto-merge-stopped` を付ける。App が全 PR の auto-merge を外し、merge-route が自動経路を failure にする（Human Merge は通る）。再開は同じラベルを外すだけ。

### Q. 特定の PR だけ自動 Merge を止めたいときはどうするか

その PR に `agent:hold` を付ける。merge-route が自動経路を failure にし、他の PR には影響しない。再開は同じラベルを外すだけ。
